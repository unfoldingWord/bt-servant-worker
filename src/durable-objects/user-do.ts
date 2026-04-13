/**
 * UserDO — Unified per-user Durable Object
 *
 * Merges the former UserSession (chat processing, state) and UserQueue
 * (message queuing, SSE relay) into a single DO. This eliminates the
 * DO-to-DO chain that caused Cloudflare error 1003 on outbound fetch to
 * api.anthropic.com.
 *
 * Architecture: Worker → UserDO → Anthropic API (depth 2, always works)
 *
 * All chat requests flow through an internal FIFO queue processed by the
 * alarm() handler. SSE clients hold an open connection while their message
 * waits in the queue; callback clients get 202 immediately.
 */

import { Hono } from 'hono';
import { Env } from '../config/types.js';
import { GroupChatContext, orchestrate, OrchestrationResult } from '../services/claude/index.js';
import { formatTOCForPrompt, JsonMemoryStore } from '../services/memory/index.js';
import { buildToolCatalog, discoverAllTools } from '../services/mcp/index.js';
import { MCPServerConfig } from '../services/mcp/types.js';
import {
  createWebhookCallbacks,
  DEFAULT_PROGRESS_MODE,
  DEFAULT_THROTTLE_SECONDS,
  ProgressCallbackSender,
} from '../services/progress/index.js';
import {
  ChatHistoryEntry,
  ChatHistoryResponse,
  ChatRequest,
  ChatResponse,
  ChatTransport,
  SSEEvent,
  StreamCallbacks,
  UpdatePreferencesRequest,
  UserPreferencesAPI,
  UserPreferencesInternal,
} from '../types/engine.js';
import { DEFAULT_ORG_CONFIG, OrgConfig } from '../types/org-config.js';
import {
  DEFAULT_PROMPT_VALUES,
  ModeContext,
  mergePromptOverrides,
  PROMPT_OVERRIDE_SLOTS,
  PromptMode,
  PromptOverrides,
  resolveActiveModeName,
  resolvePromptOverrides,
  validateModeName,
  validatePromptOverrides,
} from '../types/prompt-overrides.js';
import {
  transcribeAudio,
  synthesizeSpeech,
  AudioContext,
  generateAudioKey,
  audioKeyToUrl,
  uploadAudio,
} from '../services/audio/index.js';
import { AudioTranscriptionError, ValidationError } from '../utils/errors.js';
import { createRequestLogger, RequestLogger, withEndpointLogging } from '../utils/logger.js';
import { applyTemplateVariables } from '../utils/template.js';
import { createTimingContext, timePhase, TimingContext } from '../utils/timing.js';
import { validateChatBody } from '../utils/chat-validation.js';
import { InternalQueueEntry } from '../types/queue.js';

// ── Storage keys ───────────────────────────────────────────────────────────────
const HISTORY_KEY = 'history';
const PREFERENCES_KEY = 'preferences';
const PROMPT_OVERRIDES_KEY = 'prompt_overrides';
const SELECTED_MODE_KEY = 'selected_mode';
const PROCESSING_LOCK_KEY = '_processing_lock';
const QUEUE_KEY = 'queue';
const QUEUE_PROCESSING_KEY = 'queue_processing';

// ── Constants ──────────────────────────────────────────────────────────────────
const LOCK_STALE_THRESHOLD_MS = 90_000; // 90 seconds
const DEFAULT_MAX_QUEUE_DEPTH = 50;
const DEFAULT_MAX_RETRIES = 3;
const ENQUEUE_RATE_WINDOW_MS = 60_000; // 1 minute
const ENQUEUE_RATE_LIMIT = 300;
const SSE_KEEPALIVE_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Validates ISO 639-1 language code format (2 lowercase letters).
 */
const ISO_639_1_PATTERN = /^[a-z]{2}$/;

function isValidLanguageCode(code: string): boolean {
  return ISO_639_1_PATTERN.test(code);
}

const DEFAULT_PREFERENCES: UserPreferencesInternal = {
  response_language: 'en',
  first_interaction: true,
};

function createErrorResponse(
  error: string,
  code: string,
  message: string,
  status: number
): Response {
  return Response.json({ error, code, message }, { status });
}

function storageErrorResponse(err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err);
  return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
}

export class UserDO {
  private state: DurableObjectState;
  private env: Env;
  private app: Hono;
  private requestLogger: RequestLogger | null = null;

  /** Live SSE writers for queued messages, keyed by message_id */
  private queuedWriters: Map<string, WritableStreamDefaultWriter<Uint8Array>> = new Map();

  /** Sliding window timestamps for enqueue rate limiting */
  private enqueueTimestamps: number[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.app = new Hono();
    this.app.get('/preferences', () => this.handleGetPreferences());
    this.app.put('/preferences', (c) => this.handleUpdatePreferences(c.req.raw));
    this.app.get('/history', (c) => this.handleGetHistory(new URL(c.req.url)));
    this.app.delete('/history', () => this.handleDeleteHistory());
    this.app.get('/prompt-overrides', () => this.handleGetPromptOverrides());
    this.app.put('/prompt-overrides', (c) => this.handleUpdatePromptOverrides(c.req.raw));
    this.app.delete('/prompt-overrides', () => this.handleDeletePromptOverrides());
    this.app.get('/mode', () => this.handleGetMode());
    this.app.put('/mode', (c) => this.handleSetMode(c.req.raw));
    this.app.delete('/mode', () => this.handleDeleteMode());
    this.app.get('/memory', () => this.handleGetMemory());
    this.app.delete('/memory', () => this.handleDeleteMemory());
  }

  private getLogger(): RequestLogger {
    return this.requestLogger ?? createRequestLogger(crypto.randomUUID());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get('X-Request-ID') ?? crypto.randomUUID();
    this.requestLogger = createRequestLogger(requestId);

    // Chat endpoints — one route per explicit transport.
    //   /chat           → legacy body-dispatch (SSE by default, callback if
    //                     progress_callback_url is present). Will become
    //                     final-only JSON in v2.14.0.
    //   /chat/stream    → always SSE.
    //   /chat/callback  → always webhook; worker has already validated that
    //                     progress_callback_url and message_key are present.
    if (url.pathname === '/chat') {
      return this.handleUnifiedChat(request, 'legacy');
    }
    if (url.pathname === '/chat/stream') {
      return this.handleUnifiedChat(request, 'stream');
    }
    if (url.pathname === '/chat/callback') {
      return this.handleUnifiedChat(request, 'callback');
    }

    // Non-chat endpoints don't need locking
    return this.app.fetch(request);
  }

  // ── Alarm-based queue processing ──────────────────────────────────────────────

  async alarm(): Promise<void> {
    const logger = createRequestLogger(crypto.randomUUID());

    try {
      const entry = await this.dequeueNext();
      if (!entry) {
        logger.log('queue_empty_alarm_done');
        return;
      }
      await this.processQueueEntry(entry, logger);
    } catch (error) {
      logger.error('alarm_fatal_error', error);
      try {
        await this.releaseLock();
      } catch (storageErr) {
        logger.error('alarm_recovery_storage_failed', storageErr, {
          original_error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      await this.scheduleNextAlarm();
    } catch (error) {
      logger.error('alarm_schedule_next_failed', error);
      try {
        await this.state.storage.put(QUEUE_PROCESSING_KEY, false);
      } catch (storageErr) {
        logger.error('alarm_schedule_recovery_failed', storageErr);
      }
    }
  }

  // ── Unified chat handler ──────────────────────────────────────────────────────

  /**
   * Parse and re-validate the request body for a chat endpoint.
   *
   * Returns `{ body }` on success, or `{ error: Response }` on failure.
   *
   * The DO re-runs the worker's transport validation rules as
   * defense-in-depth. The worker already validated this request, but
   * re-checking here guarantees the transport → body invariant is
   * enforced at the same place we rely on it for queue dispatch
   * (processQueueEntry reads body.progress_callback_url to decide
   * callback vs SSE). If a future refactor breaks worker-side
   * validation, this fails loudly instead of silently dropping the
   * user's response in the queued path.
   */
  private async parseChatBody(
    request: Request,
    transport: ChatTransport,
    logger: RequestLogger
  ): Promise<{ body: ChatRequest; error?: never } | { body?: never; error: Response }> {
    let body: ChatRequest;
    try {
      body = (await request.json()) as ChatRequest;
    } catch (err) {
      logger.warn('chat_invalid_json', {
        transport,
        error: err instanceof Error ? err.message : String(err),
      });
      return { error: Response.json({ error: 'Invalid JSON body' }, { status: 400 }) };
    }

    const validationError = validateChatBody(body, transport);
    if (validationError) {
      logger.warn('chat_validation_failed_in_do', {
        transport,
        error: validationError,
        user_id: body.user_id,
      });
      return { error: Response.json({ error: validationError }, { status: 400 }) };
    }

    return { body };
  }

  private async handleUnifiedChat(request: Request, transport: ChatTransport): Promise<Response> {
    const logger = this.getLogger();

    const parsed = await this.parseChatBody(request, transport, logger);
    if (parsed.error) return parsed.error;
    const { body } = parsed;

    // Rate limiting
    const rateLimited = this.checkRateLimit(
      this.enqueueTimestamps,
      ENQUEUE_RATE_WINDOW_MS,
      ENQUEUE_RATE_LIMIT,
      '10'
    );
    if (rateLimited) return rateLimited;

    // Resolve the effective delivery mode for this request:
    //   - stream   → always SSE
    //   - callback → always webhook
    //   - legacy   → pick based on body.progress_callback_url presence
    // The effective delivery is what matters for queue semantics and for
    // which background runner we invoke. This is safe because the
    // validation above guarantees stream bodies never have
    // progress_callback_url and callback bodies always do, so
    // body.progress_callback_url is a faithful proxy for delivery on
    // the queued path (processQueueEntry reads the same field).
    const isCallbackDelivery =
      transport === 'callback' || (transport === 'legacy' && !!body.progress_callback_url);
    const messageId = crypto.randomUUID();
    const workerOrigin = request.headers.get('X-Worker-Origin') ?? '';

    // Try to process immediately in the fetch handler if idle.
    // Outbound fetch to api.anthropic.com fails from DO alarm() contexts
    // (Cloudflare 1003), so we MUST process in the fetch handler.
    const lockAcquired = await this.tryAcquireLock();
    if (lockAcquired) {
      logger.log('chat_immediate', {
        message_id: messageId,
        user_id: body.user_id,
        transport,
        delivery: isCallbackDelivery ? 'callback' : 'sse',
      });
      if (isCallbackDelivery) {
        return this.processImmediateCallback(body, workerOrigin, messageId, logger);
      }
      return this.processImmediateSSE(body, workerOrigin, messageId, logger);
    }

    // DO is busy — enqueue for processing when current request finishes
    return this.enqueueAndReturn(body, messageId, workerOrigin, isCallbackDelivery, logger);
  }

  /** Enqueue a message and return 202 (callback) or SSE stream (SSE delivery). */
  private async enqueueAndReturn(
    body: ChatRequest,
    messageId: string,
    workerOrigin: string,
    isCallbackDelivery: boolean,
    logger: RequestLogger
  ): Promise<Response> {
    const entry: InternalQueueEntry = {
      message_id: messageId,
      body: { ...body, _worker_origin: workerOrigin },
      enqueued_at: Date.now(),
      retry_count: 0,
    };

    const maxDepth = this.getMaxQueueDepth();
    const position = await this.enqueueEntry(entry, maxDepth);

    if (position === -1) {
      return Response.json(
        {
          error: 'Queue full',
          code: 'QUEUE_DEPTH_EXCEEDED',
          message: `Queue depth limit (${maxDepth}) exceeded.`,
        },
        { status: 429, headers: { 'Retry-After': '5' } }
      );
    }

    logger.log('chat_enqueued', {
      message_id: messageId,
      delivery: isCallbackDelivery ? 'callback' : 'sse',
      queue_position: position,
      user_id: body.user_id,
    });

    if (isCallbackDelivery) {
      return Response.json({ message_id: messageId }, { status: 202 });
    }

    return this.createQueuedSSEStream(messageId, logger);
  }

  /** Process a callback-mode message immediately in the fetch handler. Returns 202. */
  private processImmediateCallback(
    body: ChatRequest,
    workerOrigin: string,
    messageId: string,
    logger: RequestLogger
  ): Response {
    // Start processing in background — return 202 immediately
    (async () => {
      const timing = createTimingContext();
      const callbacks = this.buildWebhookCallbacks(body, logger);
      try {
        const response = await this.processChat(body, workerOrigin, logger, timing, callbacks);
        await callbacks?.onComplete?.(response);
        logger.log('immediate_callback_complete', { message_id: messageId });
      } catch (error) {
        logger.error('immediate_callback_error', error, { message_id: messageId });
        await callbacks?.onError?.(error instanceof Error ? error.message : 'Processing failed');
      } finally {
        await this.releaseLock();
        await this.drainQueue(logger);
      }
    })().catch((err) =>
      logger.error('immediate_callback_unhandled', err, { message_id: messageId })
    );

    return Response.json({ message_id: messageId }, { status: 202 });
  }

  /** Process a chat message immediately in the fetch handler (not via alarm). */
  private processImmediateSSE(
    body: ChatRequest,
    workerOrigin: string,
    messageId: string,
    logger: RequestLogger
  ): Response {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const { sendEvent, keepaliveInterval } = this.buildSSESender(writer, logger, Date.now());

    const callbacks: StreamCallbacks = {
      onStatus: async (message) => sendEvent({ type: 'status', message }),
      onProgress: async (text) => sendEvent({ type: 'progress', text }),
      onComplete: async (response) => sendEvent({ type: 'complete', response }),
      onError: async (error) => sendEvent({ type: 'error', error }),
      onToolUse: async (tool, input) => sendEvent({ type: 'tool_use', tool, input }),
      onToolResult: async (tool, result) => sendEvent({ type: 'tool_result', tool, result }),
    };

    // Process in background — the Response is returned immediately with the SSE stream
    (async () => {
      try {
        const timing = createTimingContext();
        const response = await this.processChat(body, workerOrigin, logger, timing, callbacks);
        await sendEvent({ type: 'complete', response });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Processing failed';
        logger.error('immediate_sse_error', error, { message_id: messageId });
        await sendEvent({ type: 'error', error: errorMessage });
      } finally {
        clearInterval(keepaliveInterval);
        try {
          await writer.close();
        } catch {
          /* client disconnected */
        }
        await this.releaseLock();
        await this.drainQueue(logger);
      }
    })().catch((err) => logger.error('immediate_sse_unhandled', err, { message_id: messageId }));

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /** Create an SSE stream for a queued message. Events flow when the alarm processes it. */
  private createQueuedSSEStream(messageId: string, logger: RequestLogger): Response {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Register writer so alarm() can pipe events to it
    this.queuedWriters.set(messageId, writer);

    // Send initial queued event
    const queuedEvent: SSEEvent = {
      type: 'status',
      message: 'Queued — processing will begin shortly',
    };
    writer.write(encoder.encode(`data: ${JSON.stringify(queuedEvent)}\n\n`)).catch((error) => {
      logger.warn('sse_client_disconnected', {
        phase: 'initial_queued_event',
        message_id: messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.queuedWriters.delete(messageId);
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /**
   * Drain queued entries after immediate processing completes.
   * Runs in the fetch handler context (not alarm) to avoid Cloudflare 1003.
   * Processes entries one at a time until the queue is empty.
   */
  private async drainQueue(logger: RequestLogger): Promise<void> {
    for (;;) {
      const entry = await this.dequeueNext();
      if (!entry) return;

      logger.log('drain_queue_entry', { message_id: entry.message_id });
      await this.processQueueEntry(entry, logger);
    }
  }

  // ── Queue entry processing (called by alarm or drainQueue) ────────────────────

  private async processQueueEntry(entry: InternalQueueEntry, logger: RequestLogger): Promise<void> {
    const startTime = Date.now();
    const body = entry.body;
    const isCallbackMode = !!body.progress_callback_url;

    logger.log('queue_processing_start', {
      message_id: entry.message_id,
      delivery: isCallbackMode ? 'callback' : 'sse',
      user_id: body.user_id,
      retry_count: entry.retry_count,
      queue_wait_ms: startTime - entry.enqueued_at,
    });

    // Acquire lock (defense-in-depth — alarm already serializes)
    await this.state.storage.put(PROCESSING_LOCK_KEY, Date.now());

    try {
      if (isCallbackMode) {
        await this.processCallbackEntry(entry, logger);
      } else {
        await this.processSSEEntry(entry, logger);
      }
      logger.log('queue_processing_complete', {
        message_id: entry.message_id,
        processing_ms: Date.now() - startTime,
      });
    } catch (error) {
      logger.error('queue_processing_error', error, {
        message_id: entry.message_id,
        user_id: body.user_id,
        retry_count: entry.retry_count,
        processing_ms: Date.now() - startTime,
      });
      await this.handleProcessingError(entry, error, logger);
    } finally {
      await this.releaseLock();
      this.queuedWriters.delete(entry.message_id);
    }
  }

  /** Process a callback-mode queue entry (WhatsApp gateway). */
  private async processCallbackEntry(
    entry: InternalQueueEntry,
    logger: RequestLogger
  ): Promise<void> {
    const body = entry.body;
    const workerOrigin = body._worker_origin ?? '';
    const timing = createTimingContext();
    const callbacks = this.buildWebhookCallbacks(body, logger);

    try {
      const response = await this.processChat(body, workerOrigin, logger, timing, callbacks);
      await callbacks?.onComplete?.(response);
    } catch (error) {
      await callbacks?.onError?.(error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /** Build an SSE event sender bound to a writer, tracking disconnection state. */
  private buildSSESender(
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
    logger: RequestLogger,
    startTime: number
  ) {
    const encoder = new TextEncoder();
    const state = { clientDisconnected: false, firstTokenTime: null as number | null };

    const sendEvent = async (event: SSEEvent): Promise<void> => {
      if (state.clientDisconnected || !writer) return;
      if (event.type === 'progress' && state.firstTokenTime === null) {
        state.firstTokenTime = Date.now() - startTime;
        logger.log('stream_first_token', { time_to_first_token_ms: state.firstTokenTime });
      }
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch (error) {
        state.clientDisconnected = true;
        logger.warn('sse_client_disconnected', {
          phase: 'send_event',
          event_type: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const keepaliveInterval = setInterval(() => {
      if (state.clientDisconnected || !writer) {
        clearInterval(keepaliveInterval);
        return;
      }
      writer
        .write(encoder.encode(`data: ${JSON.stringify({ type: 'keepalive' })}\n\n`))
        .catch((error: unknown) => {
          logger.warn('sse_keepalive_write_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          state.clientDisconnected = true;
          clearInterval(keepaliveInterval);
        });
    }, SSE_KEEPALIVE_INTERVAL_MS);

    return { sendEvent, keepaliveInterval, state };
  }

  /** Process an SSE-mode queue entry (web client). */
  private async processSSEEntry(entry: InternalQueueEntry, logger: RequestLogger): Promise<void> {
    const body = entry.body;
    const writer = this.queuedWriters.get(entry.message_id);
    const { sendEvent, keepaliveInterval } = this.buildSSESender(writer, logger, Date.now());

    try {
      const callbacks: StreamCallbacks = {
        onStatus: async (message) => sendEvent({ type: 'status', message }),
        onProgress: async (text) => sendEvent({ type: 'progress', text }),
        // onComplete is sent explicitly after processChat returns (not by the orchestrator)
        onComplete: async (response) => sendEvent({ type: 'complete', response }),
        onError: async (error) => sendEvent({ type: 'error', error }),
        onToolUse: async (tool, input) => sendEvent({ type: 'tool_use', tool, input }),
        onToolResult: async (tool, result) => sendEvent({ type: 'tool_result', tool, result }),
      };

      const timing = createTimingContext();
      const response = await this.processChat(
        body,
        body._worker_origin ?? '',
        logger,
        timing,
        callbacks
      );
      await sendEvent({ type: 'complete', response });
    } catch (error) {
      // Send error to SSE client BEFORE closing the writer — if we let this propagate
      // to processQueueEntry's handleProcessingError, the writer is already closed.
      const errorMessage = error instanceof Error ? error.message : 'Processing failed';
      logger.error('sse_entry_processing_error', error, { message_id: entry.message_id });
      await sendEvent({ type: 'error', error: errorMessage });
      throw error; // Re-throw for retry logic in processQueueEntry
    } finally {
      clearInterval(keepaliveInterval);
      if (writer) {
        try {
          await writer.close();
        } catch (error) {
          logger.warn('stream_writer_close_failed', {
            phase: 'processSSEEntry',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  // ── Queue infrastructure ──────────────────────────────────────────────────────

  /** Atomically append entry to queue and schedule alarm if idle. Returns -1 if full. */
  private async enqueueEntry(entry: InternalQueueEntry, maxDepth: number): Promise<number> {
    return this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<InternalQueueEntry[]>(QUEUE_KEY)) ?? [];

      if (queue.length >= maxDepth) return -1;

      queue.push(entry);
      await this.state.storage.put(QUEUE_KEY, queue);

      const isProcessing = (await this.state.storage.get<boolean>(QUEUE_PROCESSING_KEY)) ?? false;
      if (!isProcessing) {
        await this.state.storage.put(QUEUE_PROCESSING_KEY, true);
        await this.state.storage.setAlarm(Date.now());
      }
      return queue.length;
    });
  }

  /** Atomically dequeue the next entry, or return null if queue is empty. */
  private async dequeueNext(): Promise<InternalQueueEntry | null> {
    return this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<InternalQueueEntry[]>(QUEUE_KEY)) ?? [];
      if (queue.length === 0) {
        await this.state.storage.put(QUEUE_PROCESSING_KEY, false);
        return null;
      }
      const next = queue.shift()!;
      await this.state.storage.put(QUEUE_KEY, queue);
      return next;
    });
  }

  /** Schedule the next alarm if there are items remaining in the queue. */
  private async scheduleNextAlarm(): Promise<void> {
    const hasMore = await this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<InternalQueueEntry[]>(QUEUE_KEY)) ?? [];
      if (queue.length === 0) {
        await this.state.storage.put(QUEUE_PROCESSING_KEY, false);
        return false;
      }
      return true;
    });

    if (hasMore) {
      await this.state.storage.setAlarm(Date.now());
    }
  }

  /** Re-enqueue a failed entry at the front of the queue for retry. */
  private async reEnqueue(entry: InternalQueueEntry): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<InternalQueueEntry[]>(QUEUE_KEY)) ?? [];
      queue.unshift(entry);
      await this.state.storage.put(QUEUE_KEY, queue);
    });
  }

  /** Handle errors during queue processing with retry logic. */
  private async handleProcessingError(
    entry: InternalQueueEntry,
    error: unknown,
    logger: RequestLogger
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const maxRetries = this.getMaxRetries();

    if (this.isTransientError(errorMessage) && entry.retry_count < maxRetries) {
      logger.warn('queue_entry_retry', {
        message_id: entry.message_id,
        retry_count: entry.retry_count + 1,
        max_retries: maxRetries,
      });
      await this.reEnqueue({ ...entry, retry_count: entry.retry_count + 1 });
      return;
    }

    // Permanent failure — notify SSE client if connected
    const writer = this.queuedWriters.get(entry.message_id);
    if (writer) {
      try {
        const encoder = new TextEncoder();
        const event: SSEEvent = { type: 'error', error: errorMessage };
        await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        await writer.close();
      } catch (writeErr) {
        logger.warn('sse_error_write_failed', {
          message_id: entry.message_id,
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
    }
  }

  /** Check if an error message indicates a transient (retryable) failure. */
  private isTransientError(errorMessage: string): boolean {
    return (
      /returned 5\d{2}/.test(errorMessage) ||
      errorMessage.includes('Network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('ECONNREFUSED')
    );
  }

  /** Sliding-window rate limiter. */
  private checkRateLimit(
    timestamps: number[],
    windowMs: number,
    limit: number,
    retryAfter: string
  ): Response | null {
    const now = Date.now();
    const cutoff = now - windowMs;
    let expiredCount = 0;
    while (
      expiredCount < timestamps.length &&
      (timestamps.at(expiredCount) ?? Infinity) <= cutoff
    ) {
      expiredCount++;
    }
    if (expiredCount > 0) timestamps.splice(0, expiredCount);
    if (timestamps.length >= limit) {
      return Response.json(
        { error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': retryAfter } }
      );
    }
    timestamps.push(now);
    return null;
  }

  // ── Lock management ───────────────────────────────────────────────────────────

  private async tryAcquireLock(): Promise<boolean> {
    return this.state.blockConcurrencyWhile(async () => {
      const lock = await this.state.storage.get<number>(PROCESSING_LOCK_KEY);
      const now = Date.now();
      if (lock && now - lock < LOCK_STALE_THRESHOLD_MS) {
        return false;
      }
      if (lock) {
        this.getLogger().warn('stale_lock_overwritten', { lock_age_ms: now - lock });
      }
      await this.state.storage.put(PROCESSING_LOCK_KEY, now);
      return true;
    });
  }

  private async releaseLock(): Promise<void> {
    await this.state.storage.delete(PROCESSING_LOCK_KEY);
  }

  // ── Webhook callbacks ─────────────────────────────────────────────────────────

  private buildWebhookCallbacks(
    body: ChatRequest,
    logger: RequestLogger
  ): StreamCallbacks | undefined {
    if (!body.progress_callback_url || !body.message_key) return undefined;

    const sender = new ProgressCallbackSender(
      {
        url: body.progress_callback_url,
        user_id: body.user_id,
        message_key: body.message_key,
        token: this.env.ENGINE_API_KEY,
        ...(body.chat_id ? { chat_id: body.chat_id } : {}),
        ...(body.thread_id ? { thread_id: body.thread_id } : {}),
      },
      logger
    );
    const throttleSeconds =
      typeof body.progress_throttle_seconds === 'number' && body.progress_throttle_seconds > 0
        ? body.progress_throttle_seconds
        : DEFAULT_THROTTLE_SECONDS;
    return createWebhookCallbacks(sender, logger, {
      mode: body.progress_mode ?? DEFAULT_PROGRESS_MODE,
      throttleSeconds,
    });
  }

  // ── Chat processing pipeline ──────────────────────────────────────────────────

  private async processChat(
    body: ChatRequest,
    workerOrigin: string,
    logger: RequestLogger,
    timing: TimingContext,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse> {
    const ctx = { timing, logger, startTime: Date.now() };
    // prettier-ignore
    logger.log('process_chat_start', { message_type: body.message_type, has_audio: !!body.audio_base64, has_callbacks: !!callbacks, chat_type: body.chat_type ?? 'private' });

    const loaded = await this.loadChatContext(body, ctx, callbacks);

    // Apply response_language_hint override for this request
    const effectivePreferences = body.response_language_hint
      ? { ...loaded.preferences, response_language: body.response_language_hint }
      : loaded.preferences;

    // Build group context for system prompt
    const chatType = body.chat_type ?? 'private';
    const isGroupChat = chatType === 'group' || chatType === 'supergroup';
    const groupContext = isGroupChat
      ? {
          isGroupChat: true,
          ...(body.speaker ? { currentSpeaker: body.speaker } : {}),
        }
      : undefined;

    const audioContext = this.buildAudioContext();
    // prettier-ignore
    const orchOpts = this.buildOrchOpts(body, loaded.catalog, loaded.history, effectivePreferences, loaded.resolved, loaded.memoryStore, loaded.formattedTOC, loaded.orgModes, loaded.activeModeName, audioContext, logger, callbacks, groupContext);

    const orchResult = await this.tracedPhase(ctx, 'orchestration', () =>
      this.runOrchestration(loaded.messageText, orchOpts)
    );
    const { responses } = orchResult;
    const ttsResponses = this.extractTtsResponses(orchResult, logger);

    const voiceAudio = await this.tracedPhase(ctx, 'audio_generation', () =>
      this.maybeGenerateAudio(body, audioContext, ttsResponses, logger, callbacks)
    );
    const audioKey = voiceAudio?.audioKey ?? null;

    await this.tracedPhase(ctx, 'save_conversation', () =>
      this.saveConversation(
        loaded.messageText,
        responses,
        loaded.preferences,
        body._org_config ?? {},
        { logger, audioKey, ...(body.speaker ? { speaker: body.speaker } : {}) }
      )
    );

    const voiceAudioUrl = audioKey ? audioKeyToUrl(audioKey, workerOrigin) : null;
    // prettier-ignore
    logger.log('process_chat_complete', { total_ms: Date.now() - ctx.startTime, response_count: responses.length, has_voice_audio: voiceAudioUrl !== null, voice_audio_key: audioKey, total_response_chars: responses.join('').length });
    return {
      responses,
      response_language: effectivePreferences.response_language,
      voice_audio_base64: null,
      voice_audio_url: voiceAudioUrl,
    };
  }

  /** Load all context needed for orchestration. */
  private async loadChatContext(
    body: ChatRequest,
    ctx: { timing: TimingContext; logger: RequestLogger; startTime: number },
    callbacks?: StreamCallbacks
  ) {
    const { logger } = ctx;
    const messageText = await this.tracedPhase(ctx, 'resolve_message', () =>
      this.resolveMessageText(body, logger, callbacks)
    );
    const { preferences, history } = await this.tracedPhase(ctx, 'load_user_context', () =>
      this.loadUserContext(logger)
    );
    const catalog = await this.tracedPhase(ctx, 'mcp_discovery', () =>
      this.discoverMCPTools(body._mcp_servers ?? [], logger)
    );
    const { resolved, orgModes, activeModeName } = await this.tracedPhase(
      ctx,
      'resolve_prompts',
      () => this.resolvePrompts(body, logger)
    );
    const { memoryStore, formattedTOC } = await this.tracedPhase(ctx, 'load_memory', () =>
      this.loadMemoryContext(logger)
    );
    return {
      messageText,
      preferences,
      history,
      catalog,
      resolved,
      orgModes,
      activeModeName,
      memoryStore,
      formattedTOC,
    };
  }

  private async resolveMessageText(
    body: ChatRequest,
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<string> {
    if (body.message_type === 'audio') {
      return this.transcribeAudioMessage(body, logger, callbacks);
    }
    if (!body.message?.trim()) {
      throw new ValidationError('Message is required');
    }
    return body.message;
  }

  private async transcribeAudioMessage(
    body: ChatRequest,
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<string> {
    const sttFlowStart = Date.now();
    logger.log('audio_flow_stt_begin', {
      has_audio_base64: !!body.audio_base64,
      audio_base64_length: body.audio_base64?.length ?? 0,
      audio_format: body.audio_format,
    });

    if (!body.audio_base64 || !body.audio_format) {
      throw new ValidationError(
        'audio_base64 and audio_format are required when message_type is audio'
      );
    }

    await callbacks?.onStatus?.('Transcribing audio...');
    const transcription = await transcribeAudio(
      this.env.AI,
      body.audio_base64,
      body.audio_format,
      logger
    );

    if (!transcription.text) {
      throw new AudioTranscriptionError('Transcription returned empty text');
    }

    logger.log('audio_flow_stt_complete', {
      original_format: body.audio_format,
      transcribed_length: transcription.text.length,
      transcription_ms: transcription.duration_ms,
      stt_flow_total_ms: Date.now() - sttFlowStart,
      text_preview: transcription.text.slice(0, 200),
    });
    return transcription.text;
  }

  private async resolvePrompts(body: ChatRequest, logger: RequestLogger) {
    const orgOverrides = body._org_prompt_overrides ?? {};
    const orgModes = body._org_modes ?? { modes: [] };
    const userSelectedMode = await this.getSelectedMode();
    const activeModeName = resolveActiveModeName(userSelectedMode);

    let modeOverrides: PromptOverrides = {};
    if (activeModeName) {
      const mode = orgModes.modes.find((m) => m.name === activeModeName);
      if (mode) {
        modeOverrides = mode.overrides;
      } else {
        logger.warn('mode_not_found', {
          active_mode: activeModeName,
          available_modes: orgModes.modes.map((m) => m.name),
        });
      }
    }

    const userOverrides = await this.getPromptOverrides();
    const resolved = applyTemplateVariables(
      resolvePromptOverrides(orgOverrides, modeOverrides, userOverrides)
    );

    const overriddenSlots = PROMPT_OVERRIDE_SLOTS.filter(
      // eslint-disable-next-line security/detect-object-injection -- s is from PROMPT_OVERRIDE_SLOTS constant
      (s) => resolved[s] !== DEFAULT_PROMPT_VALUES[s]
    );
    if (overriddenSlots.length > 0) {
      logger.log('prompt_overrides_applied', {
        org_overrides: Object.keys(orgOverrides).length,
        mode_overrides: Object.keys(modeOverrides).length,
        active_mode: activeModeName ?? null,
        user_overrides: Object.keys(userOverrides).length,
        overridden_slots: overriddenSlots,
      });
    }
    return { resolved, orgModes, activeModeName };
  }

  private async loadMemoryContext(logger: RequestLogger) {
    const memoryStore = new JsonMemoryStore(this.state.storage, logger);
    const memoryTOC = await memoryStore.getTableOfContents();
    const formattedTOC = formatTOCForPrompt(memoryTOC);
    return { memoryStore, formattedTOC: formattedTOC || undefined };
  }

  private async loadUserContext(logger: RequestLogger) {
    const startTime = Date.now();
    const [preferences, history] = await Promise.all([this.getPreferences(), this.getHistory()]);
    logger.log('phase_load_complete', {
      history_count: history.length,
      duration_ms: Date.now() - startTime,
    });
    return { preferences, history };
  }

  private async discoverMCPTools(mcpServers: MCPServerConfig[], logger: RequestLogger) {
    const startTime = Date.now();
    const servers = mcpServers.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
    const manifests = await discoverAllTools(servers, logger);
    const catalog = buildToolCatalog(manifests, servers, logger);
    logger.log('mcp_catalog_built', {
      server_count: servers.length,
      tool_count: catalog.tools.length,
      discovery_duration_ms: Date.now() - startTime,
    });
    return catalog;
  }

  private async saveConversation(
    message: string,
    responses: string[],
    preferences: UserPreferencesInternal,
    orgConfig: OrgConfig,
    opts: { logger: RequestLogger; audioKey?: string | null; speaker?: string }
  ) {
    const { logger, audioKey, speaker } = opts;
    const startTime = Date.now();
    const storageMax = orgConfig.max_history_storage ?? DEFAULT_ORG_CONFIG.max_history_storage;
    await this.addHistoryEntry(
      {
        user_message: message,
        assistant_response: responses.join('\n'),
        timestamp: Date.now(),
        ...(audioKey ? { voice_audio_key: audioKey } : {}),
        ...(speaker ? { speaker } : {}),
      },
      storageMax
    );
    if (preferences.first_interaction) {
      await this.updatePreferences({ ...preferences, first_interaction: false });
    }
    logger.log('phase_save_complete', { duration_ms: Date.now() - startTime, storageMax });
  }

  // ── Audio ─────────────────────────────────────────────────────────────────────

  /** Extract only the final iteration's text for TTS (skip intermediate narration). */
  private extractTtsResponses(orchResult: OrchestrationResult, logger: RequestLogger): string[] {
    const { responses, finalIterationStartIndex } = orchResult;
    const ttsResponses = responses.slice(finalIterationStartIndex);
    logger.log('audio_flow_tts_filter', {
      total_responses: responses.length,
      final_iteration_start: finalIterationStartIndex,
      tts_responses: ttsResponses.length,
      filtered_out: responses.length - ttsResponses.length,
    });
    return ttsResponses;
  }

  private async maybeGenerateAudio(
    body: ChatRequest,
    audioContext: AudioContext,
    responses: string[],
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<{ audioKey: string } | null> {
    const ttsFlowStart = Date.now();
    const shouldGenerate = body.message_type === 'audio' || audioContext.audioRequested;
    const combinedText = responses.join('\n\n');
    const org = body.org ?? this.env.DEFAULT_ORG;
    const userId = body.user_id;
    logger.log('audio_flow_tts_decision', {
      message_type: body.message_type,
      audio_requested_by_tool: audioContext.audioRequested,
      should_generate: shouldGenerate,
      response_count: responses.length,
      combined_text_chars: combinedText.length,
      individual_response_lengths: responses.map((r) => r.length),
      has_responses: responses.length > 0,
    });
    if (!shouldGenerate || responses.length === 0) {
      logger.log('audio_flow_tts_skipped', {
        reason: !shouldGenerate ? 'not_requested' : 'no_responses',
      });
      return null;
    }
    const audio = await this.generateVoiceResponse(org, userId, responses, logger, callbacks);
    logger.log('audio_flow_tts_result', {
      has_audio: audio !== null,
      audio_key: audio?.audioKey ?? null,
      tts_flow_total_ms: Date.now() - ttsFlowStart,
    });
    return audio;
  }

  private startTtsKeepalive(
    callbacks: StreamCallbacks,
    genStart: number,
    logger: RequestLogger
  ): { interval: ReturnType<typeof setInterval>; getCount: () => number } {
    let count = 0;
    const interval = setInterval(() => {
      count++;
      logger.log('tts_keepalive_sent', {
        keepalive_number: count,
        elapsed_seconds: Math.round((Date.now() - genStart) / 1000),
      });
      Promise.resolve(callbacks.onStatus?.('Still generating audio...')).catch((error: unknown) => {
        logger.warn('tts_keepalive_failed', {
          error: error instanceof Error ? error.message : String(error),
          keepalive_number: count,
        });
        clearInterval(interval);
      });
    }, 15_000);
    return { interval, getCount: () => count };
  }

  private async generateVoiceResponse(
    org: string,
    userId: string,
    responses: string[],
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<{ audioKey: string } | null> {
    const genStart = Date.now();
    const combinedText = responses.join('\n\n');
    logger.log('audio_flow_generate_voice_start', {
      response_count: responses.length,
      combined_text_chars: combinedText.length,
      has_callbacks: !!callbacks,
    });

    const keepalive = callbacks ? this.startTtsKeepalive(callbacks, genStart, logger) : null;
    try {
      await callbacks?.onStatus?.('Generating audio response...');
      const synthesis = await synthesizeSpeech(this.env.OPENAI_API_KEY, combinedText, logger);
      const synthesisDoneAt = Date.now();

      const audioKey = generateAudioKey(org, userId);
      await uploadAudio(this.env.AUDIO_BUCKET, audioKey, synthesis.audio_bytes, logger);
      const uploadDoneAt = Date.now();

      logger.log('audio_flow_generate_voice_complete', {
        input_chars: synthesis.input_chars,
        synthesis_ms: synthesis.duration_ms,
        r2_upload_ms: uploadDoneAt - synthesisDoneAt,
        generate_voice_total_ms: uploadDoneAt - genStart,
        audio_bytes: synthesis.audio_bytes.byteLength,
        audio_key: audioKey,
        keepalives_sent: keepalive?.getCount() ?? 0,
      });
      return { audioKey };
    } catch (error) {
      logger.error('tts_generation_failed', error, {
        generate_voice_total_ms: Date.now() - genStart,
        combined_text_chars: combinedText.length,
        keepalives_sent: keepalive?.getCount() ?? 0,
      });
      return null;
    } finally {
      if (keepalive) clearInterval(keepalive.interval);
    }
  }

  // ── Orchestration helpers ─────────────────────────────────────────────────────

  private async tracedPhase<T>(
    ctx: { timing: TimingContext; logger: RequestLogger; startTime: number },
    phase: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const result = await timePhase(ctx.timing, phase, fn);
    ctx.logger.log('process_chat_phase', { phase, elapsed_ms: Date.now() - ctx.startTime });
    return result;
  }

  private async runOrchestration(
    messageText: string,
    options: Parameters<typeof orchestrate>[1]
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const result = await orchestrate(messageText, options);
    options.logger.log('phase_orchestration_complete', {
      response_count: result.responses.length,
      duration_ms: Date.now() - startTime,
    });
    return result;
  }

  // eslint-disable-next-line max-params -- opts builder, all params are necessary context
  private buildOrchOpts(
    body: ChatRequest,
    catalog: ReturnType<typeof buildToolCatalog>,
    history: ChatHistoryEntry[],
    preferences: UserPreferencesInternal,
    resolvedPromptValues: ReturnType<typeof resolvePromptOverrides>,
    memoryStore: JsonMemoryStore,
    formattedTOC: string | undefined,
    orgModes: { modes: PromptMode[] },
    activeModeName: string | undefined,
    audioContext: AudioContext,
    logger: RequestLogger,
    callbacks?: StreamCallbacks,
    groupContext?: GroupChatContext
  ): Parameters<typeof orchestrate>[1] {
    return {
      env: this.env,
      catalog,
      history,
      orgConfig: body._org_config ?? {},
      preferences: {
        response_language: preferences.response_language,
        first_interaction: preferences.first_interaction,
      },
      resolvedPromptValues,
      memoryStore,
      memoryTOC: formattedTOC || undefined,
      modeContext: this.buildModeContext(orgModes, activeModeName),
      audioContext,
      clientId: body.client_id,
      groupContext,
      isVoiceMessage: body.message_type === 'audio',
      logger,
      callbacks,
    };
  }

  private buildAudioContext(): AudioContext {
    const ctx: AudioContext = {
      audioRequested: false,
      requestAudio: () => {
        ctx.audioRequested = true;
      },
    };
    return ctx;
  }

  private buildModeContext(
    orgModes: { modes: PromptMode[] },
    activeModeName: string | undefined
  ): ModeContext {
    return {
      availableModes: orgModes.modes,
      activeModeName,
      setSelectedMode: async (name: string | null) => {
        if (name === null) {
          await this.state.storage.delete(SELECTED_MODE_KEY);
        } else {
          await this.state.storage.put(SELECTED_MODE_KEY, name);
        }
      },
    };
  }

  // ── Preferences / history / overrides / mode / memory handlers ────────────────

  private async handleGetPreferences(): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'get_preferences', async () => {
      const prefs = await this.getPreferences();
      const apiPrefs: UserPreferencesAPI = { response_language: prefs.response_language };
      return Response.json(apiPrefs);
    });
  }

  private async handleUpdatePreferences(request: Request): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'update_preferences', async () => {
      const updates = (await request.json()) as UpdatePreferencesRequest;

      if (updates.response_language !== undefined) {
        if (
          typeof updates.response_language !== 'string' ||
          !isValidLanguageCode(updates.response_language)
        ) {
          return Response.json(
            {
              error: 'Invalid response_language',
              message:
                'Must be a valid ISO 639-1 language code (2 lowercase letters, e.g., "en", "es", "fr")',
            },
            { status: 400 }
          );
        }
      }

      const current = await this.getPreferences();
      const updated: UserPreferencesInternal = {
        ...current,
        ...(updates.response_language !== undefined && {
          response_language: updates.response_language,
        }),
      };
      await this.updatePreferences(updated);

      const apiPrefs: UserPreferencesAPI = { response_language: updated.response_language };
      return Response.json(apiPrefs);
    });
  }

  private async handleGetHistory(url: URL): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'get_history', async () => {
      const requestedLimit = parseInt(
        url.searchParams.get('limit') ?? String(DEFAULT_ORG_CONFIG.max_history_storage),
        10
      );
      const limit = Math.min(requestedLimit, DEFAULT_ORG_CONFIG.max_history_storage);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const userId = url.searchParams.get('user_id') ?? '';

      const allHistory = await this.getHistory();
      const total = allHistory.length;
      const entries = allHistory.slice(offset, offset + limit).map((e) => ({
        ...e,
        created_at: e.timestamp ? new Date(e.timestamp).toISOString() : null,
        voice_audio_url: e.voice_audio_key ? audioKeyToUrl(e.voice_audio_key, url.origin) : null,
      }));

      const response: ChatHistoryResponse = {
        user_id: userId,
        entries,
        total_count: total,
        limit,
        offset,
      };
      return Response.json(response);
    });
  }

  private async handleDeleteHistory(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'delete_history',
      async () => {
        await this.state.storage.delete(HISTORY_KEY);
        return Response.json({ message: 'User history cleared' });
      },
      storageErrorResponse
    );
  }

  private async handleGetPromptOverrides(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'get_prompt_overrides',
      async () => {
        const overrides = await this.getPromptOverrides();
        return Response.json(overrides);
      },
      storageErrorResponse
    );
  }

  private async handleUpdatePromptOverrides(request: Request): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'update_prompt_overrides',
      async () => {
        const body = await request.json();
        const error = validatePromptOverrides(body);
        if (error) {
          return Response.json({ error }, { status: 400 });
        }
        const current = await this.getPromptOverrides();
        const merged = mergePromptOverrides(current, body as PromptOverrides);
        await this.updatePromptOverrides(merged);
        return Response.json(merged);
      },
      storageErrorResponse
    );
  }

  private async handleDeletePromptOverrides(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'delete_prompt_overrides',
      async () => {
        await this.state.storage.delete(PROMPT_OVERRIDES_KEY);
        return Response.json({ message: 'User prompt overrides cleared' });
      },
      storageErrorResponse
    );
  }

  private async handleGetMemory(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'get_memory',
      async () => {
        const store = new JsonMemoryStore(this.state.storage, this.getLogger());
        const { content, toc, entries } = await store.readAll();
        return Response.json({ content, toc, entries });
      },
      storageErrorResponse
    );
  }

  private async handleDeleteMemory(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'delete_memory',
      async () => {
        const store = new JsonMemoryStore(this.state.storage, this.getLogger());
        await store.clear();
        return Response.json({ message: 'User memory cleared' });
      },
      storageErrorResponse
    );
  }

  private async handleGetMode(): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'get_mode', async () => {
      const mode = await this.getSelectedMode();
      return Response.json({ mode: mode ?? null });
    });
  }

  private async handleSetMode(request: Request): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'set_mode', async () => {
      const body = (await request.json()) as Record<string, unknown>;
      const nameError = validateModeName(body.mode);
      if (nameError) {
        return Response.json({ error: nameError }, { status: 400 });
      }
      await this.state.storage.put(SELECTED_MODE_KEY, body.mode as string);
      return Response.json({ mode: body.mode, message: 'User mode updated' });
    });
  }

  private async handleDeleteMode(): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'delete_mode', async () => {
      await this.state.storage.delete(SELECTED_MODE_KEY);
      return Response.json({ mode: null, message: 'User mode cleared' });
    });
  }

  // ── Storage helpers ───────────────────────────────────────────────────────────

  private async getSelectedMode(): Promise<string | undefined> {
    return this.state.storage.get<string>(SELECTED_MODE_KEY);
  }

  private async getPromptOverrides(): Promise<PromptOverrides> {
    return (await this.state.storage.get<PromptOverrides>(PROMPT_OVERRIDES_KEY)) ?? {};
  }

  private async updatePromptOverrides(overrides: PromptOverrides): Promise<void> {
    await this.state.storage.put(PROMPT_OVERRIDES_KEY, overrides);
  }

  private async getHistory(): Promise<ChatHistoryEntry[]> {
    const history = await this.state.storage.get<ChatHistoryEntry[]>(HISTORY_KEY);
    return history ?? [];
  }

  private async addHistoryEntry(entry: ChatHistoryEntry, maxStorage: number): Promise<void> {
    const history = await this.getHistory();
    history.push(entry);
    const trimmed = history.slice(-maxStorage);
    await this.state.storage.put(HISTORY_KEY, trimmed);
  }

  private async getPreferences(): Promise<UserPreferencesInternal> {
    const prefs = await this.state.storage.get<UserPreferencesInternal>(PREFERENCES_KEY);
    return prefs ?? DEFAULT_PREFERENCES;
  }

  private async updatePreferences(preferences: UserPreferencesInternal): Promise<void> {
    await this.state.storage.put(PREFERENCES_KEY, preferences);
  }

  // ── Config helpers ────────────────────────────────────────────────────────────

  private getMaxQueueDepth(): number {
    return parseInt(this.env.MAX_QUEUE_DEPTH ?? '', 10) || DEFAULT_MAX_QUEUE_DEPTH;
  }

  private getMaxRetries(): number {
    return parseInt(this.env.QUEUE_MAX_RETRIES ?? '', 10) || DEFAULT_MAX_RETRIES;
  }
}
