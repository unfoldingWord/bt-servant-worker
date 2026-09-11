/**
 * #428: a voice turn (`message_type: 'audio'`) gets a voice reply whose TTS
 * already strips intermediate narration (`extractTtsResponses`). The webhook
 * text-progress channel must be suppressed symmetrically, or gateways render
 * the narration as interleaved text bubbles before the voice note.
 *
 * These tests pin the DO-side wiring: `buildWebhookCallbacks` passes
 * `suppressProgressText` iff the inbound message is audio, leaving text turns
 * untouched.
 */

import { describe, it, expect, vi } from 'vitest';
import { UserDO } from '../../src/durable-objects/user-do.js';
import type { ChatRequest, StreamCallbacks } from '../../src/types/engine.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { Env } from '../../src/config/types.js';

/** The private surface this test reaches into. */
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
  const env = {
    DEFAULT_ORG: 'unfoldingWord',
    ENGINE_API_KEY: 'test-engine-key',
  } as unknown as Env;
  return new UserDO(state, env) as unknown as UserDOInternals;
}

function mockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

const baseBody = {
  client_id: 'signal-gateway',
  user_id: 'u1',
  progress_callback_url: 'https://gateway.example/progress-callback',
  message_key: 'msg-1',
};

const audioBody: ChatRequest = {
  ...baseBody,
  message_type: 'audio',
  audio_base64: 'AAAA',
  audio_format: 'aac',
  progress_mode: 'iteration',
} as ChatRequest;

const textBody: ChatRequest = {
  ...baseBody,
  message_type: 'text',
  message: 'hi',
  progress_mode: 'iteration',
} as ChatRequest;

describe('#428 buildWebhookCallbacks voice-turn progress suppression', () => {
  it('audio turns get no iteration-narration callback even in iteration mode', () => {
    const userDo = createDO();
    const callbacks = userDo.buildWebhookCallbacks(audioBody, mockLogger());
    expect(callbacks).toBeDefined();
    expect(callbacks?.onIterationComplete).toBeUndefined();
    // Status and welcome channels stay wired for voice turns.
    expect(callbacks?.onStatus).toBeDefined();
    expect(callbacks?.onWelcome).toBeDefined();
  });

  it('text turns keep the iteration-narration callback (no regression)', () => {
    const userDo = createDO();
    const callbacks = userDo.buildWebhookCallbacks(textBody, mockLogger());
    expect(callbacks?.onIterationComplete).toBeDefined();
  });

  it('returns undefined without a callback URL or message key (unchanged guard)', () => {
    const userDo = createDO();
    const noUrl = { ...audioBody, progress_callback_url: undefined } as unknown as ChatRequest;
    expect(userDo.buildWebhookCallbacks(noUrl, mockLogger())).toBeUndefined();
  });
});
