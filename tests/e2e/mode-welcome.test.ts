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
  postChatFinal,
  postChatFinalJson,
  readMockRequestBody,
  renderSystem,
  setupAnthropicFetchCapture,
} from '../helpers/anthropic-capture.js';
import type { ChatRequest, ChatResponse, StreamCallbacks } from '../../src/types/engine.js';
import type { InternalQueueEntry } from '../../src/types/queue.js';
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

/** White-box handle to the DO's real queued-SSE caller (#311 FIX A). */
interface ProcessSSEEntryInstance {
  processSSEEntry(entry: InternalQueueEntry, logger: RequestLogger): Promise<void>;
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

/**
 * Stub the Anthropic SDK ctor + a streaming `globalThis.fetch` (answer: 'ok').
 * Captures each request's flattened `system` prompt so a test can assert on the
 * per-turn `first_interaction`-driven "Briefly welcome them." note (FIX 1).
 */
function setupAnthropicSSE(): { calls: Array<{ system: string }> } {
  const calls: Array<{ system: string }> = [];
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.anthropic.com')) {
      const rawBody = await readMockRequestBody(input, init);
      const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      calls.push({ system: renderSystem(parsed.system) });
      return anthropicSSEResponse('ok');
    }
    return realFetch(input, init);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { calls };
}

/** Collect the parsed `data:` events from an SSE Response body (skips keepalives). */
async function readSSEEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const body = await response.text();
  const events: Array<Record<string, unknown>> = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const json = trimmed.slice('data:'.length).trim();
    if (!json) continue;
    events.push(JSON.parse(json) as Record<string, unknown>);
  }
  return events;
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

/**
 * Drive the DO's REAL queued-SSE caller (`processSSEEntry`) with `entry`.
 * `processSSEEntry` looks the writer up in `queuedWriters` by `message_id`; when
 * none is registered (the FIX A case — a disconnected/never-registered writer),
 * `buildSSESender` gets `writer === undefined` and must treat the welcome as
 * NOT delivered.
 */
function runProcessSSEEntry(stub: DurableObjectStub, entry: InternalQueueEntry): Promise<void> {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as ProcessSSEEntryInstance).processSSEEntry(
      entry,
      createRequestLogger('test-sse-entry')
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

/** Read a raw `mode_welcome_pending:<suffix>` bit straight from DO storage. */
function readPendingFlagRaw(stub: DurableObjectStub, suffix: string): Promise<boolean | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<boolean>(`mode_welcome_pending:${suffix}`)
  );
}

/** Read the `mode_welcome_pending:<slug>` bit for a 1:1 mode. */
function readPendingFlag(stub: DurableObjectStub, slug: string): Promise<boolean | undefined> {
  return readPendingFlagRaw(stub, slug);
}

/** Seed a `mode_welcome_pending:<slug>` bit directly into DO storage. */
function seedPendingFlag(stub: DurableObjectStub, slug: string): Promise<void> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.put(`mode_welcome_pending:${slug}`, true)
  );
}

/** Seed a `mode_welcomed:<slug>` flag directly into DO storage. */
function seedWelcomedFlag(stub: DurableObjectStub, slug: string): Promise<void> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.put(`mode_welcomed:${slug}`, true)
  );
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

/** Read the persisted `preferences` record straight from DO storage. */
function readStoredPreferences(
  stub: DurableObjectStub
): Promise<UserPreferencesInternal | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<UserPreferencesInternal>('preferences')
  );
}

/**
 * Like `setupAnthropicSSE`, but the model call returns a NON-retryable 400 so
 * orchestration THROWS after the pre-orchestration welcome delivered. Used to
 * exercise "welcome delivered, then orchestration fails before saveConversation"
 * (#311 FIX 2): the durable `first_interaction:false` must already be persisted
 * by `recordWelcomeDelivered`, independent of the aborted `saveConversation`.
 */
function setupAnthropicSSEModelThrows(): void {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.anthropic.com')) {
      // 400 is not in RETRYABLE_STATUSES ⇒ the orchestrator throws immediately.
      return new Response('{"error":"bad request"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
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

  // FIX C: welcome delivery is NON-FATAL. A throw from onWelcome must NOT abort
  // the turn — the user still gets the model answer — and it queues a pending
  // re-emit instead of losing the welcome.
  it('completes the turn when callback delivery throws, and sets the pending bit', async () => {
    const throwing = callbackStreamCallbacks({
      onWelcome: async () => {
        throw new Error('webhook down');
      },
    });

    // The turn RESOLVES (non-fatal) and still returns the model answer.
    const response = await runProcessChat(stub, triggerBody('#spoken hi'), throwing);
    expect(response.responses).toEqual(['ok']);

    // Delivery failed ⇒ one-time flag stays unset, pending bit is set.
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBe(true);
  });
});

// FIX C: the pending bit re-emits the welcome on the NEXT turn in that mode even
// WITHOUT a `#` trigger; a successful (re)delivery sets the flag and clears
// pending. Split from the callback-path suite to keep each describe body small.
describe('per-mode welcome — pending re-emit (#311 FIX C)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicSSE();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-emits a pending welcome on the next same-mode turn without a #trigger', async () => {
    await seedSelectedMode(stub, 'spoken');
    // Turn 1: delivery throws ⇒ pending set.
    await runProcessChat(
      stub,
      triggerBody('#spoken hi'),
      callbackStreamCallbacks({
        onWelcome: async () => {
          throw new Error('webhook down');
        },
      })
    );
    expect(await readPendingFlag(stub, 'spoken')).toBe(true);

    // Turn 2: plain message (NO #), spoken still the active mode ⇒ re-emit.
    const delivered: string[] = [];
    const plainBody = buildChatBody({ message: 'hello again', _org_modes: ORG_MODES });
    const response = await runProcessChat(
      stub,
      plainBody,
      callbackStreamCallbacks({
        onWelcome: async (text) => {
          delivered.push(text);
        },
      })
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('Welcome to Spoken mode!');
    expect(response.responses).toEqual(['ok']);
    // Success ⇒ flag set, pending cleared.
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();
  });
});

// FIX C: the pending re-emit is scoped to the mode that failed — a DIFFERENT
// active mode must not re-emit, and a mode already welcomed must not re-emit.
describe('per-mode welcome — pending scoping (#311 FIX C)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicSSE();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Drive a plain (no-`#`) turn with a delivery-recording onWelcome. */
  function plainTurn(delivered: string[]): Promise<ChatResponse> {
    return runProcessChat(
      stub,
      buildChatBody({ message: 'hello', _org_modes: ORG_MODES }),
      callbackStreamCallbacks({
        onWelcome: async (text) => {
          delivered.push(text);
        },
      })
    );
  }

  it('does NOT re-emit pending for a DIFFERENT active mode', async () => {
    await seedPendingFlag(stub, 'spoken'); // spoken pending…
    await seedSelectedMode(stub, 'fia-coach'); // …but fia-coach is active.

    const delivered: string[] = [];
    const response = await plainTurn(delivered);

    expect(delivered).toHaveLength(0);
    expect(response.responses).toEqual(['ok']);
    // spoken's pending bit is untouched (still queued for a spoken turn).
    expect(await readPendingFlag(stub, 'spoken')).toBe(true);
  });

  it('does NOT re-emit pending when the mode is already welcomed', async () => {
    await seedPendingFlag(stub, 'spoken');
    await seedWelcomedFlag(stub, 'spoken');
    await seedSelectedMode(stub, 'spoken');

    const delivered: string[] = [];
    const response = await plainTurn(delivered);

    expect(delivered).toHaveLength(0);
    expect(response.responses).toEqual(['ok']);
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

  // FIX C: pending keying is per-user too. Member A's FAILED delivery must set
  // pending only for A, never for B in the shared group DO.
  it("one member's failed delivery does not queue a pending re-emit for another", async () => {
    const groupStub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicSSE();

    const groupBody = (userId: string): ChatRequest =>
      buildChatBody({
        message: '#spoken hi',
        _org_modes: ORG_MODES,
        user_id: userId,
        chat_type: 'group',
        chat_id: 'grp-1',
      });

    // Alice's delivery throws ⇒ pending queued for Alice only.
    await runProcessChat(
      groupStub,
      groupBody('alice'),
      callbackStreamCallbacks({
        onWelcome: async () => {
          throw new Error('webhook down');
        },
      })
    );

    expect(await readPendingFlagRaw(groupStub, 'alice:spoken')).toBe(true);
    expect(await readPendingFlagRaw(groupStub, 'bob:spoken')).toBeUndefined();
    // The bare slug-only pending key was NOT written either.
    expect(await readPendingFlagRaw(groupStub, 'spoken')).toBeUndefined();

    vi.restoreAllMocks();
  });
});

// FIX A: a brand-new user (first_interaction: true) who receives OUR authored
// mode welcome must NOT also get the model's own "Briefly welcome them."
// injection — that per-turn suppression is threaded into the orchestrator's
// effective preferences and is observable in the system prompt.
describe('per-mode welcome — suppresses the model welcome (#311 FIX A)', () => {
  let capture: ReturnType<typeof setupAnthropicFetchCapture>;

  beforeEach(() => {
    capture = setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const WELCOME_NOTE = 'Briefly welcome them.';

  it('omits the model welcome note when our mode welcome is emitted for a new user', async () => {
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    const result = await postChatFinalJson(stub, triggerBody('#spoken hi'));

    // Exactly ONE welcome — ours — rides ahead of the model answer.
    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');
    expect(result.responses[1]).toBe('ok');

    // first_interaction: false reached the system prompt this turn.
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]?.system).not.toContain(WELCOME_NOTE);
  });

  it('still injects the model welcome note for a new user when NO mode welcome emits', async () => {
    // #silent opts out (no welcome_message) ⇒ nothing suppresses the note.
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    const result = await postChatFinalJson(stub, triggerBody('#silent hi'));

    expect(result.responses).toEqual(['ok']);
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]?.system).toContain(WELCOME_NOTE);
  });
});

// #423 review: a webhook welcome that SENDS successfully but whose one-time flag
// write then throws must NOT arm mode_welcome_pending — arming it would re-emit,
// on the next same-mode turn, a welcome the user already received.
describe('per-mode welcome — flag write failure after a successful send (#311)', () => {
  beforeEach(() => {
    setupAnthropicSSE();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not arm pending (or re-emit) when recordWelcomeDelivered throws post-send', async () => {
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    let welcomed = false;

    const result = await runInDurableObject(stub, (instance) => {
      vi.spyOn(
        instance as unknown as { recordWelcomeDelivered(w: unknown): Promise<void> },
        'recordWelcomeDelivered'
      ).mockRejectedValue(new Error('storage boom'));
      return (instance as unknown as ProcessChatInstance).processChat(
        triggerBody('#spoken hi'),
        '',
        createRequestLogger('test-record-fail'),
        createTimingContext(),
        callbackStreamCallbacks({
          onWelcome: async () => {
            welcomed = true;
          },
        })
      );
    });

    // The welcome was sent out-of-band (webhook path ⇒ not in `responses`), and
    // the turn completed normally with the model answer.
    expect(welcomed).toBe(true);
    expect(result.responses).toEqual(['ok']);

    // The flag write failed, so mode_welcomed is unset — acceptable (an explicit
    // re-scan re-welcomes once). Crucially pending is NOT armed, so a plain
    // follow-up turn will not re-emit the welcome the user already saw.
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();
  });
});

// FIX B/3: admins re-preview freely, but only on a mode CHANGE — the real
// re-preview flow (edit copy → switch away → switch back). No one-time flag is
// written, so an author iterating on welcome_message sees every (re-)entry. FIX
// 3: the portal prefixes `#<mode>` on EVERY test-chat turn, so an admin must
// NOT re-emit on an already-active `#<same-mode>` (that was per-turn spam).
describe('per-mode welcome — admin re-preview (#311 FIX B/3)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const adminBody = (message: string): ChatRequest =>
    buildChatBody({ message, _org_modes: ORG_MODES, client_id: 'admin-portal' });

  it('emits on the mode CHANGE but not on a subsequent already-active #<same-mode> turn', async () => {
    // Entry into spoken (a change from no mode) ⇒ welcome.
    const first = await postChatFinalJson(stub, adminBody('#spoken hi'));
    // Already-active spoken (no change), the portal's per-turn `#` prefix ⇒ no
    // welcome, just the model answer. This is the FIX 3 anti-spam behavior.
    const second = await postChatFinalJson(stub, adminBody('#spoken again'));

    expect(first.responses[0]).toContain('Welcome to Spoken mode!');
    expect(second.responses).toEqual(['ok']);

    // No one-time flag (or pending bit) is written for admins.
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();
  });

  it('re-emits when the admin switches away and back (edit → switch away → switch back)', async () => {
    await postChatFinalJson(stub, adminBody('#spoken hi')); // enter spoken
    const away = await postChatFinalJson(stub, adminBody('#fia-coach hello')); // switch away
    const back = await postChatFinalJson(stub, adminBody('#spoken again')); // switch back

    expect(away.responses[0]).toContain('FIA coaching starts here.');
    expect(back.responses[0]).toContain('Welcome to Spoken mode!');

    // Still no flags for admins.
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readWelcomedFlag(stub, 'fia-coach')).toBeUndefined();
  });
});

// FIX 2 (#311): the model's own "Briefly welcome them." injection is suppressed
// whenever an authored welcome is DUE this turn (`emittingWelcome`), regardless
// of out-of-band delivery success — so a brand-new user is never welcomed twice.
// On a FAILED webhook delivery the `mode_welcome_pending` re-emit of the
// authored copy is the SOLE fallback; the model never doubles up.
describe('per-mode welcome — model welcome suppressed whenever due (#311 FIX 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const WELCOME_NOTE = 'Briefly welcome them.';

  it('SUPPRESSES the model welcome note even when the out-of-band welcome send THROWS', async () => {
    const capture = setupAnthropicSSE();
    // A brand-new DO ⇒ first_interaction: true.
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());

    const response = await runProcessChat(
      stub,
      triggerBody('#spoken hi'),
      callbackStreamCallbacks({
        onWelcome: async () => {
          throw new Error('webhook down');
        },
      })
    );

    // Turn still completes with the model answer (delivery is non-fatal).
    expect(response.responses).toEqual(['ok']);
    // A welcome was DUE ⇒ the model note is ABSENT this turn even though delivery
    // failed — the pending re-emit is the sole fallback, so no double welcome.
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]?.system).not.toContain(WELCOME_NOTE);
    // Failed delivery ⇒ one-time flag unset, pending bit set, and (FIX 2)
    // first_interaction is NOT durably cleared — the user stays re-welcomable.
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBe(true);
    expect((await readStoredPreferences(stub))?.first_interaction).not.toBe(false);
  });

  it('OMITS the model welcome note when the out-of-band welcome DELIVERS', async () => {
    const capture = setupAnthropicSSE();
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());

    const delivered: string[] = [];
    const response = await runProcessChat(
      stub,
      triggerBody('#spoken hi'),
      callbackStreamCallbacks({
        onWelcome: async (text) => {
          delivered.push(text);
        },
      })
    );

    expect(delivered).toHaveLength(1);
    expect(response.responses).toEqual(['ok']);
    // Delivery SUCCEEDED ⇒ first_interaction: false this turn ⇒ note ABSENT
    // (exactly one welcome — ours) — and it is durably persisted.
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]?.system).not.toContain(WELCOME_NOTE);
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
    expect((await readStoredPreferences(stub))?.first_interaction).toBe(false);
  });
});

// FIX 2 (#311): exactly ONE welcome per new user — the double-welcome edges.
//  (a) welcome DELIVERED then orchestration THROWS before saveConversation must
//      still leave first_interaction:false (recordWelcomeDelivered owns it), so
//      the model never welcomes on the NEXT turn.
//  (b) welcome FAILED then pending re-emit must re-deliver the authored copy on
//      the next same-mode turn exactly once — the model never welcomes.
const ONE_WELCOME_NOTE = 'Briefly welcome them.';

describe('per-mode welcome — delivered then orchestration throws (#311 FIX 2a)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const WELCOME_NOTE = ONE_WELCOME_NOTE;

  it('(a) delivered welcome + later orchestration throw ⇒ next turn is NOT model-welcomed', async () => {
    // Turn 1: authored welcome DELIVERS out of band, then the model call 400s so
    // orchestration throws BEFORE saveConversation.
    setupAnthropicSSEModelThrows();
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId()); // brand-new ⇒ first_interaction: true

    const delivered: string[] = [];
    await expect(
      runProcessChat(
        stub,
        triggerBody('#spoken hi'),
        callbackStreamCallbacks({
          onWelcome: async (text) => {
            delivered.push(text);
          },
        })
      )
    ).rejects.toThrow();

    // The welcome went out, and recordWelcomeDelivered durably cleared
    // first_interaction even though saveConversation never ran.
    expect(delivered).toHaveLength(1);
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
    expect((await readStoredPreferences(stub))?.first_interaction).toBe(false);

    vi.restoreAllMocks();

    // Turn 2: a plain follow-up. first_interaction is already false ⇒ the model
    // does NOT welcome (no second welcome).
    const capture = setupAnthropicSSE();
    const response = await runProcessChat(
      stub,
      buildChatBody({ message: 'anything else', _org_modes: ORG_MODES }),
      callbackStreamCallbacks({})
    );
    expect(response.responses).toEqual(['ok']);
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]?.system).not.toContain(WELCOME_NOTE);
  });
});

describe('per-mode welcome — failed then pending re-emit (#311 FIX 2b)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const WELCOME_NOTE = ONE_WELCOME_NOTE;

  it('(b) failed welcome ⇒ model not welcomed this turn; pending re-emits authored copy once next turn', async () => {
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId()); // brand-new ⇒ first_interaction: true
    await seedSelectedMode(stub, 'spoken');

    // Turn 1: delivery THROWS ⇒ pending set, model NOT welcomed this turn.
    const capture1 = setupAnthropicSSE();
    await runProcessChat(
      stub,
      triggerBody('#spoken hi'),
      callbackStreamCallbacks({
        onWelcome: async () => {
          throw new Error('webhook down');
        },
      })
    );
    expect(capture1.calls[0]?.system).not.toContain(WELCOME_NOTE);
    expect(await readPendingFlag(stub, 'spoken')).toBe(true);
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();

    vi.restoreAllMocks();

    // Turn 2: plain same-mode turn ⇒ pending re-emits the authored copy exactly
    // once, and the model is STILL suppressed (a welcome is due) — no double.
    const capture2 = setupAnthropicSSE();
    const delivered: string[] = [];
    const response = await runProcessChat(
      stub,
      buildChatBody({ message: 'hello again', _org_modes: ORG_MODES }),
      callbackStreamCallbacks({
        onWelcome: async (text) => {
          delivered.push(text);
        },
      })
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('Welcome to Spoken mode!');
    expect(response.responses).toEqual(['ok']);
    expect(capture2.calls[0]?.system).not.toContain(WELCOME_NOTE);
    // Success ⇒ flag set, pending cleared, first_interaction durably false.
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();
    expect((await readStoredPreferences(stub))?.first_interaction).toBe(false);
  });
});

// FIX 1: `/chat/stream` (web client AND portal test chat) does NOT wire
// `onWelcome`. Both live SSE consumers REPLACE the stream with
// `complete.responses`, so an out-of-band progress welcome would be dropped
// while the flag still got recorded. The welcome is instead prepended IN-BAND
// into `complete.responses` as `[welcome, ...model]`, and the one-time flag is
// recorded only after the turn is saved.
describe('per-mode welcome — SSE path in-band prepend (#311 FIX 1)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicSSE();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prepends the welcome in-band into complete.responses as [welcome, ...model] and records the flag', async () => {
    const response = await stub.fetch('http://fake-host/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(triggerBody('#spoken hi')),
    });
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    const events = await readSSEEvents(response);
    const completeEventIdx = events.findIndex((e) => e.type === 'complete');
    expect(completeEventIdx).toBeGreaterThanOrEqual(0);

    // The completion carries the welcome IN-BAND as the first responses entry,
    // ahead of the model answer — the array the SSE consumers actually render.
    const completeResponse = (events[completeEventIdx] as { response: ChatResponse }).response;
    expect(completeResponse.responses).toHaveLength(2);
    expect(completeResponse.responses[0]).toContain('Welcome to Spoken mode!');
    expect(completeResponse.responses[0]).toContain('https://wa.me/15558196461?text=%23spoken');
    expect(completeResponse.responses[1]).toBe('ok');

    // No separate out-of-band progress welcome is emitted on the SSE path.
    const welcomeProgressIdx = events.findIndex(
      (e) => e.type === 'progress' && String(e.text).includes('Welcome to Spoken mode!')
    );
    expect(welcomeProgressIdx).toBe(-1);

    // The flag was recorded after the turn was saved (in-band delivery).
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
  });
});

// FIX 1 (5th round): on the SSE path the welcome ships inside `complete.responses`,
// which the client receives ONLY if still connected when `complete` is written.
// Recording the one-time flag is therefore DEFERRED to the SSE caller, which runs
// it AFTER the complete write with the live connection state — a mid-turn
// disconnect records a `mode_welcome_pending` re-emit instead of burning the flag
// on a welcome the user never saw. These drive the DO pipeline directly and invoke
// the deferred recorder the caller would run.
describe('per-mode welcome — SSE deferred flag recording (#311 FIX 1)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicSSE();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defers recording: processChat writes NEITHER the flag NOR pending inline', async () => {
    // The caller hands off `record` but this test never invokes it — simulating
    // the window between `processChat` returning and the caller writing `complete`.
    const response = await runProcessChat(
      stub,
      triggerBody('#spoken hi'),
      callbackStreamCallbacks({ deferInBandWelcomeRecord: () => {} })
    );

    // Welcome rode in-band ahead of the model answer.
    expect(response.responses).toHaveLength(2);
    expect(response.responses[0]).toContain('Welcome to Spoken mode!');

    // FIX 1: nothing was recorded during processChat — the flag write is deferred
    // to the caller, gated on the client still being connected at the complete
    // write. (The connected case — flag set after `complete` — is covered by the
    // `/chat/stream` in-band test above, which exercises the real SSE caller.)
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();
  });

  it('a disconnect at the complete write records pending, NOT the one-time flag', async () => {
    // The caller runs the handed recorder with delivered=false (client dropped
    // before `complete` reached it). Invoke it synchronously inside the deferral
    // so the single pending-put runs within the live DO invocation context.
    let recordPromise: Promise<void> | undefined;
    const response = await runProcessChat(
      stub,
      triggerBody('#spoken hi'),
      callbackStreamCallbacks({
        deferInBandWelcomeRecord: (record) => {
          recordPromise = record(false);
        },
      })
    );
    await recordPromise;

    expect(response.responses).toHaveLength(2);
    // Disconnect ⇒ pending re-emit queued; the one-time flag stays UNSET so a
    // later same-mode turn re-emits the welcome the user never saw.
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBe(true);
  });
});

// FIX 2 (5th round): an admin preview carries no keys (admins re-preview freely,
// never `mode_welcomed`), so `recordWelcomeDelivered` no-ops and the end-of-turn
// flip is skipped on the emitting turn — leaving `first_interaction:true`. The
// preview DID go out, so it must persist `first_interaction:false` durably (and
// ONLY that). Without it the next already-active `#<mode>` turn triggers the
// model's own "Briefly welcome them." injection.
describe('per-mode welcome — admin preview persists first_interaction:false (#311 FIX 2)', () => {
  const WELCOME_NOTE = 'Briefly welcome them.';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const adminBody = (message: string): ChatRequest =>
    buildChatBody({ message, _org_modes: ORG_MODES, client_id: 'admin-portal' });

  it('admin emit persists first_interaction:false (no flag) so the next #<mode> turn omits the model note', async () => {
    const capture = setupAnthropicFetchCapture();
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId()); // fresh ⇒ first_interaction: true

    // Turn 1: admin enters spoken ⇒ authored preview emits.
    const first = await postChatFinalJson(stub, adminBody('#spoken hi'));
    expect(first.responses[0]).toContain('Welcome to Spoken mode!');

    // first_interaction is durably false now — but NO one-time flag (re-preview
    // must still work) and NO pending bit were written.
    expect((await readStoredPreferences(stub))?.first_interaction).toBe(false);
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();

    // Turn 2: already-active #spoken (the portal prefixes it every turn). The
    // authored copy is correctly withheld AND the model's own welcome note is
    // ABSENT — because first_interaction is already durably false.
    const second = await postChatFinalJson(stub, adminBody('#spoken again'));
    expect(second.responses).toEqual(['ok']);
    expect(capture.calls).toHaveLength(2);
    expect(capture.calls[1]?.system).not.toContain(WELCOME_NOTE);
    // Still no one-time flag for the admin — re-preview stays available.
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
  });
});

// FIX 3 (5th round): the one-time flag is keyed on the CURRENT canonical slug.
// After a reslug (`spoken` → `spoken-v2`, old slug kept as an alias, #284) a user
// already welcomed under `mode_welcomed:spoken` must NOT be re-welcomed under the
// new canonical `spoken-v2`. The check treats the user as welcomed if ANY current
// slug (canonical + aliases) carries the flag, and copies it onto the canonical
// key (copy-on-read).
describe('per-mode welcome — reslug/alias does not re-welcome (#311 FIX 3)', () => {
  const SPOKEN_V2: PromptMode = {
    name: 'spoken-v2',
    label: 'Spoken',
    published: true,
    welcome_message: 'Welcome to Spoken mode!',
    aliases: ['spoken'],
    overrides: {},
  };
  const ORG_MODES_RESLUGGED: OrgModes = { modes: [SPOKEN_V2] };

  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const resluggedBody = (message: string): ChatRequest =>
    buildChatBody({ message, _org_modes: ORG_MODES_RESLUGGED });

  it('does NOT re-welcome when scanning the former slug (now an alias); copies the flag to canonical', async () => {
    await seedWelcomedFlag(stub, 'spoken'); // welcomed under the OLD canonical slug

    const result = await postChatFinalJson(stub, resluggedBody('#spoken hi'));

    // No re-welcome — just the model answer.
    expect(result.responses).toEqual(['ok']);
    // Copy-on-read: the canonical key is now present.
    expect(await readWelcomedFlag(stub, 'spoken-v2')).toBe(true);
  });

  it('does NOT re-welcome when scanning the new canonical slug', async () => {
    await seedWelcomedFlag(stub, 'spoken'); // welcomed under the OLD slug (alias now)

    const result = await postChatFinalJson(stub, resluggedBody('#spoken-v2 hi'));

    expect(result.responses).toEqual(['ok']);
    expect(await readWelcomedFlag(stub, 'spoken-v2')).toBe(true);
  });
});

// FIX 4 (5th round): `maybePendingWelcome` returned undefined when a mode had no
// `welcome_message` but left a stale `mode_welcome_pending:<key>` bit. So: delivery
// fails (pending set) → admin clears the copy → later re-authors it → next PLAIN
// same-mode turn surprise-welcomes the user. The pending bit must be cleared when
// the copy is (empty/)absent.
describe('per-mode welcome — clears stale pending when copy removed (#311 FIX 4)', () => {
  // `spoken` with NO welcome_message (the copy was cleared).
  const SPOKEN_NO_COPY: PromptMode = {
    name: 'spoken',
    label: 'Spoken',
    published: true,
    overrides: {},
  };
  const ORG_MODES_NO_COPY: OrgModes = { modes: [SPOKEN_NO_COPY] };

  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes the pending bit and does not surprise-welcome on the next plain same-mode turn', async () => {
    await seedSelectedMode(stub, 'spoken');
    await seedPendingFlag(stub, 'spoken'); // left by an earlier failed delivery

    const result = await postChatFinalJson(
      stub,
      buildChatBody({ message: 'hello', _org_modes: ORG_MODES_NO_COPY })
    );

    // No welcome (the copy is gone) — just the model answer.
    expect(result.responses).toEqual(['ok']);
    // The stale pending bit is cleared, so re-authoring the copy later cannot
    // surprise-welcome the user.
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
  });
});

// FIX A (#311): on the queued-SSE path the sender is built from
// `queuedWriters.get(message_id)`, which is `undefined` when the writer was
// deleted on a client disconnect (`createQueuedSSEStream`) or never registered
// (a retry). A missing writer means the `complete` (and its in-band welcome)
// never went out, so `finalizeSseWelcomeRecord` must record a `mode_welcome_pending`
// re-emit — NOT burn the one-time `mode_welcomed` flag. Driven through the REAL
// queued-SSE caller (`processSSEEntry`), not a synthetic `record(false)`.
describe('per-mode welcome — queued SSE with no writer arms pending (#311 FIX A)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicSSE();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records pending (NOT the one-time flag) when the queued writer is missing', async () => {
    // No writer is registered for this message_id — `processSSEEntry` builds its
    // sender from `queuedWriters.get(...)` ⇒ `undefined` (the disconnected case).
    const entry: InternalQueueEntry = {
      message_id: 'msg-no-writer',
      body: { ...triggerBody('#spoken hi'), _worker_origin: '' },
      enqueued_at: Date.now(),
      retry_count: 0,
    };

    await runProcessSSEEntry(stub, entry);

    // The welcome never reached the client (no writer) ⇒ the one-time flag stays
    // UNSET and a pending re-emit is queued for a later same-mode turn.
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBe(true);
  });
});

// FIX B (#311): an in-band (SSE / `/chat/final`) welcome's flag/pending write runs
// only AFTER orchestration + save. If either throws once the mode is already
// persisted (`applyTriggerOverrides` writes `selected_mode` before delivery), no
// pending is armed — so a later plain same-mode turn (no `#`) never welcomes.
// `processChat`'s finally arms pending when a welcome was due in-band and
// recording never ran. The webhook path is unaffected (records/pends before
// orchestration).
describe('per-mode welcome — in-band throw arms pending (#311 FIX B)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(SSE) orchestration throw after mode persisted arms pending (flag unset)', async () => {
    setupAnthropicSSEModelThrows();
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());

    // SSE-shaped callbacks (deferInBandWelcomeRecord present, no onWelcome). The
    // model 400s AFTER `#spoken` persisted the mode ⇒ processChat throws before
    // `finalizeEmittedWelcome` ran.
    await expect(
      runProcessChat(
        stub,
        triggerBody('#spoken hi'),
        callbackStreamCallbacks({ deferInBandWelcomeRecord: () => {} })
      )
    ).rejects.toThrow();

    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBe(true);
  });

  it('(/chat/final) throw arms pending; a following plain same-mode turn delivers the copy once', async () => {
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());

    // Turn 1: `/chat/final` with `#spoken`; the model 400s after the mode is
    // persisted ⇒ the request errors, but pending is armed by the finally.
    setupAnthropicSSEModelThrows();
    const failing = await postChatFinal(stub, triggerBody('#spoken hi'));
    expect(failing.status).not.toBe(200);
    expect(await readWelcomedFlag(stub, 'spoken')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBe(true);

    vi.restoreAllMocks();

    // Turn 2: a PLAIN same-mode turn (no `#`) re-emits the authored copy exactly
    // once and records it (spoken was persisted by turn 1).
    setupAnthropicFetchCapture();
    const result = await postChatFinalJson(
      stub,
      buildChatBody({ message: 'hello again', _org_modes: ORG_MODES })
    );

    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');
    expect(result.responses[1]).toBe('ok');
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();
  });
});

// FIX C (#311): the pending lookup must be alias-aware, mirroring the welcomed
// check. After a reslug (#284) the old slug becomes an alias, so a pending bit
// set under the FORMER slug is stranded off the current canonical key. Resolve
// pending across the mode's current slugs (copy-on-read to canonical, delete the
// alias key); and when the welcomed short-circuit fires, clear any stale pending
// across those slugs.
describe('per-mode welcome — alias-aware pending after reslug (#311 FIX C)', () => {
  const SPOKEN_V2: PromptMode = {
    name: 'spoken-v2',
    label: 'Spoken',
    published: true,
    welcome_message: 'Welcome to Spoken mode!',
    aliases: ['spoken'],
    overrides: {},
  };
  const ORG_MODES_RESLUGGED: OrgModes = { modes: [SPOKEN_V2] };

  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const resluggedBody = (message: string): ChatRequest =>
    buildChatBody({ message, _org_modes: ORG_MODES_RESLUGGED });

  it('re-emits a pending welcome stranded under the OLD slug, and clears that stale key', async () => {
    await seedSelectedMode(stub, 'spoken-v2'); // canonical is active
    await seedPendingFlag(stub, 'spoken'); // pending stranded under the former slug

    const result = await postChatFinalJson(stub, resluggedBody('hello')); // plain turn, no `#`

    // The re-emit fires under the canonical slug (alias-aware lookup).
    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');
    expect(result.responses[1]).toBe('ok');
    // Success records the canonical flag and clears pending on BOTH slugs.
    expect(await readWelcomedFlag(stub, 'spoken-v2')).toBe(true);
    expect(await readPendingFlag(stub, 'spoken-v2')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();
  });

  it('cleans a stale pending across slugs when already welcomed under any current slug', async () => {
    await seedWelcomedFlag(stub, 'spoken'); // welcomed under the former slug (now an alias)
    await seedPendingFlag(stub, 'spoken-v2'); // stale pending lingering under canonical
    await seedSelectedMode(stub, 'spoken-v2');

    const result = await postChatFinalJson(stub, resluggedBody('hello')); // plain turn

    // Already welcomed ⇒ no re-emit, just the model answer.
    expect(result.responses).toEqual(['ok']);
    // The welcomed short-circuit clears the stale pending across current slugs.
    expect(await readPendingFlag(stub, 'spoken-v2')).toBeUndefined();
    expect(await readPendingFlag(stub, 'spoken')).toBeUndefined();
    // Copy-on-read migrated the welcomed flag onto the canonical slug.
    expect(await readWelcomedFlag(stub, 'spoken-v2')).toBe(true);
  });
});
