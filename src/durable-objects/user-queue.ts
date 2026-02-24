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
  EventStoreMetadata,
  PollResponse,
  QueueEntry,
  QueueStatusResponse,
  StoredResponse,
  StoredSSEEvent,
} from '../types/queue.js';
import { createRequestLogger, RequestLogger } from '../utils/logger.js';

// Defaults for configurable values (overridable via env vars)
const DEFAULT_STORED_RESPONSE_TTL_MS = 5 * 60 * 1000; // 5 minutes
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

export class UserQueue {
  private state: DurableObjectState;
  private env: Env;

  /** Live SSE writers keyed by message_id */
  private streams: Map<string, WritableStreamDefaultWriter<Uint8Array>> = new Map();

  // NOTE: streamWaiters removed — Durable Object alarm handlers cannot be woken
  // by Promise.resolve() from concurrent fetch handlers. Using polling instead.

  /** Sliding window timestamps for enqueue rate limiting */
  private enqueueTimestamps: number[] = [];

  /** Instance-level ID for tracing DO identity across requests */
  private instanceId = crypto.randomUUID().slice(0, 8);

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    console.log(
      JSON.stringify({
        event: 'do_instance_created',
        instance_id: this.instanceId,
        timestamp: Date.now(),
      })
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    console.log(
      JSON.stringify({
        event: 'do_fetch_received',
        instance_id: this.instanceId,
        pathname: url.pathname,
        search: url.search,
        timestamp: Date.now(),
        streams_keys: [...this.streams.keys()],
      })
    );

    switch (url.pathname) {
      case '/enqueue':
        return this.handleEnqueue(request);
      case '/stream':
        return this.handleStream(url);
      case '/poll':
        return this.handlePoll(url);
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

    console.log(
      JSON.stringify({
        event: 'handle_stream_start',
        instance_id: this.instanceId,
        message_id: messageId,
        timestamp: Date.now(),
        streams_keys: [...this.streams.keys()],
      })
    );

    // Check for stored response (late-connect fallback)
    const stored = await this.getAndClearStoredResponse(messageId);
    if (stored) {
      console.log(
        JSON.stringify({
          event: 'handle_stream_found_stored',
          instance_id: this.instanceId,
          message_id: messageId,
          timestamp: Date.now(),
        })
      );
      return this.replayStoredResponse(stored);
    }

    return this.createLiveStream(messageId);
  }

  /** Return incremental events since cursor for poll-based streaming. */
  private async handlePoll(url: URL): Promise<Response> {
    const messageId = url.searchParams.get('message_id');
    if (!messageId) {
      return Response.json({ error: 'message_id query parameter is required' }, { status: 400 });
    }

    const cursor = parseInt(url.searchParams.get('cursor') ?? '0', 10);

    // Check chunked event store metadata
    const meta = await this.state.storage.get<EventStoreMetadata>(`evmeta:${messageId}`);

    if (meta) {
      const newEvents = await this.getEventsFromCursor(messageId, cursor, meta.event_count);
      const response: PollResponse = {
        message_id: messageId,
        events: newEvents,
        done: meta.done,
        cursor: meta.event_count,
      };
      return Response.json(response);
    }

    // Check legacy stored responses (backward compatibility)
    const responses =
      (await this.state.storage.get<Record<string, StoredResponse>>('responses')) ?? {};
    // eslint-disable-next-line security/detect-object-injection -- messageId from URL param
    const stored = responses[messageId];
    if (stored) {
      const response: PollResponse = {
        message_id: messageId,
        events: stored.events.slice(cursor),
        done: true,
        cursor: stored.events.length,
      };
      return Response.json(response);
    }

    // Not found — message may still be in queue waiting to be processed
    const response: PollResponse = {
      message_id: messageId,
      events: [],
      done: false,
      cursor: 0,
    };
    return Response.json(response);
  }

  /** Batch-read event keys from cursor to count (reads only what's needed). */
  private async getEventsFromCursor(
    messageId: string,
    cursor: number,
    eventCount: number
  ): Promise<StoredSSEEvent[]> {
    if (cursor >= eventCount) return [];

    const keys = [];
    for (let i = cursor; i < eventCount; i++) {
      keys.push(`ev:${messageId}:${i}`);
    }

    const entries = await this.state.storage.get<StoredSSEEvent>(keys);
    const events: StoredSSEEvent[] = [];
    for (const key of keys) {
      const event = entries.get(key);
      if (event) events.push(event);
    }
    return events;
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

    console.log(
      JSON.stringify({
        event: 'create_live_stream_writer_registered',
        instance_id: this.instanceId,
        message_id: messageId,
        timestamp: Date.now(),
        streams_keys: [...this.streams.keys()],
      })
    );

    const encoder = new TextEncoder();
    await writer.write(
      encoder.encode(`event: queued\ndata: ${JSON.stringify({ message_id: messageId })}\n\n`)
    );

    // NOTE: No waiter.resolve() needed — waitForSSEClient uses polling on this.streams Map.

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

  /**
   * Forward to UserSession /stream and store events incrementally.
   *
   * Events are written to DO storage as they arrive so poll-based clients
   * can retrieve partial results. If a live SSE writer is connected, events
   * are also piped to it in real-time.
   */
  private async processWithSSE(entry: QueueEntry, logger: RequestLogger): Promise<void> {
    // Initialize chunked event store metadata
    const metaKey = `evmeta:${entry.message_id}`;
    await this.state.storage.put(metaKey, {
      message_id: entry.message_id,
      event_count: 0,
      done: false,
      created_at: Date.now(),
    } as EventStoreMetadata);

    const response = await this.fetchUserSessionStream(entry);

    // Check for live SSE writer (may have connected during fetch)
    const writer = this.streams.get(entry.message_id);
    if (writer) {
      logger.log('sse_client_connected', {
        message_id: entry.message_id,
        user_id: entry.user_id,
      });
    }

    await this.bufferIncrementally(response.body!, entry.message_id, writer);
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

  /**
   * Read SSE stream from UserSession and store events incrementally.
   * Optionally pipes events to a live SSE writer if one is connected.
   */
  private async bufferIncrementally(
    body: ReadableStream<Uint8Array>,
    messageId: string,
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  ): Promise<void> {
    writer = await this.sendProcessingEvent(writer, messageId);
    const lineBuffer = await this.readStreamChunks(body, messageId, writer);
    await this.flushLineBuffer(lineBuffer, messageId);
    await this.finalizeEventStore(messageId);
    await this.closeLiveWriter(writer, messageId);
  }

  /** Send the initial "processing" event to a live writer, or null it on disconnect. */
  private async sendProcessingEvent(
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
    messageId: string
  ): Promise<WritableStreamDefaultWriter<Uint8Array> | undefined> {
    if (!writer) return undefined;
    try {
      const encoder = new TextEncoder();
      await writer.write(
        encoder.encode(`event: processing\ndata: ${JSON.stringify({ message_id: messageId })}\n\n`)
      );
      return writer;
    } catch {
      return undefined; // Client disconnected
    }
  }

  /** Read stream chunks, parse SSE events, store incrementally, and pipe to live writer. */
  private async readStreamChunks(
    body: ReadableStream<Uint8Array>,
    messageId: string,
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalSize = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        totalSize += value.byteLength;
        if (totalSize > DEFAULT_MAX_BUFFERED_RESPONSE_SIZE) {
          await this.appendEvents(messageId, [
            { event: 'data', data: JSON.stringify({ type: 'error', error: 'Response too large' }) },
          ]);
          break;
        }

        writer = await this.pipeChunkToWriter(writer, value);
        buffer = await this.parseAndStoreChunk(
          decoder.decode(value, { stream: true }),
          buffer,
          messageId
        );
      }
    } finally {
      reader.releaseLock();
    }
    return buffer;
  }

  /** Pipe a raw chunk to the live writer, returning undefined if the writer disconnected. */
  private async pipeChunkToWriter(
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
    value: Uint8Array
  ): Promise<WritableStreamDefaultWriter<Uint8Array> | undefined> {
    if (!writer) return undefined;
    try {
      await writer.write(value);
      return writer;
    } catch {
      return undefined;
    }
  }

  /** Parse SSE `data:` lines from a chunk, store new events, and return remaining buffer. */
  private async parseAndStoreChunk(
    chunk: string,
    buffer: string,
    messageId: string
  ): Promise<string> {
    const combined = buffer + chunk;
    const lines = combined.split('\n');
    const remainder = lines.pop() ?? '';

    const newEvents: StoredSSEEvent[] = [];
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        newEvents.push({ event: 'data', data: line.slice(6) });
      }
    }
    if (newEvents.length > 0) {
      await this.appendEvents(messageId, newEvents);
    }
    return remainder;
  }

  /** Flush any remaining data in the line buffer. */
  private async flushLineBuffer(buffer: string, messageId: string): Promise<void> {
    if (buffer.startsWith('data: ')) {
      await this.appendEvents(messageId, [{ event: 'data', data: buffer.slice(6) }]);
    }
  }

  /** Mark the event store as done, appending a final "done" event. */
  private async finalizeEventStore(messageId: string): Promise<void> {
    const metaKey = `evmeta:${messageId}`;
    const meta = await this.state.storage.get<EventStoreMetadata>(metaKey);
    if (meta) {
      const doneEvent: StoredSSEEvent = {
        event: 'done',
        data: JSON.stringify({ message_id: messageId }),
      };
      await this.state.storage.put(`ev:${messageId}:${meta.event_count}`, doneEvent);
      meta.event_count += 1;
      meta.done = true;
      await this.state.storage.put(metaKey, meta);
    }
  }

  /** Close a live SSE writer with a "done" event. */
  private async closeLiveWriter(
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
    messageId: string
  ): Promise<void> {
    if (!writer) return;
    try {
      const encoder = new TextEncoder();
      await writer.write(
        encoder.encode(`event: done\ndata: ${JSON.stringify({ message_id: messageId })}\n\n`)
      );
      await writer.close();
    } catch {
      // Client may have disconnected
    }
  }

  /** Append events as individual keys and update the metadata counter. */
  private async appendEvents(messageId: string, events: StoredSSEEvent[]): Promise<void> {
    const metaKey = `evmeta:${messageId}`;
    const meta = await this.state.storage.get<EventStoreMetadata>(metaKey);
    if (!meta) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- batch put requires Record<string, T>
    const entries: Record<string, any> = {};
    let idx = meta.event_count;
    for (const event of events) {
      entries[`ev:${messageId}:${idx}`] = event;
      idx++;
    }
    meta.event_count = idx;
    // eslint-disable-next-line security/detect-object-injection -- metaKey is a computed string, not user input
    entries[metaKey] = meta;
    await this.state.storage.put(entries);
  }

  /** Get a UserSession DO stub for the given queue entry. */
  private getUserSessionStub(entry: QueueEntry): DurableObjectStub {
    const doId = this.env.USER_SESSION.idFromName(`user:${entry.org}:${entry.user_id}`);
    return this.env.USER_SESSION.get(doId);
  }

  // NOTE: waitForSSEClient removed. Durable Object alarm handlers cannot yield
  // to concurrent fetch handlers — neither Promise-based coordination nor
  // setTimeout/polling works inside an alarm. Instead, processWithSSE fetches
  // from UserSession first (which yields via await), then checks this.streams.

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

  private getMaxRetries(): number {
    return parseInt(this.env.QUEUE_MAX_RETRIES ?? '', 10) || DEFAULT_MAX_RETRIES;
  }
}
