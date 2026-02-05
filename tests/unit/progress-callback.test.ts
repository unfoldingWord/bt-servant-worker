import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createWebhookCallbacks,
  DEFAULT_PROGRESS_MODE,
  DEFAULT_THROTTLE_SECONDS,
  IncrementalProgressSender,
  MIN_THROTTLE_SECONDS,
  ProgressCallbackSender,
} from '../../src/services/progress/callback.js';

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

describe('ProgressCallbackSender.sendProgressDirect', () => {
  beforeEach(setupMocks);

  it('sends text directly without accumulation', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    await sender.sendProgressDirect('Direct text');

    expect(fetch).toHaveBeenCalledWith(mockConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Token': mockConfig.token,
      },
      body: JSON.stringify({
        type: 'progress',
        text: 'Direct text',
        user_id: mockConfig.user_id,
        message_key: mockConfig.message_key,
        timestamp: '2024-01-15T12:00:00.000Z',
      }),
    });
  });

  it('does not send if text is empty', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    await sender.sendProgressDirect('');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('IncrementalProgressSender', () => {
  beforeEach(setupMocks);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses default mode and throttle when no config provided', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender);
    expect(incremental.getMode()).toBe(DEFAULT_PROGRESS_MODE);
  });

  it('enforces minimum throttle seconds', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, {
      mode: 'periodic',
      throttleSeconds: 0.5,
    });
    // Internal throttle should be MIN_THROTTLE_SECONDS
    expect(incremental.getMode()).toBe('periodic');
  });

  it('accumulates text in sender', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, { mode: 'complete' });
    incremental.accumulate('Hello ');
    incremental.accumulate('world');
    expect(incremental.getAccumulatedText()).toBe('Hello world');
    expect(sender.getAccumulatedText()).toBe('Hello world');
  });
});

describe('IncrementalProgressSender periodic mode', () => {
  beforeEach(setupMocks);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends accumulated text after throttle interval', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, {
      mode: 'periodic',
      throttleSeconds: 2,
    });

    incremental.accumulate('Hello ');
    incremental.accumulate('world');

    // No immediate send
    expect(fetch).not.toHaveBeenCalled();

    // Advance timer past throttle
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"Hello world"'),
      })
    );
  });

  it('does not send duplicate content', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, {
      mode: 'periodic',
      throttleSeconds: 1,
    });

    incremental.accumulate('Hello');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // No new content, next timer should not send
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // New content arrives
    incremental.accumulate(' world');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops timer on complete', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, {
      mode: 'periodic',
      throttleSeconds: 1,
    });

    incremental.accumulate('Hello');
    incremental.complete();

    await vi.advanceTimersByTimeAsync(2000);
    // Should not have sent because complete() was called
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('IncrementalProgressSender sentence mode - punctuation types', () => {
  beforeEach(setupMocks);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends after sentence boundary with period', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, { mode: 'sentence' });

    incremental.accumulate('Hello world');
    expect(fetch).not.toHaveBeenCalled();

    incremental.accumulate('. ');
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"Hello world. "'),
      })
    );
  });

  it('sends after sentence boundary with exclamation', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, { mode: 'sentence' });

    incremental.accumulate('Hello world! ');
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"Hello world! "'),
      })
    );
  });

  it('sends after sentence boundary with question mark', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, { mode: 'sentence' });

    incremental.accumulate('Is this working? ');
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"Is this working? "'),
      })
    );
  });
});

describe('IncrementalProgressSender sentence mode - edge cases', () => {
  beforeEach(setupMocks);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not send mid-sentence', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, { mode: 'sentence' });

    incremental.accumulate('Hello world, this is a test');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('handles multiple sentences', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, { mode: 'sentence' });

    incremental.accumulate('First sentence. ');
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);

    incremental.accumulate('Second sentence. ');
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sends at end of string for sentence end', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const incremental = new IncrementalProgressSender(sender, { mode: 'sentence' });

    incremental.accumulate('Done.');
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"Done."'),
      })
    );
  });
});

describe('createWebhookCallbacks iteration mode', () => {
  beforeEach(setupMocks);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to iteration mode', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender);
    expect(callbacks.onIterationComplete).toBeDefined();
  });

  it('iteration mode sends on iteration complete', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender, { mode: 'iteration' });

    callbacks.onIterationComplete?.('Iteration response');
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"Iteration response"'),
      })
    );
  });
});

describe('createWebhookCallbacks mode callback availability', () => {
  beforeEach(setupMocks);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('complete mode does not have iteration callback', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender, { mode: 'complete' });
    expect(callbacks.onIterationComplete).toBeUndefined();
  });

  it('periodic mode does not have iteration callback', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender, { mode: 'periodic' });
    expect(callbacks.onIterationComplete).toBeUndefined();
  });

  it('sentence mode does not have iteration callback', () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender, { mode: 'sentence' });
    expect(callbacks.onIterationComplete).toBeUndefined();
  });
});

describe('createWebhookCallbacks periodic and sentence modes', () => {
  beforeEach(setupMocks);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('periodic mode schedules sends', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender, {
      mode: 'periodic',
      throttleSeconds: 1,
    });

    callbacks.onProgress('chunk1');
    callbacks.onProgress('chunk2');

    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"chunk1chunk2"'),
      })
    );
  });

  it('sentence mode sends on sentence boundaries', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender, { mode: 'sentence' });

    callbacks.onProgress('This is a sentence. ');
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"This is a sentence. "'),
      })
    );
  });
});

describe('createWebhookCallbacks complete mode and cleanup', () => {
  beforeEach(setupMocks);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('complete mode only sends on complete', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender, { mode: 'complete' });

    callbacks.onProgress('chunk1');
    callbacks.onProgress('chunk2');
    await vi.runAllTimersAsync();

    expect(fetch).not.toHaveBeenCalled();

    callbacks.onComplete({
      responses: ['Final response'],
      response_language: 'en',
      voice_audio_base64: null,
    });
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"text":"Final response"'),
      })
    );
  });

  it('cleans up timer on error', async () => {
    const sender = new ProgressCallbackSender(mockConfig);
    const callbacks = createWebhookCallbacks(sender, {
      mode: 'periodic',
      throttleSeconds: 5,
    });

    callbacks.onProgress('chunk');
    callbacks.onError('Something went wrong');

    // Timer should be cleared, no periodic send should happen
    await vi.advanceTimersByTimeAsync(5000);

    // Only the error call should have been made
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      mockConfig.url,
      expect.objectContaining({
        body: expect.stringContaining('"error":"Something went wrong"'),
      })
    );
  });
});

describe('Progress mode constants', () => {
  it('exports correct default values', () => {
    expect(DEFAULT_PROGRESS_MODE).toBe('iteration');
    expect(DEFAULT_THROTTLE_SECONDS).toBe(5);
    expect(MIN_THROTTLE_SECONDS).toBe(1);
  });
});
