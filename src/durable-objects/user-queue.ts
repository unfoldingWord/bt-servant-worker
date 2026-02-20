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
 * for later retrieval (configurable TTL, default 5 minutes).
 *
 * Transient failures are retried up to MAX_RETRIES times with re-enqueue.
 */

import { DO_BASE_URL } from '../config/constants.js';
import { Env } from '../config/types.js';
import { ProgressMode } from '../types/engine.js';
import {
  EnqueueResponse,
  QueueEntry,
  QueueStatusResponse,
  StoredResponse,
  StoredSSEEvent,
} from '../types/queue.js';
import { createRequestLogger, RequestLogger } from '../utils/logger.js';

// Defaults for configurable values (overridable via env vars)
const DEFAULT_STORED_RESPONSE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SSE_CLIENT_CONNECT_TIMEOUT_MS = 30 * 1000; // 30 seconds
const DEFAULT_MAX_QUEUE_DEPTH = 50;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_BUFFERED_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_CLEANUP_PER_STORE = 10;
const ENQUEUE_RATE_WINDOW_MS = 60 * 1000; // 1 minute
const ENQUEUE_RATE_LIMIT = 300; // max enqueues per window

const VALID_PROGRESS_MODES: ProgressMode[] = ['complete', 'iteration', 'periodic', 'sentence'];

function isValidProgressMode(value: unknown): value is ProgressMode {
  return typeof value === 'string' && VALID_PROGRESS_MODES.includes(value as ProgressMode);
}

/** Validate required fields in enqueue request body. Returns error string or null. */
function validateEnqueueBody(body: Record<string, unknown>): string | null {
  if (!body.user_id || typeof body.user_id !== 'string') return 'user_id is required';
  if (!body.message || typeof body.message !== 'string') return 'message is required';
  if (!body.org || typeof body.org !== 'string') return 'org is required';
  return null;
}

/** Extract optional string/number fields from enqueue body. */
function extractOptionalFields(body: Record<string, unknown>) {
  return {
    audio_base64: typeof body.audio_base64 === 'string' ? body.audio_base64 : undefined,
    audio_format: typeof body.audio_format === 'string' ? body.audio_format : undefined,
    progress_callback_url:
      typeof body.progress_callback_url === 'string' ? body.progress_callback_url : undefined,
    progress_throttle_seconds:
      typeof body.progress_throttle_seconds === 'number'
        ? body.progress_throttle_seconds
        : undefined,
    progress_mode: isValidProgressMode(body.progress_mode) ? body.progress_mode : undefined,
    message_key: typeof body.message_key === 'string' ? body.message_key : undefined,
  };
}

/** Extract and validate injected config fields (_mcp_servers, _org_config, _org_prompt_overrides). */
function extractInjectedConfig(body: Record<string, unknown>) {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  return {
    _mcp_servers: Array.isArray(body._mcp_servers)
      ? (body._mcp_servers as QueueEntry['_mcp_servers'])
      : undefined,
    _org_config: isPlainObject(body._org_config)
      ? (body._org_config as QueueEntry['_org_config'])
      : undefined,
    _org_prompt_overrides: isPlainObject(body._org_prompt_overrides)
      ? (body._org_prompt_overrides as QueueEntry['_org_prompt_overrides'])
      : undefined,
  };
}

/** Parse and validate enqueue request body, returning a QueueEntry or error string. */
function parseEnqueueBody(body: Record<string, unknown>): QueueEntry | string {
  const error = validateEnqueueBody(body);
  if (error) return error;

  return {
    message_id: crypto.randomUUID(),
    user_id: body.user_id as string,
    client_id: typeof body.client_id === 'string' ? body.client_id : 'unknown',
    message: body.message as string,
    message_type: body.message_type === 'audio' ? ('audio' as const) : ('text' as const),
    org: body.org as string,
    enqueued_at: Date.now(),
    delivery: body.delivery === 'callback' ? ('callback' as const) : ('sse' as const),
    retry_count: 0,
    ...extractOptionalFields(body),
    ...extractInjectedConfig(body),
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
async function bufferSSEResponse(
  body: ReadableStream<Uint8Array>,
  maxSize: number
): Promise<StoredSSEEvent[]> {
  const events: StoredSSEEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let totalSize = 0;
  try {
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > maxSize) {
        events.push({ event: 'error', data: JSON.stringify({ error: 'Response too large' }) });
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          events.push({ event: 'data', data: line.slice(6) });
        }
      }
    }
    if (totalSize <= maxSize && buffer.startsWith('data: ')) {
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

  /** Coordination for alarm waiting for SSE client to connect */
  private streamWaiters: Map<string, { resolve: () => void; promise: Promise<void> }> = new Map();

  /** Sliding window timestamps for enqueue rate limiting */
  private enqueueTimestamps: number[] = [];

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

    try {
      const entry = await this.dequeueNext();
      if (!entry) {
        logger.log('queue_empty_alarm_done');
        return;
      }

      const startTime = Date.now();
      logger.log('queue_processing_start', {
        message_id: entry.message_id,
        delivery: entry.delivery,
        user_id: entry.user_id,
        org: entry.org,
        retry_count: entry.retry_count,
        queue_wait_ms: startTime - entry.enqueued_at,
      });

      try {
        if (entry.delivery === 'callback') {
          await this.processWithCallback(entry, logger);
        } else {
          await this.processWithSSE(entry, logger);
        }
        logger.log('queue_processing_complete', {
          message_id: entry.message_id,
          user_id: entry.user_id,
          processing_ms: Date.now() - startTime,
        });
      } catch (error) {
        logger.error('queue_processing_error', error, {
          message_id: entry.message_id,
          user_id: entry.user_id,
          org: entry.org,
          retry_count: entry.retry_count,
          processing_ms: Date.now() - startTime,
        });
        await this.handleProcessingError(entry, error, logger);
      } finally {
        this.streams.delete(entry.message_id);
        this.streamWaiters.delete(entry.message_id);
      }
    } catch (error) {
      logger.error('alarm_fatal_error', error);
      // Reset processing flag to prevent permanent deadlock
      await this.state.storage.put('processing', false);
    }

    await this.scheduleNextAlarm();
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

    // Rate limiting: sliding window per DO instance
    const now = Date.now();
    this.enqueueTimestamps = this.enqueueTimestamps.filter((t) => now - t < ENQUEUE_RATE_WINDOW_MS);
    if (this.enqueueTimestamps.length >= ENQUEUE_RATE_LIMIT) {
      return Response.json(
        { error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': '10' } }
      );
    }
    this.enqueueTimestamps.push(now);

    const maxDepth = this.getMaxQueueDepth();
    const position = await this.enqueueEntry(result, maxDepth);

    if (position === -1) {
      return Response.json(
        {
          error: 'Queue full',
          code: 'QUEUE_DEPTH_EXCEEDED',
          message: `Queue depth limit (${maxDepth}) exceeded. Please retry later.`,
        },
        { status: 429, headers: { 'Retry-After': '5' } }
      );
    }

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

  /** Atomically append entry to queue and schedule alarm if idle. Returns -1 if full. */
  private async enqueueEntry(entry: QueueEntry, maxDepth: number): Promise<number> {
    return this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<QueueEntry[]>('queue')) ?? [];

      if (queue.length >= maxDepth) {
        return -1;
      }

      queue.push(entry);
      await this.state.storage.put('queue', queue);

      const isProcessing = (await this.state.storage.get<boolean>('processing')) ?? false;
      if (!isProcessing) {
        await this.state.storage.put('processing', true);
        await this.state.storage.setAlarm(Date.now());
      }
      return queue.length;
    });
  }

  /** Get and remove a stored response, cleaning up expired entries opportunistically. */
  private async getAndClearStoredResponse(messageId: string): Promise<StoredResponse | null> {
    const responses =
      (await this.state.storage.get<Record<string, StoredResponse>>('responses')) ?? {};

    // Opportunistic cleanup of expired entries on read
    const now = Date.now();
    const ttl = this.getStoredResponseTTL();
    for (const key of Object.keys(responses)) {
      // eslint-disable-next-line security/detect-object-injection -- key from Object.keys iteration
      const resp = responses[key];
      if (resp && now - resp.stored_at > ttl) {
        // eslint-disable-next-line security/detect-object-injection -- key from Object.keys iteration
        delete responses[key];
      }
    }

    // eslint-disable-next-line security/detect-object-injection -- messageId is from URL param, used as object key
    const stored = responses[messageId];
    if (!stored) {
      await this.state.storage.put('responses', responses);
      return null;
    }

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
    const doRequest = new Request(`${DO_BASE_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildSessionBody(entry, true),
    });

    const response = await stub.fetch(doRequest);
    logger.log('callback_response', {
      message_id: entry.message_id,
      user_id: entry.user_id,
      status: response.status,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `UserSession returned ${response.status} for user=${entry.user_id} msg=${entry.message_id} org=${entry.org}: ${errorText}`
      );
    }
  }

  /** Forward to UserSession /stream and pipe SSE events to connected client. */
  private async processWithSSE(entry: QueueEntry, logger: RequestLogger): Promise<void> {
    const writer = await this.waitForSSEClient(entry.message_id, logger);
    const response = await this.fetchUserSessionStream(entry);

    if (writer) {
      await this.pipeSSEToClient(writer, response.body!, entry.message_id);
    } else {
      logger.warn('no_sse_client', {
        message_id: entry.message_id,
        user_id: entry.user_id,
        org: entry.org,
      });
      await this.bufferAndStoreResponse(response.body!, entry.message_id);
    }
  }

  /** Fetch SSE stream from UserSession DO. */
  private async fetchUserSessionStream(entry: QueueEntry): Promise<Response> {
    const stub = this.getUserSessionStub(entry);
    const doRequest = new Request(`${DO_BASE_URL}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildSessionBody(entry, false),
    });

    const response = await stub.fetch(doRequest);
    if (!response.ok || !response.body) {
      const errorText = response.body ? await response.text() : 'No response body';
      throw new Error(
        `UserSession stream returned ${response.status} for user=${entry.user_id} msg=${entry.message_id} org=${entry.org}: ${errorText}`
      );
    }
    return response;
  }

  /** Pipe SSE stream from UserSession to connected client writer. */
  private async pipeSSEToClient(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    body: ReadableStream<Uint8Array>,
    messageId: string
  ): Promise<void> {
    try {
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
    } catch (error) {
      // Client may have disconnected — log but don't propagate
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('WritableStream') || msg.includes('closed')) {
        return; // Client disconnect — not an error
      }
      throw error;
    } finally {
      try {
        await writer.close();
      } catch {
        // Writer may already be closed from client disconnect
      }
    }
  }

  /** Buffer SSE response and store for late-connecting clients. */
  private async bufferAndStoreResponse(
    body: ReadableStream<Uint8Array>,
    messageId: string
  ): Promise<void> {
    const events = await bufferSSEResponse(body, DEFAULT_MAX_BUFFERED_RESPONSE_SIZE);
    events.push({ event: 'done', data: JSON.stringify({ message_id: messageId }) });
    await this.storeResponse(messageId, events);
  }

  /** Get a UserSession DO stub for the given queue entry. */
  private getUserSessionStub(entry: QueueEntry): DurableObjectStub {
    const doId = this.env.USER_SESSION.idFromName(`user:${entry.org}:${entry.user_id}`);
    return this.env.USER_SESSION.get(doId);
  }

  /** Wait for an SSE client to connect within the configured timeout. Returns writer or null. */
  private async waitForSSEClient(
    messageId: string,
    logger: RequestLogger
  ): Promise<WritableStreamDefaultWriter<Uint8Array> | null> {
    const existing = this.streams.get(messageId);
    if (existing) return existing;

    const timeout = this.getSSEConnectTimeout();
    let resolveWaiter: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
    this.streamWaiters.set(messageId, { resolve: resolveWaiter!, promise });

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeout);
    });

    const result = await Promise.race([promise.then(() => 'connected' as const), timeoutPromise]);
    this.streamWaiters.delete(messageId);

    if (result === 'timeout') {
      logger.warn('sse_client_connect_timeout', {
        message_id: messageId,
        timeout_ms: timeout,
      });
      return null;
    }
    return this.streams.get(messageId) ?? null;
  }

  /**
   * Handle errors during queue processing.
   * For transient failures (5xx from UserSession), re-enqueue with retry counter.
   * For permanent failures, send error to SSE client or store for late retrieval.
   */
  private async handleProcessingError(
    entry: QueueEntry,
    error: unknown,
    logger: RequestLogger
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const maxRetries = this.getMaxRetries();

    // Retry on transient failures (not validation errors)
    if (this.isTransientError(errorMessage) && entry.retry_count < maxRetries) {
      logger.warn('queue_entry_retry', {
        message_id: entry.message_id,
        user_id: entry.user_id,
        retry_count: entry.retry_count + 1,
        max_retries: maxRetries,
      });
      await this.reEnqueue({ ...entry, retry_count: entry.retry_count + 1 });
      return;
    }

    // Permanent failure — notify client
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

  /** Check if an error message indicates a transient (retryable) failure. */
  private isTransientError(errorMessage: string): boolean {
    return (
      /returned 5\d{2}/.test(errorMessage) || // 5xx from UserSession
      errorMessage.includes('Network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('ECONNREFUSED')
    );
  }

  /** Re-enqueue a failed entry at the front of the queue for retry. */
  private async reEnqueue(entry: QueueEntry): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<QueueEntry[]>('queue')) ?? [];
      queue.unshift(entry); // Add to front for priority retry
      await this.state.storage.put('queue', queue);
    });
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

    // Clean up expired entries (bounded to avoid unbounded loops)
    const now = Date.now();
    const ttl = this.getStoredResponseTTL();
    let cleaned = 0;
    for (const key of Object.keys(responses)) {
      if (cleaned >= MAX_CLEANUP_PER_STORE) break;
      // eslint-disable-next-line security/detect-object-injection -- key from Object.keys iteration
      const resp = responses[key];
      if (resp && now - resp.stored_at > ttl) {
        // eslint-disable-next-line security/detect-object-injection -- key from Object.keys iteration
        delete responses[key];
        cleaned++;
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
      await this.state.storage.setAlarm(Date.now());
    }
  }

  // ── Config helpers (read from env with defaults) ──

  private getMaxQueueDepth(): number {
    return parseInt(this.env.MAX_QUEUE_DEPTH ?? '', 10) || DEFAULT_MAX_QUEUE_DEPTH;
  }

  private getStoredResponseTTL(): number {
    return (
      parseInt(this.env.QUEUE_STORED_RESPONSE_TTL_MS ?? '', 10) || DEFAULT_STORED_RESPONSE_TTL_MS
    );
  }

  private getSSEConnectTimeout(): number {
    return (
      parseInt(this.env.QUEUE_SSE_CONNECT_TIMEOUT_MS ?? '', 10) ||
      DEFAULT_SSE_CLIENT_CONNECT_TIMEOUT_MS
    );
  }

  private getMaxRetries(): number {
    return parseInt(this.env.QUEUE_MAX_RETRIES ?? '', 10) || DEFAULT_MAX_RETRIES;
  }
}
