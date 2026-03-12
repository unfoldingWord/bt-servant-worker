/**
 * Progress Callback Service
 *
 * Sends progress updates to webhook URLs for clients that can't use SSE (e.g., WhatsApp).
 * Accumulates text chunks and sends them on complete, with immediate status updates.
 */

import { ChatResponse, ProgressMode, StreamCallbacks } from '../../types/engine.js';
import { RequestLogger, safeAsync } from '../../utils/logger.js';

export interface ProgressCallbackConfig {
  url: string;
  user_id: string;
  message_key: string;
  token: string;
}

type CallbackPayloadType = 'status' | 'progress' | 'complete' | 'error';

interface CallbackPayload {
  type: CallbackPayloadType;
  user_id: string;
  message_key: string;
  timestamp: string;
  message?: string;
  text?: string;
  error?: string;
  voice_audio_base64?: string | null;
}

export class ProgressCallbackSender {
  private accumulatedText = '';
  private logger: RequestLogger | undefined;

  constructor(
    private config: ProgressCallbackConfig,
    logger?: RequestLogger
  ) {
    this.logger = logger;
  }

  async sendStatus(message: string): Promise<void> {
    await this.post({ type: 'status', message });
  }

  accumulateProgress(text: string): void {
    this.accumulatedText += text;
  }

  async sendProgress(): Promise<void> {
    if (this.accumulatedText) {
      await this.post({ type: 'progress', text: this.accumulatedText });
    }
  }

  async sendProgressDirect(text: string): Promise<void> {
    if (text) {
      await this.post({ type: 'progress', text });
    }
  }

  async sendComplete(text: string, voiceAudioBase64?: string | null): Promise<void> {
    await this.post({
      type: 'complete',
      ...(text ? { text } : {}),
      ...(voiceAudioBase64 ? { voice_audio_base64: voiceAudioBase64 } : {}),
    });
  }

  async sendError(error: string): Promise<void> {
    await this.post({ type: 'error', error });
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
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
    };
  }

  private logOutgoing(
    payload: Omit<CallbackPayload, 'user_id' | 'message_key' | 'timestamp'>,
    ctx: { type: string; user_id: string }
  ): void {
    const textLen = 'text' in payload ? ((payload.text as string)?.length ?? 0) : 0;
    const hasAudio = 'voice_audio_base64' in payload && !!payload.voice_audio_base64;
    this.logger?.log('webhook_send', {
      ...ctx,
      has_text: textLen > 0,
      text_length: textLen,
      has_audio: hasAudio,
    });
  }

  private async fetchWithTimeout(payload: CallbackPayload): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      return await fetch(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Engine-Token': this.config.token },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
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

  private schedulePeriodicSend(): void {
    if (this.timerId !== null || this.isComplete) return;
    const throttleMs = this.config.throttleSeconds * 1000;
    this.timerId = setTimeout(() => {
      this.timerId = null;
      if (!this.isComplete && this.accumulatedText !== this.lastSentText) {
        runSafe(this.logger, 'periodic_send_failed', () => this.sendProgress(this.accumulatedText));
        this.lastSentText = this.accumulatedText;
      }
      if (!this.isComplete) this.schedulePeriodicSend();
    }, throttleMs);
  }

  private checkSentenceBoundary(): void {
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

export function createWebhookCallbacks(
  sender: ProgressCallbackSender,
  logger: RequestLogger,
  config?: Partial<IncrementalProgressConfig>
): StreamCallbacks {
  const mode = config?.mode ?? DEFAULT_PROGRESS_MODE;
  const incrementalSender =
    mode === 'periodic' || mode === 'sentence'
      ? new IncrementalProgressSender(sender, logger, config)
      : null;

  // Track text already sent so iteration and complete callbacks only send deltas
  let lastSentText = '';

  const callbacks: StreamCallbacks = {
    onStatus: (message) => {
      runSafe(logger, 'webhook_status_failed', () => sender.sendStatus(message));
    },
    onProgress: (text) => {
      if (incrementalSender) {
        incrementalSender.accumulate(text);
      } else {
        sender.accumulateProgress(text);
      }
    },
    onComplete: (response: ChatResponse) => {
      incrementalSender?.complete();
      const fullText = response.responses.join('\n');
      const delta = fullText.slice(lastSentText.length);
      if (delta || response.voice_audio_base64) {
        runSafe(logger, 'webhook_complete_failed', () =>
          sender.sendComplete(delta, response.voice_audio_base64)
        );
      }
    },
    onError: (error) => {
      incrementalSender?.complete();
      runSafe(logger, 'webhook_error_failed', () => sender.sendError(error));
    },
  };

  if (mode === 'iteration') {
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
