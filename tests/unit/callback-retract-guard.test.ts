/**
 * #421 hard requirement (Ian, 2026-11-11): `retract` must never be POSTed to
 * a callback webhook. The gateways return 400 on an unknown event type.
 *
 * Two layers are pinned here:
 * 1. Wiring: no webhook callback set carries `onRetract`, so the orchestrator
 *    never enters stream-and-retract on the callback transport.
 * 2. Runtime: `ProgressCallbackSender` refuses any payload type outside
 *    status/progress/complete/error, logs it at error level, and sends nothing.
 *
 * Also pins #421 Q3: `periodic` and `sentence` are coerced to `iteration`
 * (with a warning) for one release.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { UserDO } from '../../src/durable-objects/user-do.js';
import {
  createWebhookCallbacks,
  ProgressCallbackSender,
  resolveProgressMode,
} from '../../src/services/progress/index.js';
import type { ChatRequest, ProgressMode, StreamCallbacks } from '../../src/types/engine.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { Env } from '../../src/config/types.js';

const GATEWAY_URL = 'https://gateway.example/progress-callback';

function mockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

interface UserDOInternals {
  buildWebhookCallbacks(body: ChatRequest, logger: RequestLogger): StreamCallbacks | undefined;
}

function createDO(): UserDOInternals {
  const state = {
    storage: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      setAlarm: vi.fn(async () => undefined),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
  const env = { DEFAULT_ORG: 'unfoldingWord', ENGINE_API_KEY: 'k' } as unknown as Env;
  return new UserDO(state, env) as unknown as UserDOInternals;
}

function callbackBody(mode?: ProgressMode, messageType: 'text' | 'audio' = 'text'): ChatRequest {
  return {
    client_id: 'whatsapp',
    user_id: 'u1',
    message: 'hi',
    message_type: messageType,
    progress_callback_url: GATEWAY_URL,
    message_key: 'k1',
    ...(mode ? { progress_mode: mode } : {}),
  } as ChatRequest;
}

describe('retract never reaches a callback webhook (#421)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each<ProgressMode | undefined>([undefined, 'iteration', 'complete', 'periodic', 'sentence'])(
    'the DO webhook callbacks carry no onRetract (progress_mode %s)',
    (mode) => {
      const callbacks = createDO().buildWebhookCallbacks(callbackBody(mode), mockLogger());
      expect(callbacks).toBeDefined();
      expect(callbacks).not.toHaveProperty('onRetract');
    }
  );

  it('voice callback turns carry no onRetract either', () => {
    const callbacks = createDO().buildWebhookCallbacks(
      callbackBody('iteration', 'audio'),
      mockLogger()
    );
    expect(callbacks).not.toHaveProperty('onRetract');
  });

  it('createWebhookCallbacks never sets onRetract', () => {
    const sender = new ProgressCallbackSender({
      url: GATEWAY_URL,
      user_id: 'u1',
      message_key: 'k1',
      token: 't',
    });
    for (const mode of ['iteration', 'complete'] as const) {
      expect(createWebhookCallbacks(sender, mockLogger(), { mode })).not.toHaveProperty(
        'onRetract'
      );
    }
  });
});

describe('ProgressCallbackSender runtime type guard (#421)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the sender refuses a retract payload at runtime: nothing is POSTed, an error is logged', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logger = mockLogger();
    const sender = new ProgressCallbackSender(
      { url: GATEWAY_URL, user_id: 'u1', message_key: 'k1', token: 't' },
      logger
    );
    // Reach the private wire method with a type the public API cannot produce.
    const post = (
      sender as unknown as { post(p: Record<string, unknown>): Promise<void> }
    ).post.bind(sender);
    await post({ type: 'retract', iteration: 0, chars: 5 });

    expect(fetchSpy).not.toHaveBeenCalled();
    const errors = (logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe('webhook_payload_type_refused');
    expect(errors[0]?.[2]).toEqual({ type: 'retract', user_id: 'u1' });
  });

  it('the sender still POSTs the four webhook types', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('ok', { status: 200 }));
    const sender = new ProgressCallbackSender(
      { url: GATEWAY_URL, user_id: 'u1', message_key: 'k1', token: 't' },
      mockLogger()
    );
    await sender.sendStatus({ key: 'status_processing', message: 'Processing' });
    await sender.sendProgressDirect('text');
    await sender.sendComplete('done');
    await sender.sendError('oops');
    const types = fetchSpy.mock.calls.map(
      ([, init]) => (JSON.parse(String(init?.body)) as { type: string }).type
    );
    expect(types).toEqual(['status', 'progress', 'complete', 'error']);
  });
});

describe('progress_mode coercion for one release (#421 Q3)', () => {
  it.each<ProgressMode>(['periodic', 'sentence'])(
    '%s runs as iteration, with a warning',
    (mode) => {
      const logger = mockLogger();
      expect(resolveProgressMode(mode, logger)).toBe('iteration');
      expect(logger.warn).toHaveBeenCalledWith('progress_mode_coerced', {
        requested: mode,
        applied: 'iteration',
        issue: 421,
      });
    }
  );

  it.each<ProgressMode | undefined>(['iteration', 'complete', undefined])(
    '%s is left alone, silently',
    (mode) => {
      const logger = mockLogger();
      expect(resolveProgressMode(mode, logger)).toBe(mode ?? 'iteration');
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );

  it('a periodic callback turn gets the iteration narration callback', () => {
    const logger = mockLogger();
    const callbacks = createDO().buildWebhookCallbacks(callbackBody('periodic'), logger);
    expect(callbacks?.onIterationComplete).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith('progress_mode_coerced', expect.anything());
  });
});
