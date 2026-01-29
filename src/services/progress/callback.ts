/**
 * Progress Callback Service
 *
 * Sends progress updates to webhook URLs for clients that can't use SSE (e.g., WhatsApp).
 * Accumulates text chunks and sends them on complete, with immediate status updates.
 */

import { ChatResponse, StreamCallbacks } from '../../types/engine.js';

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
      await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Engine-Token': this.config.token,
        },
        body: JSON.stringify(fullPayload),
      });
    } catch {
      // Fail silently - webhook failures shouldn't break the main flow
      // Logging would be done by the caller if needed
    }
  }
}

/**
 * Creates StreamCallbacks that send progress updates via webhook.
 * Text chunks are accumulated and sent on complete rather than per-chunk.
 */
export function createWebhookCallbacks(sender: ProgressCallbackSender): StreamCallbacks {
  return {
    onStatus: (message) => {
      void sender.sendStatus(message);
    },
    onProgress: (text) => {
      sender.accumulateProgress(text);
    },
    onComplete: (response: ChatResponse) => {
      void sender.sendComplete(response.responses.join('\n'));
    },
    onError: (error) => {
      void sender.sendError(error);
    },
  };
}
