/**
 * UserQueue Durable Object
 *
 * Provides per-user message queuing with FIFO ordering and alarm-based processing.
 * Sits between the worker router and UserSession DO, serializing requests per-user.
 *
 * DESIGN NOTE: Queue Processing
 * -----------------------------
 * Messages are enqueued and processed one at a time via the alarm() handler.
 * Each alarm dequeues the next entry, forwards it to UserSession, and schedules
 * the next alarm when complete. This guarantees strict FIFO ordering per user.
 *
 * Two delivery modes:
 * - 'callback': Forwards to UserSession /chat with progress_callback_url (webhook)
 * - 'sse': Forwards to UserSession /stream and pipes SSE events to the connected client
 *
 * If no SSE client is connected when processing completes, the response is stored
 * for later retrieval (5-minute TTL).
 */

import { Env } from '../config/types.js';
import {
  EnqueueResponse,
  QueueEntry,
  QueueStatusResponse,
  StoredResponse,
  StoredSSEEvent,
} from '../types/queue.js';
import { createRequestLogger, RequestLogger } from '../utils/logger.js';

const STORED_RESPONSE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SSE_CLIENT_CONNECT_TIMEOUT_MS = 30 * 1000; // 30 seconds

/** Parse and validate enqueue request body, returning a QueueEntry or error string. */
function parseEnqueueBody(body: Record<string, unknown>): QueueEntry | string {
  if (!body.user_id || typeof body.user_id !== 'string') return 'user_id is required';
  if (!body.message || typeof body.message !== 'string') return 'message is required';
  if (!body.org || typeof body.org !== 'string') return 'org is required';

  return {
    message_id: crypto.randomUUID(),
    user_id: body.user_id,
    client_id: (body.client_id as string) ?? 'unknown',
    message: body.message,
    message_type: (body.message_type as 'text' | 'audio') ?? 'text',
    audio_base64: body.audio_base64 as string | undefined,
    audio_format: body.audio_format as string | undefined,
    progress_callback_url: body.progress_callback_url as string | undefined,
    progress_throttle_seconds: body.progress_throttle_seconds as number | undefined,
    progress_mode: body.progress_mode as QueueEntry['progress_mode'],
    message_key: body.message_key as string | undefined,
    org: body.org,
    enqueued_at: Date.now(),
    delivery: (body.delivery as 'callback' | 'sse') ?? 'sse',
    _mcp_servers: body._mcp_servers as QueueEntry['_mcp_servers'],
    _org_config: body._org_config as QueueEntry['_org_config'],
    _org_prompt_overrides: body._org_prompt_overrides as QueueEntry['_org_prompt_overrides'],
  };
}

/** Build a UserSession DO request body from a QueueEntry. */
function buildSessionBody(entry: QueueEntry, includeCallback: boolean): string {
  return JSON.stringify({
    client_id: entry.client_id,
    user_id: entry.user_id,
    message: entry.message,
    message_type: entry.message_type,
    audio_base64: entry.audio_base64,
    audio_format: entry.audio_format,
    ...(includeCallback && {
      progress_callback_url: entry.progress_callback_url,
      progress_throttle_seconds: entry.progress_throttle_seconds,
      progress_mode: entry.progress_mode,
      message_key: entry.message_key,
    }),
    _mcp_servers: entry._mcp_servers,
    _org_config: entry._org_config,
    _org_prompt_overrides: entry._org_prompt_overrides,
  });
}

/** Read an SSE stream body and collect events into a StoredSSEEvent array. */
async function bufferSSEResponse(body: ReadableStream<Uint8Array>): Promise<StoredSSEEvent[]> {
  const events: StoredSSEEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          events.push({ event: 'data', data: line.slice(6) });
        }
      }
    }
    if (buffer.startsWith('data: ')) {
      events.push({ event: 'data', data: buffer.slice(6) });
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

export class UserQueue {
  private state: DurableObjectState;
  private env: Env;

  /** Live SSE writers keyed by message_id */
  private streams: Map<string, WritableStreamDefaultWriter<Uint8Array>> = new Map();

  /** Coordination for alarm waiting on SSE client connect */
  private streamWaiters: Map<string, { resolve: () => void; promise: Promise<void> }> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/enqueue':
        return this.handleEnqueue(request);
      case '/stream':
        return this.handleStream(url);
      case '/status':
        return this.handleStatus();
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    const logger = createRequestLogger(crypto.randomUUID());

    const entry = await this.dequeueNext();
    if (!entry) {
      logger.log('queue_empty_alarm_done');
      return;
    }

    logger.log('queue_processing_start', {
      message_id: entry.message_id,
      delivery: entry.delivery,
      user_id: entry.user_id,
    });

    try {
      if (entry.delivery === 'callback') {
        await this.processWithCallback(entry, logger);
      } else {
        await this.processWithSSE(entry, logger);
      }
      logger.log('queue_processing_complete', { message_id: entry.message_id });
    } catch (error) {
      logger.error('queue_processing_error', error, { message_id: entry.message_id });
      await this.handleProcessingError(entry, error);
    } finally {
      this.streams.delete(entry.message_id);
      this.streamWaiters.delete(entry.message_id);
      await this.scheduleNextAlarm();
    }
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const result = parseEnqueueBody(body);
    if (typeof result === 'string') {
      return Response.json({ error: result }, { status: 400 });
    }

    const position = await this.enqueueEntry(result);

    const response: EnqueueResponse = {
      message_id: result.message_id,
      queue_position: position,
    };
    return Response.json(response, { status: 202 });
  }

  private async handleStream(url: URL): Promise<Response> {
    const messageId = url.searchParams.get('message_id');
    if (!messageId) {
      return Response.json({ error: 'message_id query parameter is required' }, { status: 400 });
    }

    // Check for stored response (late-connect fallback)
    const stored = await this.getAndClearStoredResponse(messageId);
    if (stored) {
      return this.replayStoredResponse(stored);
    }

    return this.createLiveStream(messageId);
  }

  private async handleStatus(): Promise<Response> {
    const queue = (await this.state.storage.get<QueueEntry[]>('queue')) ?? [];
    const processing = (await this.state.storage.get<boolean>('processing')) ?? false;
    const responses =
      (await this.state.storage.get<Record<string, StoredResponse>>('responses')) ?? {};

    const response: QueueStatusResponse = {
      queue_length: queue.length,
      processing,
      stored_response_count: Object.keys(responses).length,
    };
    return Response.json(response);
  }

  /** Atomically dequeue the next entry, or return null if queue is empty. */
  private async dequeueNext(): Promise<QueueEntry | null> {
    return this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<QueueEntry[]>('queue')) ?? [];
      if (queue.length === 0) {
        await this.state.storage.put('processing', false);
        return null;
      }
      const next = queue.shift()!;
      await this.state.storage.put('queue', queue);
      return next;
    });
  }

  /** Atomically append entry to queue and schedule alarm if idle. */
  private async enqueueEntry(entry: QueueEntry): Promise<number> {
    return this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<QueueEntry[]>('queue')) ?? [];
      queue.push(entry);
      await this.state.storage.put('queue', queue);

      const isProcessing = (await this.state.storage.get<boolean>('processing')) ?? false;
      if (!isProcessing) {
        await this.state.storage.put('processing', true);
        this.state.storage.setAlarm(Date.now());
      }
      return queue.length;
    });
  }

  /** Get and remove a stored response, or null if not found. */
  private async getAndClearStoredResponse(messageId: string): Promise<StoredResponse | null> {
    const responses =
      (await this.state.storage.get<Record<string, StoredResponse>>('responses')) ?? {};
    // eslint-disable-next-line security/detect-object-injection -- messageId is from URL param, used as object key
    const stored = responses[messageId];
    if (!stored) return null;

    // eslint-disable-next-line security/detect-object-injection -- messageId is from URL param, used as object key
    delete responses[messageId];
    await this.state.storage.put('responses', responses);
    return stored;
  }

  /** Replay a stored response as an SSE stream. */
  private replayStoredResponse(stored: StoredResponse): Response {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      try {
        for (const sseEvent of stored.events) {
          await writer.write(
            encoder.encode(`event: ${sseEvent.event}\ndata: ${sseEvent.data}\n\n`)
          );
        }
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /** Create a live SSE stream for a message and register the writer. */
  private async createLiveStream(messageId: string): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    this.streams.set(messageId, writer);

    const encoder = new TextEncoder();
    await writer.write(
      encoder.encode(`event: queued\ndata: ${JSON.stringify({ message_id: messageId })}\n\n`)
    );

    const waiter = this.streamWaiters.get(messageId);
    if (waiter) {
      waiter.resolve();
    }

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /** Forward to UserSession DO /chat with webhook callback. */
  private async processWithCallback(entry: QueueEntry, logger: RequestLogger): Promise<void> {
    const stub = this.getUserSessionStub(entry);
    const doRequest = new Request('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildSessionBody(entry, true),
    });

    const response = await stub.fetch(doRequest);
    logger.log('callback_response', { message_id: entry.message_id, status: response.status });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`UserSession returned ${response.status}: ${errorText}`);
    }
  }

  /** Forward to UserSession /stream and pipe SSE events to connected client. */
  private async processWithSSE(entry: QueueEntry, logger: RequestLogger): Promise<void> {
    const writer = await this.waitForSSEClient(entry.message_id, logger);
    const response = await this.fetchUserSessionStream(entry);

    if (writer) {
      await this.pipeSSEToClient(writer, response.body!, entry.message_id);
    } else {
      logger.warn('no_sse_client', { message_id: entry.message_id });
      await this.bufferAndStoreResponse(response.body!, entry.message_id);
    }
  }

  /** Fetch SSE stream from UserSession DO. */
  private async fetchUserSessionStream(entry: QueueEntry): Promise<Response> {
    const stub = this.getUserSessionStub(entry);
    const doRequest = new Request('http://fake-host/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildSessionBody(entry, false),
    });

    const response = await stub.fetch(doRequest);
    if (!response.ok || !response.body) {
      const errorText = response.body ? await response.text() : 'No response body';
      throw new Error(`UserSession stream returned ${response.status}: ${errorText}`);
    }
    return response;
  }

  /** Pipe SSE stream from UserSession to connected client writer. */
  private async pipeSSEToClient(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    body: ReadableStream<Uint8Array>,
    messageId: string
  ): Promise<void> {
    await this.writeSSE(writer, 'processing', JSON.stringify({ message_id: messageId }));

    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } finally {
      reader.releaseLock();
    }

    await this.writeSSE(writer, 'done', JSON.stringify({ message_id: messageId }));
    await writer.close();
  }

  /** Buffer SSE response and store for late-connecting clients. */
  private async bufferAndStoreResponse(
    body: ReadableStream<Uint8Array>,
    messageId: string
  ): Promise<void> {
    const events = await bufferSSEResponse(body);
    events.push({ event: 'done', data: JSON.stringify({ message_id: messageId }) });
    await this.storeResponse(messageId, events);
  }

  /** Get a UserSession DO stub for the given queue entry. */
  private getUserSessionStub(entry: QueueEntry): DurableObjectStub {
    const doId = this.env.USER_SESSION.idFromName(`user:${entry.org}:${entry.user_id}`);
    return this.env.USER_SESSION.get(doId);
  }

  /** Wait up to 30s for an SSE client to connect. Returns writer or null. */
  private async waitForSSEClient(
    messageId: string,
    logger: RequestLogger
  ): Promise<WritableStreamDefaultWriter<Uint8Array> | null> {
    const existing = this.streams.get(messageId);
    if (existing) return existing;

    let resolveWaiter: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
    this.streamWaiters.set(messageId, { resolve: resolveWaiter!, promise });

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), SSE_CLIENT_CONNECT_TIMEOUT_MS);
    });

    const result = await Promise.race([promise.then(() => 'connected' as const), timeoutPromise]);
    this.streamWaiters.delete(messageId);

    if (result === 'timeout') {
      logger.warn('sse_client_connect_timeout', {
        message_id: messageId,
        timeout_ms: SSE_CLIENT_CONNECT_TIMEOUT_MS,
      });
      return null;
    }
    return this.streams.get(messageId) ?? null;
  }

  /** Send error to connected SSE client or store for late retrieval. */
  private async handleProcessingError(entry: QueueEntry, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const writer = this.streams.get(entry.message_id);

    if (writer) {
      try {
        await this.writeSSE(writer, 'error', JSON.stringify({ error: errorMessage }));
        await writer.close();
      } catch {
        // Writer may already be closed
      }
    } else if (entry.delivery !== 'callback') {
      await this.storeResponse(entry.message_id, [
        { event: 'error', data: JSON.stringify({ error: errorMessage }) },
      ]);
    }
  }

  /** Write a named SSE event: `event: <type>\ndata: <data>\n\n` */
  private async writeSSE(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    eventType: string,
    data: string
  ): Promise<void> {
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(`event: ${eventType}\ndata: ${data}\n\n`));
  }

  /** Store response events for late-connecting SSE clients with TTL cleanup. */
  private async storeResponse(messageId: string, events: StoredSSEEvent[]): Promise<void> {
    const responses =
      (await this.state.storage.get<Record<string, StoredResponse>>('responses')) ?? {};

    // Clean up expired entries
    const now = Date.now();
    for (const key of Object.keys(responses)) {
      // eslint-disable-next-line security/detect-object-injection -- key from Object.keys iteration
      const resp = responses[key];
      if (resp && now - resp.stored_at > STORED_RESPONSE_TTL_MS) {
        // eslint-disable-next-line security/detect-object-injection -- key from Object.keys iteration
        delete responses[key];
      }
    }

    // eslint-disable-next-line security/detect-object-injection -- messageId is a UUID from crypto.randomUUID()
    responses[messageId] = { message_id: messageId, events, stored_at: now };
    await this.state.storage.put('responses', responses);
  }

  /** Schedule the next alarm if there are items remaining in the queue. */
  private async scheduleNextAlarm(): Promise<void> {
    const hasMore = await this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<QueueEntry[]>('queue')) ?? [];
      if (queue.length === 0) {
        await this.state.storage.put('processing', false);
        return false;
      }
      return true;
    });

    if (hasMore) {
      this.state.storage.setAlarm(Date.now());
    }
  }
}
