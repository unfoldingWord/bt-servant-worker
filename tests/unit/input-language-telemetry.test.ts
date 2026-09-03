/**
 * `input_language` telemetry (#404) — through the real UserDO.
 *
 * Drives `/chat/final` on a fresh Durable Object per test with the Anthropic
 * call intercepted at `globalThis.fetch` (tests/helpers/anthropic-capture.ts),
 * so every assertion roundtrips through real DO storage and the real
 * system-prompt builder:
 *
 *   - `input_language` on the completing response and the `chat_turn` record
 *   - the persisted preference (GET /preferences), which detection must never
 *     write, for any client
 *   - the `Respond in <code> when possible` line the model actually receives,
 *     which reflects the preference / hint and never the detection
 *
 * Product decision (2026-09-03): the user picks a reply language in the web
 * client and it sticks. The worker records what they wrote; it does not
 * follow it. These tests are the regression guard for that boundary.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatRequest } from '../../src/types/engine.js';
import type { OrgLanguages } from '../../src/types/languages.js';
import {
  buildChatBody,
  getPreferredLanguage,
  postChatFinalJson,
  putPreferredLanguage,
  setupAnthropicFetchCapture,
  type LogRecord,
} from '../helpers/anthropic-capture.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const PT_MESSAGE = 'Estou traduzindo o evangelho de Marcos para a minha língua materna.';
const PT_MESSAGE_2 = 'Precisamos de ajuda para entender esta passagem difícil.';
const EN_MESSAGE = 'I am translating the gospel of Mark into my mother tongue.';
const EN_MESSAGE_2 = 'Please summarize the chapter in three short sentences.';
const UNDETECTABLE_MESSAGE = 'João 3:16';

/** One published org language, so `@testlang` is a MATCHED trigger the classifier strips. */
const ORG_LANGUAGES: OrgLanguages = {
  languages: [
    { name: 'testlang', label: 'Test Language', document: '## Tone\nFormal.', published: true },
  ],
};

function buildBody(overrides: Partial<ChatRequest> & Pick<ChatRequest, 'message'>): ChatRequest {
  return buildChatBody(overrides, { client_id: 'web', user_id: 'telemetry-user' });
}

const chatTurns = (logs: LogRecord[]) => logs.filter((l) => l.event === 'chat_turn');

let stub: DurableObjectStub;
let captured: ReturnType<typeof setupAnthropicFetchCapture>;

beforeEach(() => {
  stub = env.USER_DO.get(env.USER_DO.newUniqueId());
  captured = setupAnthropicFetchCapture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('input_language on the completing response and the chat_turn record', () => {
  it('a Portuguese message records pt with a numeric confidence', async () => {
    const response = await postChatFinalJson(stub, buildBody({ message: PT_MESSAGE }));

    expect(response.input_language).toBe('pt');
    const turns = chatTurns(captured.logs);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.payload).toMatchObject({ client_id: 'web', input_language: 'pt' });
    expect(typeof turns[0]?.payload?.input_language_confidence).toBe('number');
  });

  it('undetectable input records "und" and a null confidence', async () => {
    const response = await postChatFinalJson(stub, buildBody({ message: UNDETECTABLE_MESSAGE }));

    expect(response.input_language).toBe('und');
    expect(chatTurns(captured.logs)[0]?.payload).toMatchObject({
      input_language: 'und',
      input_language_confidence: null,
    });
  });

  it('a trigger-only turn (@testlang) records "und": the detector sees the classifier-stripped text', async () => {
    const response = await postChatFinalJson(
      stub,
      buildBody({ message: '@testlang', _org_languages: ORG_LANGUAGES })
    );

    expect(response.input_language).toBe('und');
    expect(chatTurns(captured.logs)[0]?.payload).toMatchObject({ input_language: 'und' });
  });

  it('a matched trigger followed by prose detects the prose', async () => {
    const response = await postChatFinalJson(
      stub,
      buildBody({ message: `@testlang ${PT_MESSAGE}`, _org_languages: ORG_LANGUAGES })
    );

    expect(response.input_language).toBe('pt');
  });
});

describe('detection never writes response_language', () => {
  it.each([
    ['web', 'telemetry-user'],
    ['whatsapp', 'whatsapp:15551234567'],
  ])(
    '%s: two Portuguese turns leave the en preference and the system prompt untouched',
    async (clientId, userId) => {
      const body = (message: string) =>
        buildBody({ client_id: clientId, user_id: userId, message });
      expect(await getPreferredLanguage(stub)).toBe('en');

      const first = await postChatFinalJson(stub, body(PT_MESSAGE));
      const second = await postChatFinalJson(stub, body(PT_MESSAGE_2));

      expect(first.input_language).toBe('pt');
      expect(first.response_language).toBe('en');
      expect(second.response_language).toBe('en');
      expect(await getPreferredLanguage(stub)).toBe('en');
      expect(captured.calls).toHaveLength(2);
      for (const call of captured.calls) expect(call.system).not.toContain('Respond in');
      expect(chatTurns(captured.logs).map((t) => t.payload?.response_language)).toEqual([
        'en',
        'en',
      ]);
    }
  );

  it('a preference set via PUT /preferences sticks through English messages', async () => {
    await putPreferredLanguage(stub, 'pt');

    const first = await postChatFinalJson(stub, buildBody({ message: EN_MESSAGE }));
    const second = await postChatFinalJson(stub, buildBody({ message: EN_MESSAGE_2 }));

    expect(first.input_language).toBe('en');
    expect(first.response_language).toBe('pt');
    expect(second.response_language).toBe('pt');
    expect(await getPreferredLanguage(stub)).toBe('pt');
    expect(captured.calls[0]?.system).toContain('Respond in pt when possible');
    expect(captured.calls[1]?.system).toContain('Respond in pt when possible');
  });

  it('response_language_hint overrides the turn, is not persisted, and input_language still reports what was written', async () => {
    const response = await postChatFinalJson(
      stub,
      buildBody({ message: PT_MESSAGE, response_language_hint: 'fr' })
    );

    expect(response.response_language).toBe('fr');
    expect(response.input_language).toBe('pt');
    expect(captured.calls[0]?.system).toContain('Respond in fr when possible');
    expect(await getPreferredLanguage(stub)).toBe('en');
    expect(chatTurns(captured.logs)[0]?.payload).toMatchObject({
      response_language: 'fr',
      input_language: 'pt',
    });
  });
});
