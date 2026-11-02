/**
 * Progress Callback Service
 *
 * Sends progress updates to webhook URLs for clients that can't use SSE (e.g., WhatsApp).
 * Accumulates text chunks and sends them on complete, with immediate status updates.
 */

import { Attachment, ChatResponse, ProgressMode, StreamCallbacks } from '../../types/engine.js';
import type { StatusKey, StatusUpdate } from '../../i18n/ui-strings.js';
import { releaseBody } from '../../utils/http.js';
import { RequestLogger, safeAsync } from '../../utils/logger.js';
import { countMetric } from '../telemetry/index.js';

export interface ProgressCallbackConfig {
  url: string;
  user_id: string;
  message_key: string;
  token: string;
  /** Group/supergroup chat ID (present only for group chats). */
  chat_id?: string;
  /** Thread ID within a supergroup (present only for threaded chats). */
  thread_id?: string;
}

type CallbackPayloadType = 'status' | 'progress' | 'complete' | 'error';

/**
 * Internal payload shape sent over the wire. Must stay in sync with the
 * exported `ProgressCallback` contract in `src/types/engine.ts` — that's
 * the public type consumers (whatsapp gateway, etc.) model against.
 */
interface CallbackPayload {
  type: CallbackPayloadType;
  user_id: string;
  message_key: string;
  timestamp: string;
  /** Stable status identifier — `type: 'status'` only (#405). */
  key?: StatusKey;
  /** Localized status text — `type: 'status'` only. */
  message?: string;
  text?: string;
  error?: string;
  voice_audio_base64?: string | null;
  voice_audio_url?: string | null;
  /**
   * Tool-produced artifacts (e.g., generated PDFs). Forwarded verbatim from
   * ChatResponse.attachments so callback consumers can render artifacts on
   * the same final event that delivers the text.
   */
  attachments?: Attachment[];
  /**
   * #392: the turn just appended to the stored thread and the resulting
   * length — `type: 'complete'` only, and ONLY when the request supplied
   * `history`. Forwarded verbatim from ChatResponse so a callback client can
   * append the server-produced turn to its own copy.
   */
  history_entry?: ChatResponse['history_entry'];
  history_length?: number;
  /** Group/supergroup chat ID (present only for group chats). */
  chat_id?: string;
  /** Thread ID within a supergroup (present only for threaded chats). */
  thread_id?: string;
}

/** The #392 receipt fields of a ChatResponse, as a unit. */
export type HistoryReceipt = Pick<ChatResponse, 'history_entry' | 'history_length'>;

/**
 * Extract the #392 receipt from a response, or null when the request did not
 * supply `history` (both fields are absent together by construction).
 */
export function historyReceiptOf(response: ChatResponse): HistoryReceipt | null {
  if (response.history_length === undefined || response.history_entry === undefined) return null;
  return { history_entry: response.history_entry, history_length: response.history_length };
}

export class ProgressCallbackSender {
  private accumulatedText = '';
  private logger: RequestLogger | undefined;
  // #428: non-terminal POSTs in flight. Terminal sends (`complete`/`error`)
  // await these so a slow progress/status POST can never reach the gateway
  // after the final message — gateways deliver callbacks in arrival order.
  private pending = new Set<Promise<void>>();

  constructor(
    private config: ProgressCallbackConfig,
    logger?: RequestLogger
  ) {
    this.logger = logger;
  }

  private track(promise: Promise<void>): Promise<void> {
    this.pending.add(promise);
    const remove = () => this.pending.delete(promise);
    promise.then(remove, remove);
    return promise;
  }

  private async awaitPendingSends(terminalType: 'complete' | 'error'): Promise<void> {
    if (this.pending.size === 0) return;
    const waitStart = Date.now();
    const waitedCount = this.pending.size;
    // allSettled, never all: pending failures are already logged in post()
    // and must not block the terminal event.
    await Promise.allSettled([...this.pending]);
    this.logger?.log('webhook_complete_waited', {
      terminal_type: terminalType,
      waited_count: waitedCount,
      wait_ms: Date.now() - waitStart,
      user_id: this.config.user_id,
    });
  }

  async sendStatus(status: StatusUpdate): Promise<void> {
    await this.track(this.post({ type: 'status', ...status }));
  }

  accumulateProgress(text: string): void {
    this.accumulatedText += text;
  }

  async sendProgress(): Promise<void> {
    if (this.accumulatedText) {
      await this.track(this.post({ type: 'progress', text: this.accumulatedText }));
    }
  }

  async sendProgressDirect(text: string): Promise<void> {
    if (text) {
      await this.track(this.post({ type: 'progress', text }));
    }
  }

  async sendComplete(
    text: string,
    voiceAudioUrl?: string | null,
    voiceAudioBase64?: string | null,
    attachments?: Attachment[] | null,
    historyReceipt?: HistoryReceipt | null
  ): Promise<void> {
    await this.awaitPendingSends('complete');
    await this.post({
      type: 'complete',
      ...(text ? { text } : {}),
      ...(voiceAudioUrl ? { voice_audio_url: voiceAudioUrl } : {}),
      ...(voiceAudioBase64 ? { voice_audio_base64: voiceAudioBase64 } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      // #392: present only when the request supplied `history`.
      ...(historyReceipt ?? {}),
    });
  }

  async sendError(error: string): Promise<void> {
    await this.awaitPendingSends('error');
    await this.post({ type: 'error', error });
  }

  /**
   * Deliver a one-time mode first-contact welcome (#311) as its own webhook
   * message, ahead of the model's answer. Sent as a `progress` payload so the
   * gateway renders it as a standalone message — exactly how iteration deltas
   * arrive — with zero gateway changes.
   *
   * Unlike every other send here this does NOT swallow failures: it awaits the
   * POST and THROWS on a network error or non-2xx status. The caller writes the
   * `mode_welcomed` flag only after this resolves, so a failed delivery leaves
   * the flag unset and the welcome re-emits on the retry. A rare double-send
   * beats a permanent skip. It deliberately does not touch the progress
   * accumulator or the iteration/complete delta cursor, so the model's own
   * streamed deltas keep their prefix invariant.
   */
  async sendWelcome(text: string): Promise<void> {
    if (!text) return;
    const payload = this.buildPayload({ type: 'progress', text });
    const ctx = { type: 'welcome', user_id: this.config.user_id };
    this.logger?.log('webhook_send', {
      ...ctx,
      has_text: true,
      text_length: text.length,
      has_audio: false,
      attachment_count: 0,
    });
    const response = await this.fetchWithTimeout(payload);
    this.logger?.log('webhook_response', { ...ctx, status: response.status });
    countMetric('progress_webhook_total', {
      type: 'welcome',
      status: response.ok ? 'success' : 'http_error',
      status_code: response.status,
    });
    if (!response.ok) {
      this.logger?.warn('webhook_failure', {
        url: this.config.url,
        status: response.status,
        ...ctx,
      });
      throw new Error(`welcome webhook returned HTTP ${response.status}`);
    }
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  /** Roll the accumulator back to text that was actually posted (#421). */
  replaceAccumulated(text: string): void {
    this.accumulatedText = text;
  }

  private async post(
    payload: Omit<CallbackPayload, 'user_id' | 'message_key' | 'timestamp'>
  ): Promise<void> {
    const fullPayload = this.buildPayload(payload);
    const ctx = { type: payload.type, user_id: this.config.user_id };
    this.logOutgoing(payload, ctx);

    try {
      const response = await this.fetchWithTimeout(fullPayload);
      this.logger?.log('webhook_response', { ...ctx, status: response.status });
      countMetric('progress_webhook_total', {
        type: payload.type,
        status: response.ok ? 'success' : 'http_error',
        status_code: response.status,
      });
      if (!response.ok) {
        this.logger?.warn('webhook_failure', {
          url: this.config.url,
          status: response.status,
          ...ctx,
        });
      }
    } catch (error) {
      // Non-blocking: webhook failures shouldn't break main flow
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      countMetric('progress_webhook_total', {
        type: payload.type,
        status: 'error',
        error_name: error instanceof Error ? error.name : 'Error',
      });
      this.logger?.error('webhook_failure', error, {
        url: this.config.url,
        is_timeout: isTimeout,
        ...ctx,
      });
    }
  }

  private buildPayload(
    payload: Omit<CallbackPayload, 'user_id' | 'message_key' | 'timestamp'>
  ): CallbackPayload {
    return {
      ...payload,
      user_id: this.config.user_id,
      message_key: this.config.message_key,
      timestamp: new Date().toISOString(),
      ...(this.config.chat_id ? { chat_id: this.config.chat_id } : {}),
      ...(this.config.thread_id ? { thread_id: this.config.thread_id } : {}),
    };
  }

  private logOutgoing(
    payload: Omit<CallbackPayload, 'user_id' | 'message_key' | 'timestamp'>,
    ctx: { type: string; user_id: string }
  ): void {
    const textLen = 'text' in payload ? ((payload.text as string)?.length ?? 0) : 0;
    const hasAudio =
      ('voice_audio_url' in payload && !!payload.voice_audio_url) ||
      ('voice_audio_base64' in payload && !!payload.voice_audio_base64);
    const attachmentCount =
      'attachments' in payload && Array.isArray(payload.attachments)
        ? payload.attachments.length
        : 0;
    this.logger?.log('webhook_send', {
      ...ctx,
      has_text: textLen > 0,
      text_length: textLen,
      has_audio: hasAudio,
      attachment_count: attachmentCount,
    });
  }

  /**
   * POST one payload to the gateway. Callers use only the status, so the body is
   * released here: an unread body holds the connection open (see releaseBody), and
   * a WhatsApp turn posts several progress messages.
   */
  private async fetchWithTimeout(payload: CallbackPayload): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Engine-Token': this.config.token },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      releaseBody(response, (error) =>
        this.logger?.warn('webhook_body_release_failed', {
          error: error.message,
          type: payload.type,
          status: response.status,
        })
      );
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/** Default progress mode */
export const DEFAULT_PROGRESS_MODE: ProgressMode = 'iteration';

/** Default throttle for periodic mode */
export const DEFAULT_THROTTLE_SECONDS = 5;

/** Minimum throttle to prevent overwhelming callback endpoint */
export const MIN_THROTTLE_SECONDS = 1;

export interface IncrementalProgressConfig {
  mode: ProgressMode;
  throttleSeconds: number;
  /**
   * #428: suppress every intermediate `progress` text send (iteration
   * narration, periodic/sentence deltas) while keeping `status`, `welcome`,
   * and the terminal `complete`/`error` events. Set for voice turns, whose
   * TTS already strips intermediate narration (`extractTtsResponses`) —
   * without this the same narration reaches the user as interleaved text
   * bubbles before the voice note.
   */
  suppressProgressText?: boolean;
}

/**
 * Handles incremental progress sending for periodic and sentence modes.
 * Manages timer scheduling and sentence boundary detection.
 */
export class IncrementalProgressSender {
  private accumulatedText = '';
  private lastSentText = '';
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private isComplete = false;
  /**
   * While held, a due throttle records a snapshot and does not post. The
   * orchestrator releases the snapshot only when the round ends the turn,
   * or discards it when the round calls a tool (#421).
   */
  private hold = false;
  private overdue = false;
  private overdueSnapshot: string | null = null;
  private config: IncrementalProgressConfig;
  private logger: RequestLogger;

  constructor(
    private sender: ProgressCallbackSender,
    logger: RequestLogger,
    config?: Partial<IncrementalProgressConfig>
  ) {
    this.config = {
      mode: config?.mode ?? DEFAULT_PROGRESS_MODE,
      throttleSeconds: Math.max(
        config?.throttleSeconds ?? DEFAULT_THROTTLE_SECONDS,
        MIN_THROTTLE_SECONDS
      ),
    };
    this.logger = logger;
  }

  getMode(): ProgressMode {
    return this.config.mode;
  }

  accumulate(text: string): void {
    this.accumulatedText += text;
    this.sender.accumulateProgress(text);

    if (this.config.mode === 'periodic') {
      this.schedulePeriodicSend();
    } else if (this.config.mode === 'sentence') {
      this.checkSentenceBoundary();
    }
  }

  /** Start holding posts. Deltas may still accumulate and arm the throttle. */
  holdSends(): void {
    this.hold = true;
  }

  /**
   * The round ended the turn. A throttle that already elapsed posts only the
   * snapshot from that moment. Otherwise sentence mode flushes a finished
   * sentence now, and a still-pending periodic timer is left for `complete`
   * to cancel when it wins the race.
   */
  releaseSends(): void {
    this.hold = false;
    if (this.overdue && this.overdueSnapshot && this.overdueSnapshot !== this.lastSentText) {
      const snapshot = this.overdueSnapshot;
      this.overdue = false;
      this.overdueSnapshot = null;
      this.clearTimer();
      runSafe(this.logger, 'periodic_send_failed', () => this.sendProgress(snapshot));
      this.lastSentText = snapshot;
      return;
    }
    this.overdue = false;
    this.overdueSnapshot = null;
    if (this.config.mode === 'sentence') this.checkSentenceBoundary();
  }

  /** The round called a tool. Drop unsent text so it cannot become progress. */
  discardUnsent(): void {
    this.hold = false;
    this.overdue = false;
    this.overdueSnapshot = null;
    this.accumulatedText = this.lastSentText;
    this.sender.replaceAccumulated(this.lastSentText);
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timerId === null) return;
    clearTimeout(this.timerId);
    this.timerId = null;
  }

  private schedulePeriodicSend(): void {
    if (this.timerId !== null || this.isComplete) return;
    const throttleMs = this.config.throttleSeconds * 1000;
    this.timerId = setTimeout(() => {
      this.timerId = null;
      if (this.isComplete) return;
      if (this.hold) {
        // First time the throttle elapses during this round. Later ticks must
        // not move the snapshot forward, or `complete` would have nothing left.
        if (!this.overdue && this.accumulatedText !== this.lastSentText) {
          this.overdue = true;
          this.overdueSnapshot = this.accumulatedText;
        }
        return;
      }
      if (this.accumulatedText !== this.lastSentText) {
        runSafe(this.logger, 'periodic_send_failed', () => this.sendProgress(this.accumulatedText));
        this.lastSentText = this.accumulatedText;
      }
      if (!this.isComplete) this.schedulePeriodicSend();
    }, throttleMs);
  }

  private checkSentenceBoundary(): void {
    if (this.hold) return;
    const unsent = this.accumulatedText.slice(this.lastSentText.length);
    // Match sentence-ending punctuation followed by space or end of string.
    // Known limitations: May incorrectly trigger on abbreviations (Dr. Smith),
    // decimal numbers (3.14), or ellipsis (...). A more sophisticated sentence
    // detector would be needed for these edge cases, but for progress callbacks
    // occasional false positives are acceptable.
    const sentenceEndPattern = /[.!?](?:\s|$)/g;
    let lastMatch: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;

    while ((match = sentenceEndPattern.exec(unsent)) !== null) {
      lastMatch = match;
    }

    if (lastMatch) {
      // Send up to and including the matched punctuation and whitespace
      const endIndex = this.lastSentText.length + lastMatch.index + lastMatch[0].length;
      const textToSend = this.accumulatedText.slice(0, endIndex);

      if (textToSend !== this.lastSentText) {
        runSafe(this.logger, 'sentence_send_failed', () => this.sendProgress(textToSend));
        this.lastSentText = textToSend;
      }
    }
  }

  private async sendProgress(text: string): Promise<void> {
    if (text) {
      await this.sender.sendProgressDirect(text);
    }
  }

  complete(): void {
    this.isComplete = true;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  getLastSentText(): string {
    return this.lastSentText;
  }
}

/**
 * Creates StreamCallbacks that send progress updates via webhook.
 * Text chunks are accumulated and sent based on the configured mode.
 *
 * @param sender - The underlying sender for webhook calls
 * @param config - Optional configuration for incremental progress
 */
/** Run an async callback safely — errors are logged via the structured logger. */
function runSafe(logger: RequestLogger, event: string, fn: () => Promise<unknown>) {
  safeAsync(logger, event, fn);
}

function buildOnComplete(
  sender: ProgressCallbackSender,
  logger: RequestLogger,
  incrementalSender: IncrementalProgressSender | null,
  getLastSentText: () => string
) {
  return (response: ChatResponse) => {
    incrementalSender?.complete();
    const fullText = response.responses.join('\n');
    const delta = fullText.slice(getLastSentText().length);
    const hasAttachments = !!response.attachments && response.attachments.length > 0;
    // #392: a client that supplied `history` needs the receipt even when the
    // text already streamed as progress and the complete carries no delta.
    const receipt = historyReceiptOf(response);
    if (
      !delta &&
      !response.voice_audio_url &&
      !response.voice_audio_base64 &&
      !hasAttachments &&
      !receipt
    ) {
      return;
    }
    runSafe(logger, 'webhook_complete_failed', () =>
      sender.sendComplete(
        delta,
        response.voice_audio_url,
        response.voice_audio_base64,
        response.attachments,
        receipt
      )
    );
  };
}

function attachHoldProgress(
  callbacks: StreamCallbacks,
  sender: IncrementalProgressSender | null
): void {
  if (!sender) return;
  callbacks.holdProgress = (action) => {
    if (action === 'hold') sender.holdSends();
    else if (action === 'release') sender.releaseSends();
    else sender.discardUnsent();
  };
}

export function createWebhookCallbacks(
  sender: ProgressCallbackSender,
  logger: RequestLogger,
  config?: Partial<IncrementalProgressConfig>
): StreamCallbacks {
  const mode = config?.mode ?? DEFAULT_PROGRESS_MODE;
  const suppressProgressText = config?.suppressProgressText === true;
  const incrementalSender =
    (mode === 'periodic' || mode === 'sentence') && !suppressProgressText
      ? new IncrementalProgressSender(sender, logger, config)
      : null;

  // Track text already sent so iteration and complete callbacks only send deltas
  let lastSentText = '';

  const callbacks: StreamCallbacks = {
    onStatus: (status) => {
      // In 'complete' mode the caller only wants the final completion event.
      // The synchronous 202 response has already signaled "request received",
      // so a status webhook POST would be noise. Matches the docs on
      // ProgressMode.'complete' ("Legacy behavior - only send on completion").
      if (mode === 'complete') return;
      runSafe(logger, 'webhook_status_failed', () => sender.sendStatus(status));
    },
    onProgress: (text) => {
      if (incrementalSender) {
        incrementalSender.accumulate(text);
      } else {
        sender.accumulateProgress(text);
      }
    },
    // Sentence and periodic modes track what they already POSTed on the
    // sender, not on the iteration cursor. Complete must send only the
    // remainder, or the final answer arrives twice (#421).
    onComplete: buildOnComplete(
      sender,
      logger,
      incrementalSender,
      () => incrementalSender?.getLastSentText() ?? lastSentText
    ),
    onError: (error) => {
      incrementalSender?.complete();
      runSafe(logger, 'webhook_error_failed', () => sender.sendError(error));
    },
    // #311: the welcome is its own message, sent before the model runs. It
    // rejects on failure (unlike the other callbacks, which log-and-continue)
    // so the DO withholds the mode_welcomed flag and re-emits on retry.
    onWelcome: (text) => sender.sendWelcome(text),
  };

  attachHoldProgress(callbacks, incrementalSender);

  if (mode === 'iteration' && !suppressProgressText) {
    callbacks.onIterationComplete = (text) => {
      const delta = text.slice(lastSentText.length);
      if (delta) {
        lastSentText = text;
        runSafe(logger, 'webhook_iteration_failed', () => sender.sendProgressDirect(delta));
      }
    };
  }

  return callbacks;
}
