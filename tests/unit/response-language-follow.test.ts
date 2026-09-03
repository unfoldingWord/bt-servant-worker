/**
 * response_language auto-follow (#404) — through the real UserDO.
 *
 * Drives `/chat/final` on a fresh Durable Object per test with the Anthropic
 * call intercepted at `globalThis.fetch` (the same seam
 * tests/e2e/language-document-injection.test.ts uses), so every assertion
 * here roundtrips through real DO storage and the real system-prompt builder:
 *
 *   - the persisted preference (GET /preferences)
 *   - the `response_language` / `input_language` echoed on the completing response
 *   - the `Respond in <code> when possible` line the model actually receives
 *   - the `chat_turn` / `response_language_auto_updated` records operators see
 *
 * The pure hysteresis rule (`decideResponseLanguageFollow`) is pinned
 * separately at the bottom so each branch has a one-line, mock-free test.
 */

/* eslint-disable max-lines-per-function */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ChatResponse } from '../../src/types/engine.js';
import {
  AUTO_FOLLOW_CLIENTS,
  decideResponseLanguageFollow,
} from '../../src/durable-objects/user-do.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const ANTHROPIC_HOST = 'api.anthropic.com';

const PT_MESSAGE = 'Estou traduzindo o evangelho de Marcos para a minha língua materna.';
const PT_MESSAGE_2 = 'Precisamos de ajuda para entender esta passagem difícil.';
const EN_MESSAGE = 'I am translating the gospel of Mark into my mother tongue.';
const EN_MESSAGE_2 = 'We need help understanding this difficult passage.';
const UNDETECTABLE_MESSAGE = 'João 3:16';

interface LogRecord {
  event: string;
  payload: Record<string, unknown>;
}

function buildBody(overrides: Partial<ChatRequest> & Pick<ChatRequest, 'message'>): ChatRequest {
  return {
    client_id: 'web',
    user_id: 'follow-user',
    message_type: 'text',
    ...overrides,
  };
}

async function readMockRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request) return input.clone().text();
  return '';
}

function renderSystem(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map((block) => (block as { text?: string }).text ?? '').join('');
}

/** Parse the JSON line the request logger writes; keep non-JSON lines as free text. */
function parseLogLine(raw: unknown): LogRecord {
  if (typeof raw !== 'string') return { event: String(raw), payload: {} };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { event: typeof parsed.event === 'string' ? parsed.event : raw, payload: parsed };
  } catch {
    // Not a structured log line (some other console.log caller) — keep it as text
    // so a stray line is still visible to the test rather than silently dropped.
    return { event: raw, payload: {} };
  }
}

function setupCapture(): { systems: string[]; logs: LogRecord[] } {
  const systems: string[] = [];
  const logs: LogRecord[] = [];

  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);

  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes(ANTHROPIC_HOST)) return realFetch(input, init);
    const rawBody = await readMockRequestBody(input, init);
    const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    systems.push(renderSystem(parsed.system));
    return new Response(
      JSON.stringify({
        id: `msg_${systems.length}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-test',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: 'ok' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(parseLogLine(args[0]));
  });

  return { systems, logs };
}

async function postChatFinal(
  stub: DurableObjectStub,
  body: ChatRequest
): Promise<ChatResponse & { message_id: string }> {
  const response = await stub.fetch('http://fake-host/chat/final', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ChatResponse & { message_id: string };
}

async function getPreferredLanguage(stub: DurableObjectStub): Promise<string> {
  const response = await stub.fetch('http://fake-host/preferences');
  const data = (await response.json()) as { response_language: string };
  return data.response_language;
}

async function putPreferredLanguage(stub: DurableObjectStub, code: string): Promise<void> {
  const response = await stub.fetch('http://fake-host/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_language: code }),
  });
  expect(response.status).toBe(200);
}

const autoUpdates = (logs: LogRecord[]) =>
  logs.filter((l) => l.event === 'response_language_auto_updated');
const chatTurns = (logs: LogRecord[]) => logs.filter((l) => l.event === 'chat_turn');

describe('response_language auto-follow — web client', () => {
  let stub: DurableObjectStub;
  let captured: ReturnType<typeof setupCapture>;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    captured = setupCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a Portuguese message flips en → pt, echoes pt on the completing response, and logs once', async () => {
    expect(await getPreferredLanguage(stub)).toBe('en');

    const response = await postChatFinal(stub, buildBody({ message: PT_MESSAGE }));

    expect(response.response_language).toBe('pt');
    expect(response.input_language).toBe('pt');
    expect(await getPreferredLanguage(stub)).toBe('pt');

    const updates = autoUpdates(captured.logs);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toMatchObject({
      client_id: 'web',
      old_language: 'en',
      new_language: 'pt',
    });
    expect(typeof updates[0]?.payload.confidence).toBe('number');
  });

  it('the system prompt on the SAME turn already carries the new language', async () => {
    await postChatFinal(stub, buildBody({ message: PT_MESSAGE }));

    expect(captured.systems).toHaveLength(1);
    expect(captured.systems[0]).toContain('Respond in pt when possible');
  });

  it('hysteresis: a pt user pasting one English message stays pt; the second consecutive English message flips to en', async () => {
    await putPreferredLanguage(stub, 'pt');

    const first = await postChatFinal(stub, buildBody({ message: EN_MESSAGE }));
    expect(first.response_language).toBe('pt');
    expect(first.input_language).toBe('en');
    expect(await getPreferredLanguage(stub)).toBe('pt');
    expect(captured.systems[0]).toContain('Respond in pt when possible');
    expect(autoUpdates(captured.logs)).toHaveLength(0);

    const second = await postChatFinal(stub, buildBody({ message: EN_MESSAGE_2 }));
    expect(second.response_language).toBe('en');
    expect(await getPreferredLanguage(stub)).toBe('en');
    expect(captured.systems[1]).not.toContain('Respond in');
    expect(autoUpdates(captured.logs)).toHaveLength(1);
    expect(autoUpdates(captured.logs)[0]?.payload).toMatchObject({
      old_language: 'pt',
      new_language: 'en',
    });
  });

  it('hysteresis: a Portuguese message in between resets the English streak', async () => {
    await putPreferredLanguage(stub, 'pt');

    await postChatFinal(stub, buildBody({ message: EN_MESSAGE }));
    await postChatFinal(stub, buildBody({ message: PT_MESSAGE_2 }));
    const third = await postChatFinal(stub, buildBody({ message: EN_MESSAGE_2 }));

    expect(third.response_language).toBe('pt');
    expect(await getPreferredLanguage(stub)).toBe('pt');
    expect(autoUpdates(captured.logs)).toHaveLength(0);
  });

  it('undetectable input: no preference write, no auto-update log, input_language "und"', async () => {
    const response = await postChatFinal(stub, buildBody({ message: UNDETECTABLE_MESSAGE }));

    expect(response.response_language).toBe('en');
    expect(response.input_language).toBe('und');
    expect(await getPreferredLanguage(stub)).toBe('en');
    expect(autoUpdates(captured.logs)).toHaveLength(0);
    expect(chatTurns(captured.logs)).toHaveLength(1);
    expect(chatTurns(captured.logs)[0]?.payload).toMatchObject({
      input_language: 'und',
      input_language_confidence: null,
    });
  });

  it('undetectable turns do not break a streak (two detected English turns still flip)', async () => {
    await putPreferredLanguage(stub, 'pt');

    await postChatFinal(stub, buildBody({ message: EN_MESSAGE }));
    await postChatFinal(stub, buildBody({ message: UNDETECTABLE_MESSAGE }));
    const third = await postChatFinal(stub, buildBody({ message: EN_MESSAGE_2 }));

    expect(third.response_language).toBe('en');
    expect(await getPreferredLanguage(stub)).toBe('en');
  });

  it('an explicit response_language_hint wins for the turn and suppresses auto-follow', async () => {
    const response = await postChatFinal(
      stub,
      buildBody({ message: PT_MESSAGE, response_language_hint: 'fr' })
    );

    expect(response.response_language).toBe('fr');
    expect(response.input_language).toBe('pt');
    expect(captured.systems[0]).toContain('Respond in fr when possible');
    expect(await getPreferredLanguage(stub)).toBe('en');
    expect(autoUpdates(captured.logs)).toHaveLength(0);
  });
});

describe('response_language auto-follow — gateway clients are unchanged', () => {
  let stub: DurableObjectStub;
  let captured: ReturnType<typeof setupCapture>;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    captured = setupCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['whatsapp', 'signal-gateway', 'telegram'])(
    '%s: a Portuguese message leaves the preference alone but records input_language',
    async (clientId) => {
      const response = await postChatFinal(
        stub,
        buildBody({ client_id: clientId, user_id: `${clientId}:15551234567`, message: PT_MESSAGE })
      );

      expect(response.response_language).toBe('en');
      expect(response.input_language).toBe('pt');
      expect(await getPreferredLanguage(stub)).toBe('en');
      expect(captured.systems[0]).not.toContain('Respond in');
      expect(autoUpdates(captured.logs)).toHaveLength(0);

      const turns = chatTurns(captured.logs);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.payload).toMatchObject({
        client_id: clientId,
        response_language: 'en',
        input_language: 'pt',
      });
      expect(typeof turns[0]?.payload.input_language_confidence).toBe('number');
    }
  );

  it('response_language_hint still overrides for the turn and is still not persisted', async () => {
    const response = await postChatFinal(
      stub,
      buildBody({
        client_id: 'whatsapp',
        user_id: 'whatsapp:15551234567',
        message: PT_MESSAGE,
        response_language_hint: 'fr',
      })
    );

    expect(response.response_language).toBe('fr');
    expect(captured.systems[0]).toContain('Respond in fr when possible');
    expect(await getPreferredLanguage(stub)).toBe('en');
    expect(chatTurns(captured.logs)[0]?.payload).toMatchObject({
      response_language: 'fr',
      input_language: 'pt',
    });
  });
});

describe('decideResponseLanguageFollow — the hysteresis rule', () => {
  const pt = { code: 'pt', confidence: 0.9 };
  const en = { code: 'en', confidence: 0.9 };

  it('gates on the AUTO_FOLLOW_CLIENTS allow-list, which is web only', () => {
    expect(AUTO_FOLLOW_CLIENTS).toEqual(['web']);
    for (const clientId of ['whatsapp', 'signal-gateway', 'telegram', 'admin-portal']) {
      const decision = decideResponseLanguageFollow({
        clientId,
        currentLanguage: 'en',
        detected: pt,
        previous: null,
      });
      expect(decision).toEqual({ nextStreak: null, newLanguage: null });
    }
  });

  it('null detection changes nothing and leaves the streak untouched', () => {
    const previous = { code: 'en', streak: 1 };
    const decision = decideResponseLanguageFollow({
      clientId: 'web',
      currentLanguage: 'pt',
      detected: null,
      previous,
    });
    expect(decision).toEqual({ nextStreak: previous, newLanguage: null });
  });

  it('switches away from the default (en) on the first detected turn', () => {
    const decision = decideResponseLanguageFollow({
      clientId: 'web',
      currentLanguage: 'en',
      detected: pt,
      previous: null,
    });
    expect(decision).toEqual({ nextStreak: { code: 'pt', streak: 1 }, newLanguage: 'pt' });
  });

  it('requires two consecutive detected turns to switch away from a non-en language', () => {
    const first = decideResponseLanguageFollow({
      clientId: 'web',
      currentLanguage: 'pt',
      detected: en,
      previous: null,
    });
    expect(first).toEqual({ nextStreak: { code: 'en', streak: 1 }, newLanguage: null });

    const second = decideResponseLanguageFollow({
      clientId: 'web',
      currentLanguage: 'pt',
      detected: en,
      previous: first.nextStreak,
    });
    expect(second).toEqual({ nextStreak: { code: 'en', streak: 2 }, newLanguage: 'en' });
  });

  it('a different detected code resets the streak to 1', () => {
    const decision = decideResponseLanguageFollow({
      clientId: 'web',
      currentLanguage: 'pt',
      detected: pt,
      previous: { code: 'en', streak: 1 },
    });
    expect(decision).toEqual({ nextStreak: { code: 'pt', streak: 1 }, newLanguage: null });
  });

  it('caps the streak so a steady user does not cause a storage write every turn', () => {
    const decision = decideResponseLanguageFollow({
      clientId: 'web',
      currentLanguage: 'pt',
      detected: pt,
      previous: { code: 'pt', streak: 2 },
    });
    expect(decision.nextStreak).toEqual({ code: 'pt', streak: 2 });
    expect(decision.newLanguage).toBeNull();
  });
});
