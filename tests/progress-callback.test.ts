import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProgressCallbackSender,
  createWebhookCallbacks,
} from '../src/services/progress/callback.js';

const mockConfig = {
  url: 'https://example.com/webhook',
  user_id: 'user-123',
  message_key: 'msg-456',
  token: 'test-token',
};

function setupMocks() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response()));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
}

describe('ProgressCallbackSender.sendStatus', () => {
  beforeEach(setupMocks);

  it('sends status payload with correct headers', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    await sender.sendStatus('Processing your request...');

    expect(fetch).toHaveBeenCalledWith(mockConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Token': mockConfig.token,
      },
      body: JSON.stringify({
        type: 'status',
        message: 'Processing your request...',
        user_id: mockConfig.user_id,
        message_key: mockConfig.message_key,
        timestamp: '2024-01-15T12:00:00.000Z',
      }),
    });
  });
});

describe('ProgressCallbackSender.accumulateProgress', () => {
  beforeEach(setupMocks);

  it('accumulates text chunks', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    sender.accumulateProgress('Hello ');
    sender.accumulateProgress('world');
    sender.accumulateProgress('!');
    expect(sender.getAccumulatedText()).toBe('Hello world!');
  });

  it('starts with empty accumulated text', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    expect(sender.getAccumulatedText()).toBe('');
  });
});

describe('ProgressCallbackSender.sendProgress', () => {
  beforeEach(setupMocks);

  it('sends accumulated text', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    sender.accumulateProgress('Accumulated text');
    await sender.sendProgress();

    expect(fetch).toHaveBeenCalledWith(mockConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Token': mockConfig.token,
      },
      body: JSON.stringify({
        type: 'progress',
        text: 'Accumulated text',
        user_id: mockConfig.user_id,
        message_key: mockConfig.message_key,
        timestamp: '2024-01-15T12:00:00.000Z',
      }),
    });
  });

  it('does not send if no accumulated text', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    await sender.sendProgress();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('ProgressCallbackSender.sendComplete', () => {
  beforeEach(setupMocks);

  it('sends complete payload with text', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    await sender.sendComplete('Final response text');

    expect(fetch).toHaveBeenCalledWith(mockConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Token': mockConfig.token,
      },
      body: JSON.stringify({
        type: 'complete',
        text: 'Final response text',
        user_id: mockConfig.user_id,
        message_key: mockConfig.message_key,
        timestamp: '2024-01-15T12:00:00.000Z',
      }),
    });
  });
});

describe('ProgressCallbackSender.sendError', () => {
  beforeEach(setupMocks);

  it('sends error payload', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    await sender.sendError('Something went wrong');

    expect(fetch).toHaveBeenCalledWith(mockConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Token': mockConfig.token,
      },
      body: JSON.stringify({
        type: 'error',
        error: 'Something went wrong',
        user_id: mockConfig.user_id,
        message_key: mockConfig.message_key,
        timestamp: '2024-01-15T12:00:00.000Z',
      }),
    });
  });
});

describe('ProgressCallbackSender error handling', () => {
  it('fails silently when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const sender = new ProgressCallbackSender(mockConfig);
    await expect(sender.sendStatus('test')).resolves.toBeUndefined();
  });
});

describe('createWebhookCallbacks', () => {
  beforeEach(setupMocks);

  it('creates StreamCallbacks that use the sender', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender);

    expect(callbacks.onStatus).toBeDefined();
    expect(callbacks.onProgress).toBeDefined();
    expect(callbacks.onComplete).toBeDefined();
    expect(callbacks.onError).toBeDefined();
  });

  it('onProgress accumulates text without sending', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender);

    callbacks.onProgress('chunk1');
    callbacks.onProgress('chunk2');

    expect(fetch).not.toHaveBeenCalled();
    expect(sender.getAccumulatedText()).toBe('chunk1chunk2');
  });
});

describe('createWebhookCallbacks async operations', () => {
  beforeEach(setupMocks);

  it('onStatus sends status message', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender);
    callbacks.onStatus('Processing...');
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalled();
  });

  it('onComplete sends the final response', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender);
    const response = {
      responses: ['Response 1', 'Response 2'],
      response_language: 'en',
      voice_audio_base64: null,
      intent_processed: 'test',
      has_queued_intents: false,
    };
    callbacks.onComplete(response);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"Response 1\\nResponse 2"'),
      })
    );
  });

  it('onError sends error message', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender);
    callbacks.onError('Something failed');
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"error":"Something failed"'),
      })
    );
  });
});
