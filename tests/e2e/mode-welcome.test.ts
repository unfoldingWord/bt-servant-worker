/**
 * E2E tests for the per-mode first-contact welcome (#311).
 *
 * Drives real `/chat/final` turns through a UserDO with the Anthropic call
 * intercepted at `globalThis.fetch` (the mock answers a single `ok` text
 * block). A `#<slug>` trigger that resolves a NEW mode for the user emits a
 * one-time welcome — the mode's authored `welcome_message` plus a deterministic
 * `wa.me` share line — as its own `responses` entry ahead of the model answer,
 * and sets a `mode_welcomed:<slug>` DO storage flag so it never repeats.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildChatBody,
  postChatFinalJson,
  setupAnthropicFetchCapture,
} from '../helpers/anthropic-capture.js';
import type { ChatRequest, ChatResponse, StreamCallbacks } from '../../src/types/engine.js';
import type { OrgModes, PromptMode } from '../../src/types/prompt-overrides.js';
import type { UserPreferencesInternal } from '../../src/types/engine.js';
import { createRequestLogger, type RequestLogger } from '../../src/utils/logger.js';
import { createTimingContext, type TimingContext } from '../../src/utils/timing.js';

/** White-box handle to the DO's private per-turn pipeline (callback-path tests). */
interface ProcessChatInstance {
  processChat(
    body: ChatRequest,
    workerOrigin: string,
    logger: RequestLogger,
    timing: TimingContext,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse>;
}

/**
 * SSE-shaped single-message Anthropic response. The callback/webhook path runs
 * the STREAMING Claude call (callbacks emit progress), so it needs an SSE body —
 * the shared `/chat/final` mock returns non-streaming JSON, which the stream
 * parser rejects.
 */
function anthropicSSEResponse(text: string): Response {
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const lines = [
    `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: null, stop_sequence: null, usage, content: [] } })}\n`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n`,
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })}\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n`,
  ];
  return new Response(lines.join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Stub the Anthropic SDK ctor + a streaming `globalThis.fetch` (answer: 'ok'). */
function setupAnthropicSSE(): void {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.anthropic.com')) return anthropicSSEResponse('ok');
    return realFetch(input, init);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/** Minimal webhook-flavored callbacks (onWelcome present ⇒ the callback path). */
function callbackStreamCallbacks(overrides: Partial<StreamCallbacks>): StreamCallbacks {
  return {
    onStatus: () => {},
    onProgress: () => {},
    onComplete: async () => {},
    onError: () => {},
    ...overrides,
  };
}

/** Drive the DO's private per-turn pipeline directly (callback-path tests). */
function runProcessChat(
  stub: DurableObjectStub,
  body: ChatRequest,
  callbacks: StreamCallbacks
): Promise<ChatResponse> {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as ProcessChatInstance).processChat(
      body,
      '',
      createRequestLogger('test-turn'),
      createTimingContext(),
      callbacks
    )
  );
}

/** Read a raw `mode_welcomed:<suffix>` flag straight from DO storage. */
function readWelcomedFlagRaw(
  stub: DurableObjectStub,
  suffix: string
): Promise<boolean | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<boolean>(`mode_welcomed:${suffix}`)
  );
}

/** Seed a persisted active mode directly into DO storage. */
function seedSelectedMode(stub: DurableObjectStub, slug: string): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.put('selected_mode', slug));
}

/** Read the persisted history entries from the DO. */
async function getHistoryEntries(
  stub: DurableObjectStub
): Promise<Array<{ assistant_response: string }>> {
  const response = await stub.fetch('http://fake-host/history?user_id=test-user');
  expect(response.status).toBe(200);
  const data = (await response.json()) as { entries: Array<{ assistant_response: string }> };
  return data.entries;
}

// The SDK constructor must be stubbed (hoisted per file) even though the turn
// is intercepted at globalThis.fetch; see anthropic-capture.ts.
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const SPOKEN: PromptMode = {
  name: 'spoken',
  label: 'Spoken',
  published: true,
  welcome_message: 'Welcome to Spoken mode!',
  overrides: {},
};

const FIA: PromptMode = {
  name: 'fia-coach',
  label: 'FIA Coach',
  published: true,
  welcome_message: 'FIA coaching starts here.',
  overrides: {},
};

// A published mode that did NOT opt in — no welcome_message.
const SILENT: PromptMode = {
  name: 'silent',
  label: 'Silent',
  published: true,
  overrides: {},
};

const ORG_MODES: OrgModes = { modes: [SPOKEN, FIA, SILENT] };

/** A text chat body carrying the org modes and a leading `#`-trigger message. */
function triggerBody(message: string): ChatRequest {
  return buildChatBody({ message, _org_modes: ORG_MODES });
}

/** Read the raw `mode_welcomed:<slug>` flag straight from DO storage. */
function readWelcomedFlag(stub: DurableObjectStub, slug: string): Promise<boolean | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<boolean>(`mode_welcomed:${slug}`)
  );
}

/** Seed a raw preferences record directly into DO storage. */
function seedStoredPreferences(
  stub: DurableObjectStub,
  prefs: UserPreferencesInternal
): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.put('preferences', prefs));
}

describe('per-mode first-contact welcome (#311)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits the welcome as its own responses entry on first #mode scan and sets the flag', async () => {
    const result = await postChatFinalJson(stub, triggerBody('#spoken hi'));

    // Welcome rides ahead of the model answer ('ok' from the mock).
    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');
    expect(result.responses[1]).toBe('ok');

    // Deterministic wa.me share link is present with the mode's #trigger.
    expect(result.responses[0]).toContain('https://wa.me/15558196461?text=%23spoken');

    // One-time flag is now set.
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
  });

  it('does NOT re-emit the welcome on a second turn in the same mode', async () => {
    await postChatFinalJson(stub, triggerBody('#spoken hi'));
    // Second turn: mode already active + already welcomed.
    const second = await postChatFinalJson(stub, triggerBody('#spoken again'));

    expect(second.responses).toHaveLength(1);
    expect(second.responses[0]).toBe('ok');
  });

  it('emits a welcome for a DIFFERENT mode the user switches into', async () => {
    await postChatFinalJson(stub, triggerBody('#spoken hi'));
    const switched = await postChatFinalJson(stub, triggerBody('#fia-coach hello'));

    expect(switched.responses).toHaveLength(2);
    expect(switched.responses[0]).toContain('FIA coaching starts here.');
    expect(switched.responses[0]).toContain('https://wa.me/15558196461?text=%23fia-coach');
    expect(await readWelcomedFlag(stub, 'fia-coach')).toBe(true);
  });

  it('still welcomes an EXISTING user (first_interaction: false) on their first scan', async () => {
    await seedStoredPreferences(stub, { response_language: 'en', first_interaction: false });

    const result = await postChatFinalJson(stub, triggerBody('#spoken hi'));

    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
  });

  it('emits NO welcome for a mode without welcome_message (opt-in)', async () => {
    const result = await postChatFinalJson(stub, triggerBody('#silent hi'));

    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]).toBe('ok');
    // No opt-in copy ⇒ no flag written either.
    expect(await readWelcomedFlag(stub, 'silent')).toBeUndefined();
  });
});

// FIX 4/5: gating (an explicit #mode for an already-active mode still welcomes)
// and history persistence (model text only).
describe('per-mode welcome — trigger gating & history (#311)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // FIX 4: fire on an explicit #mode trigger even when the mode is already the
  // persisted/active one (existing user rescanning the QR). The prior build
  // gated on a mode CHANGE, so this case was dead.
  it('welcomes an explicit #mode for an ALREADY-ACTIVE mode (seeded selection, no flag)', async () => {
    await seedSelectedMode(stub, 'spoken');

    const result = await postChatFinalJson(stub, triggerBody('#spoken hi'));

    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
  });

  // FIX 5: history must be the MODEL's text only, or the welcome + wa.me link
  // becomes the assistant's prior turn and the model may mimic it.
  it('persists conversation history as model text only (no welcome / wa.me link)', async () => {
    await postChatFinalJson(stub, triggerBody('#spoken hi'));

    const entries = await getHistoryEntries(stub);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.assistant_response).toBe('ok');
    expect(entries[0]?.assistant_response).not.toContain('wa.me');
    expect(entries[0]?.assistant_response).not.toContain('Welcome to Spoken mode!');
  });
});

// FIX 2/3: on the webhook/WhatsApp path the welcome is its own out-of-band send
// and the one-time flag is written only AFTER that send resolves. These drive
// the DO's real per-turn pipeline with webhook-flavored callbacks.
describe('per-mode welcome — callback path (#311)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicSSE();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers the welcome out of band and keeps it OUT of responses', async () => {
    const delivered: string[] = [];
    const callbacks = callbackStreamCallbacks({
      onWelcome: async (text) => {
        delivered.push(text);
      },
    });

    const response = await runProcessChat(stub, triggerBody('#spoken hi'), callbacks);

    // Welcome went out as its own message; the model answer is returned alone.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('Welcome to Spoken mode!');
    expect(delivered[0]).toContain('https://wa.me/15558196461?text=%23spoken');
    expect(response.responses).toEqual(['ok']);
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
  });

  it('does NOT set the flag when callback delivery throws, and re-emits on retry', async () => {
    const throwing = callbackStreamCallbacks({
      onWelcome: async () => {
        throw new Error('webhook down');
      },
    });

    await expect(runProcessChat(stub, triggerBody('#spoken hi'), throwing)).rejects.toThrow(
      /webhook down/
    );
    // Delivery failed ⇒ flag stays unset so the welcome re-emits on retry.
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();

    // Retry with a working callback: the welcome is re-emitted and now recorded.
    const delivered: string[] = [];
    const ok = callbackStreamCallbacks({
      onWelcome: async (text) => {
        delivered.push(text);
      },
    });
    const response = await runProcessChat(stub, triggerBody('#spoken hi'), ok);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('Welcome to Spoken mode!');
    expect(response.responses).toEqual(['ok']);
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
  });
});

// FIX 6: the DO is per-chat for group chats, so a bare mode_welcomed:<slug> flag
// would let one member's scan suppress everyone else's. Key it per sender there.
describe('per-mode welcome — group chats key per user (#311)', () => {
  it("one member's scan does not suppress another member's welcome", async () => {
    const groupStub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();

    const groupMessage = (userId: string): ChatRequest =>
      buildChatBody({
        message: '#spoken hi',
        _org_modes: ORG_MODES,
        user_id: userId,
        chat_type: 'group',
        chat_id: 'grp-1',
      });

    const alice = await postChatFinalJson(groupStub, groupMessage('alice'));
    const bob = await postChatFinalJson(groupStub, groupMessage('bob'));

    expect(alice.responses[0]).toContain('Welcome to Spoken mode!');
    expect(bob.responses[0]).toContain('Welcome to Spoken mode!');

    // Per-user keys were written; the shared slug-only key was NOT.
    expect(await readWelcomedFlagRaw(groupStub, 'alice:spoken')).toBe(true);
    expect(await readWelcomedFlagRaw(groupStub, 'bob:spoken')).toBe(true);
    expect(await readWelcomedFlagRaw(groupStub, 'spoken')).toBeUndefined();

    vi.restoreAllMocks();
  });
});
