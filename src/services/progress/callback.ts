/**
 * Progress Callback Service
 *
 * Sends progress updates to webhook URLs for clients that can't use SSE (e.g., WhatsApp).
 * Accumulates text chunks and sends them on complete, with immediate status updates.
 */

import { ChatResponse, ProgressMode, StreamCallbacks } from '../../types/engine.js';

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
}

export class ProgressCallbackSender {
  private accumulatedText = '';

  constructor(private config: ProgressCallbackConfig) {}

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

  async sendComplete(text: string): Promise<void> {
    await this.post({ type: 'complete', text });
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
    const fullPayload: CallbackPayload = {
      ...payload,
      user_id: this.config.user_id,
      message_key: this.config.message_key,
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Engine-Token': this.config.token,
        },
        body: JSON.stringify(fullPayload),
      });

      if (!response.ok) {
        console.error('[webhook_failure]', {
          url: this.config.url,
          status: response.status,
          user_id: this.config.user_id,
        });
      }
    } catch (error) {
      // Non-blocking: webhook failures shouldn't break main flow
      console.error('[webhook_failure]', {
        url: this.config.url,
        error: error instanceof Error ? error.message : 'Unknown error',
        user_id: this.config.user_id,
      });
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

  constructor(
    private sender: ProgressCallbackSender,
    config?: Partial<IncrementalProgressConfig>
  ) {
    this.config = {
      mode: config?.mode ?? DEFAULT_PROGRESS_MODE,
      throttleSeconds: Math.max(
        config?.throttleSeconds ?? DEFAULT_THROTTLE_SECONDS,
        MIN_THROTTLE_SECONDS
      ),
    };
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
        void this.sendProgress(this.accumulatedText);
        this.lastSentText = this.accumulatedText;
      }
      if (!this.isComplete) this.schedulePeriodicSend();
    }, throttleMs);
  }

  private checkSentenceBoundary(): void {
    const unsent = this.accumulatedText.slice(this.lastSentText.length);
    // Match sentence-ending punctuation followed by space or end of string
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
        void this.sendProgress(textToSend);
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
export function createWebhookCallbacks(
  sender: ProgressCallbackSender,
  config?: Partial<IncrementalProgressConfig>
): StreamCallbacks {
  const mode = config?.mode ?? DEFAULT_PROGRESS_MODE;
  const incrementalSender =
    mode === 'periodic' || mode === 'sentence'
      ? new IncrementalProgressSender(sender, config)
      : null;

  const callbacks: StreamCallbacks = {
    onStatus: (message) => {
      void sender.sendStatus(message);
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
      void sender.sendComplete(response.responses.join('\n'));
    },
    onError: (error) => {
      incrementalSender?.complete();
      void sender.sendError(error);
    },
  };

  if (mode === 'iteration') {
    callbacks.onIterationComplete = (text) => {
      void sender.sendProgressDirect(text);
    };
  }

  return callbacks;
}
