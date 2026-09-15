/**
 * E2E tests for the client-owned conversation fields (#392):
 *
 *   - `history`          — replaces the stored thread before the turn runs
 *   - `suppress_welcome` — skips the authored + model first-contact welcome
 *   - `suppress_memory`  — turns persistent memory off for the turn
 *
 * Drives real `/chat/final` turns through a UserDO with the Anthropic call
 * intercepted at `globalThis.fetch` (the mock answers a single `ok` text
 * block). Assertions read what the MODEL was sent (messages, tools, system
 * prompt) and what the DO PERSISTED (raw storage), not just the HTTP reply.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildChatBody,
  postChatFinal,
  postChatFinalJson,
  setupAnthropicFetchCapture,
  type AnthropicCapture,
} from '../helpers/anthropic-capture.js';
import type { ChatHistoryEntry, ChatRequest } from '../../src/types/engine.js';
import type { UserPreferencesInternal } from '../../src/types/engine.js';
import type { OrgModes } from '../../src/types/prompt-overrides.js';
import { DEFAULT_PROMPT_VALUES } from '../../src/types/prompt-overrides.js';
import { MEMORY_STORAGE_KEY, type MemoryStorage } from '../../src/services/memory/types.js';

// The SDK constructor must be stubbed (hoisted per file) even though the turn
// is intercepted at globalThis.fetch; see anthropic-capture.ts.
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const MODEL_WELCOME_LINE = "This is the user's first interaction. Briefly welcome them.";
const CONTEXT_SECTION = '## Recent Conversation Context';

const ORG_MODES: OrgModes = {
  modes: [
    {
      name: 'spoken',
      label: 'Spoken',
      published: true,
      welcome_message: 'Welcome to Spoken mode!',
      overrides: {},
    },
  ],
};

const turn = (i: number) => ({ user_message: `q${i}`, assistant_response: `a${i}` });

/** Seed raw history entries straight into DO storage. */
function seedHistory(stub: DurableObjectStub, entries: ChatHistoryEntry[]): Promise<void> {
  return runInDurableObject(stub, (_i, state) => state.storage.put('history', entries));
}

/** Read the raw persisted history straight from DO storage. */
function readHistory(stub: DurableObjectStub): Promise<ChatHistoryEntry[] | undefined> {
  return runInDurableObject(stub, (_i, state) => state.storage.get<ChatHistoryEntry[]>('history'));
}

function readStoredPreferences(
  stub: DurableObjectStub
): Promise<UserPreferencesInternal | undefined> {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.get<UserPreferencesInternal>('preferences')
  );
}

function readWelcomedFlag(stub: DurableObjectStub, slug: string): Promise<boolean | undefined> {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.get<boolean>(`mode_welcomed:${slug}`)
  );
}

/** The `messages` array the model was sent on the most recent call. */
function lastMessages(capture: AnthropicCapture): Array<{ role: string; content: unknown }> {
  const last = capture.calls.at(-1);
  return (last?.body.messages as Array<{ role: string; content: unknown }>) ?? [];
}

/** Tool names the model was offered on the most recent call. */
function lastToolNames(capture: AnthropicCapture): string[] {
  const last = capture.calls.at(-1);
  return ((last?.body.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
}

function lastSystem(capture: AnthropicCapture): string {
  return capture.calls.at(-1)?.system ?? '';
}

/** Full-thread message shape: each stored turn becomes a user + assistant pair. */
function asMessages(turns: Array<{ user_message: string; assistant_response: string }>) {
  return turns.flatMap((t) => [
    { role: 'user', content: t.user_message },
    { role: 'assistant', content: t.assistant_response },
  ]);
}

/** Live handles for the current test; populated fresh by `useTurnHarness` before each test. */
interface TurnHarness {
  stub: DurableObjectStub;
  capture: AnthropicCapture;
}

/**
 * Register the per-test setup for the enclosing describe: a fresh UserDO, the
 * Anthropic fetch capture, an optional storage seed, and mock restoration.
 * Returns a handle whose fields are reassigned before every test.
 */
function useTurnHarness(seed?: (stub: DurableObjectStub) => Promise<void>): TurnHarness {
  const h = {} as TurnHarness;
  beforeEach(async () => {
    h.stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    h.capture = setupAnthropicFetchCapture();
    if (seed) await seed(h.stub);
  });
  afterEach(() => vi.restoreAllMocks());
  return h;
}

describe('history — replace-and-persist', () => {
  const h = useTurnHarness();

  it('replaces the stored thread, feeds it to the model, and appends the new turn', async () => {
    await seedHistory(h.stub, [{ ...turn(99), timestamp: 1 }]);
    const supplied = [turn(1), turn(2)];

    const result = await postChatFinalJson(
      h.stub,
      buildChatBody({ message: 'next', history: supplied })
    );

    // The model saw ONLY the supplied thread + the new message — never q99.
    expect(lastMessages(h.capture)).toEqual([
      ...asMessages(supplied),
      { role: 'user', content: 'next' },
    ]);

    // Storage is supplied + the appended turn, with the receipt echoed back.
    const stored = await readHistory(h.stub);
    expect(stored?.map((e) => e.user_message)).toEqual(['q1', 'q2', 'next']);
    expect(stored?.[2]?.assistant_response).toBe('ok');
    expect(result.history_length).toBe(3);
    expect(result.history_entry).toEqual({
      user_message: 'next',
      assistant_response: 'ok',
      timestamp: stored?.[2]?.timestamp,
    });
    expect(typeof result.history_entry?.timestamp).toBe('number');
  });

  it('an empty array starts blank and the model gets no conversation context', async () => {
    await seedHistory(h.stub, [
      { ...turn(1), timestamp: 1 },
      { ...turn(2), timestamp: 2 },
    ]);

    const result = await postChatFinalJson(
      h.stub,
      buildChatBody({ message: 'hello', history: [] })
    );

    expect(lastMessages(h.capture)).toEqual([{ role: 'user', content: 'hello' }]);
    expect(lastSystem(h.capture)).not.toContain(CONTEXT_SECTION);
    expect((await readHistory(h.stub))?.map((e) => e.user_message)).toEqual(['hello']);
    expect(result.history_length).toBe(1);
  });

  it('an absent field continues the stored thread and adds no receipt fields', async () => {
    await seedHistory(h.stub, [{ ...turn(1), timestamp: 1 }]);

    const result = await postChatFinalJson(h.stub, buildChatBody({ message: 'next' }));

    expect(lastMessages(h.capture)).toEqual([
      ...asMessages([turn(1)]),
      { role: 'user', content: 'next' },
    ]);
    expect((await readHistory(h.stub))?.map((e) => e.user_message)).toEqual(['q1', 'next']);
    expect(result).not.toHaveProperty('history_entry');
    expect(result).not.toHaveProperty('history_length');
  });
});

describe('history — trimming, sanitizing, rejection', () => {
  const h = useTurnHarness();

  it('trims from the oldest end to the org cap, then appends, and reports the truth', async () => {
    const supplied = [turn(1), turn(2), turn(3), turn(4), turn(5)];
    const body = buildChatBody({
      message: 'next',
      history: supplied,
      _org_config: { max_history_storage: 3, max_history_llm: 3 },
    });

    const result = await postChatFinalJson(h.stub, body);

    // 5 supplied → last 3 kept → append → last 3 kept again.
    expect((await readHistory(h.stub))?.map((e) => e.user_message)).toEqual(['q4', 'q5', 'next']);
    expect(result.history_length).toBe(3);
    const replaced = h.capture.logs.find((l) => l.event === 'history_replaced');
    expect(replaced?.payload).toMatchObject({ supplied: 5, stored: 3, trimmed: 2 });
  });

  it('whitelists uploaded fields — R2 keys, speaker and attachments never reach storage', async () => {
    const hostile = {
      ...turn(1),
      timestamp: 7,
      voice_audio_key: 'audio/other-org/victim/x.opus',
      inbound_voice_audio_key: 'voice-submissions/other-org/victim/y.ogg',
      speaker: 'Mallory',
      attachments: [
        { type: 'audio', url: 'https://evil.example/z', r2_key: 'k', mime_type: 'audio/ogg' },
      ],
    };
    const body = { ...buildChatBody({ message: 'next' }), history: [hostile] } as ChatRequest;

    await postChatFinalJson(h.stub, body);

    const stored = await readHistory(h.stub);
    expect(stored?.[0]).toEqual({ user_message: 'q1', assistant_response: 'a1', timestamp: 7 });
    // The read endpoint therefore mints no audio URLs for the uploaded turn.
    const res = await h.stub.fetch('http://fake-host/history?user_id=test-user');
    const data = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(data.entries[0]?.voice_audio_url).toBeNull();
    expect(data.entries[0]?.inbound_voice_audio_url).toBeNull();
  });

  it('is rejected with 400 on a group chat by the DO itself (defense in depth)', async () => {
    const body = buildChatBody({ message: 'hi', chat_type: 'group', chat_id: 'g1', history: [] });

    const response = await postChatFinal(h.stub, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'history is not supported on group/supergroup chats',
    });
    expect(h.capture.calls).toHaveLength(0);
  });
});

describe('suppress_welcome — authored mode welcome', () => {
  const h = useTurnHarness();

  it('skips the welcome AND writes no flag, so a later unflagged turn still gets it', async () => {
    const flagged = buildChatBody({
      message: '#spoken hi',
      suppress_welcome: true,
      _org_modes: ORG_MODES,
    });
    const result = await postChatFinalJson(h.stub, flagged);

    expect(result.responses).toEqual(['ok']);
    expect(await readWelcomedFlag(h.stub, 'spoken')).toBeUndefined();
    expect(lastSystem(h.capture)).not.toContain(MODEL_WELCOME_LINE);
    expect(h.capture.logs.some((l) => l.event === 'welcome_suppressed_by_client')).toBe(true);
    // The durable first_interaction flip still happened — this was a real turn.
    expect((await readStoredPreferences(h.stub))?.first_interaction).toBe(false);

    // Same mode, no flag: the welcome fires now, proving nothing was recorded.
    const unflagged = buildChatBody({ message: '#spoken again', _org_modes: ORG_MODES });
    const second = await postChatFinalJson(h.stub, unflagged);
    expect(second.responses).toHaveLength(2);
    expect(second.responses[0]).toContain('Welcome to Spoken mode!');
    expect(await readWelcomedFlag(h.stub, 'spoken')).toBe(true);
  });
});

describe('suppress_welcome — model self-welcome', () => {
  const h = useTurnHarness();

  it('drops the first-interaction line for a brand-new user (control: present without the flag)', async () => {
    await postChatFinalJson(h.stub, buildChatBody({ message: 'hi', suppress_welcome: true }));
    expect(lastSystem(h.capture)).not.toContain(MODEL_WELCOME_LINE);

    const control = env.USER_DO.get(env.USER_DO.newUniqueId());
    await postChatFinalJson(control, buildChatBody({ message: 'hi' }));
    expect(lastSystem(h.capture)).toContain(MODEL_WELCOME_LINE);
  });
});

describe('suppress_memory', () => {
  const seeded: MemoryStorage = {
    entries: {
      Progress: { content: 'Mark 1 overview done', createdAt: 1, updatedAt: 1, pinned: true },
    },
  };
  const h = useTurnHarness((stub) =>
    runInDurableObject(stub, (_i, state) => state.storage.put(MEMORY_STORAGE_KEY, seeded))
  );

  it('omits the memory tools, the instructions slot and the TOC, and leaves memory untouched', async () => {
    await postChatFinalJson(h.stub, buildChatBody({ message: 'hi', suppress_memory: true }));

    const tools = lastToolNames(h.capture);
    expect(tools).not.toContain('read_memory');
    expect(tools).not.toContain('update_memory');
    expect(tools).toContain('execute_code');
    const system = lastSystem(h.capture);
    expect(system).not.toContain(DEFAULT_PROMPT_VALUES.memory_instructions);
    expect(system).not.toContain('**Progress**');
    expect(h.capture.logs.some((l) => l.event === 'memory_suppressed_by_client')).toBe(true);

    const after = await runInDurableObject(h.stub, (_i, state) =>
      state.storage.get<MemoryStorage>(MEMORY_STORAGE_KEY)
    );
    expect(after).toEqual(seeded);
  });

  it('control: without the flag the same user gets the tools and the TOC', async () => {
    await postChatFinalJson(h.stub, buildChatBody({ message: 'hi' }));

    expect(lastToolNames(h.capture)).toEqual(
      expect.arrayContaining(['read_memory', 'update_memory'])
    );
    const system = lastSystem(h.capture);
    expect(system).toContain(DEFAULT_PROMPT_VALUES.memory_instructions);
    expect(system).toContain('**Progress**');
  });
});
