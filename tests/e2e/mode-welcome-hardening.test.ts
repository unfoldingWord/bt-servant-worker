/**
 * E2E tests for the #422 delivery-hardening follow-ups to the per-mode
 * first-contact welcome (#311):
 *
 * 1. `recordWelcomeDelivered` writes `mode_welcomed:<key>`, clears the pending
 *    bit and flips `first_interaction:false` in ONE storage transaction — a
 *    failure mid-way leaves no partial state (no "flag set, model still
 *    welcomes" double-welcome window).
 * 2. A `progress_mode: 'complete'` callback consumer receives the welcome
 *    INSIDE the single `complete` payload instead of a `progress` POST it
 *    ignores (README "Progress modes": only the final `complete` event).
 * 3. Steady-state plain turns skip the per-slug `mode_welcome_pending` reads:
 *    a single `mode_welcome_pending_any` marker gates `maybePendingWelcome`.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildChatBody,
  postChatFinalJson,
  setupAnthropicFetchCapture,
} from '../helpers/anthropic-capture.js';
import { buildSSEFrames } from '../helpers/anthropic-sse.js';
import type { ChatRequest, ChatResponse, StreamCallbacks } from '../../src/types/engine.js';
import type { InternalQueueEntry } from '../../src/types/queue.js';
import type { UserPreferencesInternal } from '../../src/types/engine.js';
import type { OrgModes, PromptMode } from '../../src/types/prompt-overrides.js';
import { createRequestLogger, type RequestLogger } from '../../src/utils/logger.js';
import { createTimingContext, type TimingContext } from '../../src/utils/timing.js';

// The SDK constructor must be stubbed (hoisted per file) even though the turn
// is intercepted at globalThis.fetch; see anthropic-capture.ts.
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const PENDING_PREFIX = 'mode_welcome_pending:';
const PENDING_ANY_KEY = 'mode_welcome_pending_any';
const CALLBACK_URL = 'https://callback.example/hook';

/** White-box handle to the DO's real webhook caller (`processCallbackEntry`). */
interface ProcessCallbackEntryInstance {
  processCallbackEntry(entry: InternalQueueEntry, logger: RequestLogger): Promise<void>;
}

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

const SPOKEN: PromptMode = {
  name: 'spoken',
  label: 'Spoken',
  published: true,
  welcome_message: 'Welcome to Spoken mode!',
  overrides: {},
};

// A reslugged mode (#284): the former slug is now an alias, so the pending
// lookup has 1 + |aliases| = 2 per-slug keys to consult.
const SPOKEN_V2: PromptMode = {
  name: 'spoken-v2',
  label: 'Spoken',
  published: true,
  welcome_message: 'Welcome to Spoken mode!',
  aliases: ['spoken'],
  overrides: {},
};

const ORG_MODES: OrgModes = { modes: [SPOKEN] };
const ORG_MODES_RESLUGGED: OrgModes = { modes: [SPOKEN_V2] };

function body(message: string, modes: OrgModes = ORG_MODES): ChatRequest {
  return buildChatBody({ message, _org_modes: modes });
}

function groupBody(userId: string, message: string): ChatRequest {
  return buildChatBody({
    message,
    _org_modes: ORG_MODES,
    user_id: userId,
    chat_type: 'group',
    chat_id: 'grp-1',
  });
}

/** A single-text-block streaming Anthropic body (the callback path streams). */
function anthropicStreamBody(text: string): string {
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  return buildSSEFrames([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: null, stop_sequence: null, usage, content: [] } }, // prettier-ignore
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage },
    { type: 'message_stop' },
  ]);
}

interface CapturedPost {
  type: string;
  text?: string;
}

interface StreamingFetch {
  posts: CapturedPost[];
  /** HTTP status the callback URL answers with (mutable per turn). */
  callbackStatus: number;
}

/**
 * Stub the Anthropic SDK ctor and route `globalThis.fetch`: the Anthropic host
 * answers a streaming 'ok'; the callback URL records each webhook POST body
 * and answers `callbackStatus` (default 200). Everything else passes through.
 */
function setupStreamingFetch(callbackStatus = 200): StreamingFetch {
  const posts: CapturedPost[] = [];
  const fetchState: StreamingFetch = { posts, callbackStatus };
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
      return new Response(anthropicStreamBody('ok'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (url.startsWith(CALLBACK_URL)) {
      const raw = init?.body ?? (await (input as Request).text());
      posts.push(JSON.parse(String(raw)) as CapturedPost);
      return new Response(null, { status: fetchState.callbackStatus });
    }
    return realFetch(input, init);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return fetchState;
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

const throwingWelcome = (): StreamCallbacks =>
  callbackStreamCallbacks({
    onWelcome: async () => {
      throw new Error('webhook down');
    },
  });

const deliveringWelcome = (sink: string[]): StreamCallbacks =>
  callbackStreamCallbacks({
    onWelcome: async (text) => {
      sink.push(text);
    },
  });

/** Drive the DO's private per-turn pipeline directly (callback-path tests). */
function runProcessChat(
  stub: DurableObjectStub,
  request: ChatRequest,
  callbacks: StreamCallbacks
): Promise<ChatResponse> {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as ProcessChatInstance).processChat(
      request,
      '',
      createRequestLogger('test-turn'),
      createTimingContext(),
      callbacks
    )
  );
}

function readKey<T>(stub: DurableObjectStub, key: string): Promise<T | undefined> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get<T>(key));
}

function putKey(stub: DurableObjectStub, key: string, value: unknown): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.put(key, value));
}

const readWelcomed = (stub: DurableObjectStub, suffix: string) =>
  readKey<boolean>(stub, `mode_welcomed:${suffix}`);
const readPending = (stub: DurableObjectStub, suffix: string) =>
  readKey<boolean>(stub, `${PENDING_PREFIX}${suffix}`);
const readPendingAny = (stub: DurableObjectStub) => readKey<boolean>(stub, PENDING_ANY_KEY);
const readPreferences = (stub: DurableObjectStub) =>
  readKey<UserPreferencesInternal>(stub, 'preferences');

/**
 * Item 1 (rollback proof): make the NEXT storage transaction fail when it
 * writes the `preferences` record, after the welcomed/pending writes have
 * already been issued inside that transaction. Returns the throw count.
 */
function failPreferencesWriteInNextTransaction(state: DurableObjectState): { throws: number } {
  const counter = { throws: 0 };
  const storage = state.storage;
  const realTransaction = storage.transaction.bind(storage);
  const failingPut = (txn: DurableObjectTransaction) => {
    return (key: string | Record<string, unknown>, ...rest: unknown[]) => {
      if (key === 'preferences') {
        counter.throws += 1;
        throw new Error('storage boom (preferences)');
      }
      return (txn.put as (...args: unknown[]) => Promise<void>)(key, ...rest);
    };
  };
  const proxied = (txn: DurableObjectTransaction): DurableObjectTransaction =>
    new Proxy(txn, {
      get(target, prop, receiver) {
        if (prop === 'put') return failingPut(target);
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
  vi.spyOn(storage, 'transaction').mockImplementation((closure) =>
    realTransaction((txn) => closure(proxied(txn)))
  );
  return counter;
}

interface StorageOps {
  gets: string[];
  puts: string[];
  /** Number of `storage.transaction()` calls. */
  transactions: number;
}

/** Record every direct `storage.get`/`storage.put` key and each `transaction()` on the DO. */
function recordStorageOps(state: DurableObjectState): StorageOps {
  const ops: StorageOps = { gets: [], puts: [], transactions: 0 };
  const storage = state.storage;
  const realGet = storage.get.bind(storage);
  const realPut = storage.put.bind(storage);
  const realTransaction = storage.transaction.bind(storage);
  vi.spyOn(storage, 'transaction').mockImplementation((closure) => {
    ops.transactions += 1;
    return realTransaction(closure);
  });
  vi.spyOn(storage, 'get').mockImplementation(((key: string | string[], ...rest: unknown[]) => {
    for (const k of Array.isArray(key) ? key : [key]) ops.gets.push(k);
    return (realGet as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
  }) as typeof storage.get);
  vi.spyOn(storage, 'put').mockImplementation(((
    key: string | Record<string, unknown>,
    ...rest: unknown[]
  ) => {
    for (const k of typeof key === 'string' ? [key] : Object.keys(key)) ops.puts.push(k);
    return (realPut as (...args: unknown[]) => Promise<void>)(key, ...rest);
  }) as typeof storage.put);
  return ops;
}

// ─────────────────────────────────────────────────────────────────────────────
// Item 1 — one storage transaction
// ─────────────────────────────────────────────────────────────────────────────

describe('#422 item 1 — recordWelcomeDelivered is one storage transaction', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes mode_welcomed and the first_interaction flip inside a transaction, not as direct puts', async () => {
    setupAnthropicFetchCapture();
    const ops = await runInDurableObject(stub, (_instance, state) => recordStorageOps(state));

    const result = await postChatFinalJson(stub, body('#spoken hi'));
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');

    // Both durable effects landed...
    expect(await readWelcomed(stub, 'spoken')).toBe(true);
    expect((await readPreferences(stub))?.first_interaction).toBe(false);
    // ...and NEITHER was issued as a standalone `storage.put` — they went
    // through `storage.transaction` as one atomic unit.
    expect(ops.puts).not.toContain('mode_welcomed:spoken');
    expect(ops.puts).not.toContain('preferences');
    expect(ops.transactions).toBeGreaterThanOrEqual(1);
  });

  it('rolls back the flag and pending writes when the first_interaction flip fails — no partial state', async () => {
    setupStreamingFetch();
    // Seed a stranded pending bit: a correct rollback must leave it in place.
    await putKey(stub, `${PENDING_PREFIX}spoken`, true);
    await putKey(stub, PENDING_ANY_KEY, true);

    const delivered: string[] = [];
    const logger = createRequestLogger('test-txn-fail');
    const warn = vi.spyOn(logger, 'warn');
    const { result, throws } = await runInDurableObject(stub, async (instance, state) => {
      const counter = failPreferencesWriteInNextTransaction(state);
      const response = await (instance as unknown as ProcessChatInstance).processChat(
        body('#spoken hi'),
        '',
        logger,
        createTimingContext(),
        deliveringWelcome(delivered)
      );
      return { result: response, throws: counter.throws };
    });

    // The welcome went out and the turn completed (webhook record is best-effort).
    expect(delivered).toHaveLength(1);
    expect(result.responses).toEqual(['ok']);
    expect(throws).toBe(1);

    // The failed transaction left NO partial state: the flag is NOT set, the
    // pending bit AND its marker survived, and first_interaction was never
    // flipped. Prefer a double-send (re-emit next same-mode turn) over a skip.
    expect(await readWelcomed(stub, 'spoken')).toBeUndefined();
    expect(await readPending(stub, 'spoken')).toBe(true);
    expect(await readPendingAny(stub)).toBe(true);
    expect((await readPreferences(stub))?.first_interaction ?? true).toBe(true);
    // The failure is observable through the request logger, with the keys.
    expect(warn).toHaveBeenCalledWith(
      'mode_welcome_record_txn_failed',
      expect.objectContaining({ welcomed_key: 'mode_welcomed:spoken' })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 2 — progress_mode: 'complete' gets the welcome in the complete payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drive the DO's REAL webhook caller (`processCallbackEntry`: builds the
 * `ProgressCallbackSender` + `createWebhookCallbacks` from the body, runs the
 * turn, then fires `onComplete`). Runs inside the DO's instrumented context,
 * exactly as the queue does in production, so the deferred welcome record that
 * settles after the `complete` POST executes with the DO's storage context.
 */
function runCallbackEntry(
  stub: DurableObjectStub,
  request: ChatRequest,
  mode: 'complete' | 'iteration'
): Promise<void> {
  const entry: InternalQueueEntry = {
    message_id: `msg-${mode}-${crypto.randomUUID()}`,
    body: {
      ...request,
      progress_callback_url: CALLBACK_URL,
      message_key: 'k',
      progress_mode: mode,
      _worker_origin: '',
    },
    enqueued_at: Date.now(),
    retry_count: 0,
  };
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as ProcessCallbackEntryInstance).processCallbackEntry(
      entry,
      createRequestLogger('test-callback-entry')
    )
  );
}

const welcomedEventually = (stub: DurableObjectStub) =>
  vi.waitFor(async () => expect(await readWelcomed(stub, 'spoken')).toBe(true));
const pendingEventually = (stub: DurableObjectStub) =>
  vi.waitFor(async () => expect(await readPending(stub, 'spoken')).toBe(true));

describe("#422 item 2 — progress_mode 'complete' folds the welcome into the complete POST", () => {
  let stub: DurableObjectStub;
  let posts: CapturedPost[];

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    posts = setupStreamingFetch().posts;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'complete' mode: exactly ONE webhook POST, type complete, carrying welcome + answer", async () => {
    await runCallbackEntry(stub, body('#spoken hi'), 'complete');
    await welcomedEventually(stub);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.type).toBe('complete');
    expect(posts[0]?.text).toContain('Welcome to Spoken mode!');
    expect(posts[0]?.text).toContain('https://wa.me/15558196461?text=%23spoken');
    expect(posts[0]?.text?.endsWith('\nok')).toBe(true);
    // One-time flag recorded after the 2xx; nothing pending.
    expect(await readPending(stub, 'spoken')).toBeUndefined();
    // History stays model-only (the welcome is not the assistant's prior turn).
    const history = await stub.fetch('http://fake-host/history?user_id=test-user');
    const data = (await history.json()) as { entries: Array<{ assistant_response: string }> };
    expect(data.entries.map((e) => e.assistant_response)).toEqual(['ok']);
  });

  it("'iteration' mode (control): welcome is still its own progress POST ahead of the answer", async () => {
    await runCallbackEntry(stub, body('#spoken hi'), 'iteration');
    await welcomedEventually(stub);

    await vi.waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(2));
    expect(posts[0]?.type).toBe('progress');
    expect(posts[0]?.text).toContain('Welcome to Spoken mode!');
    const completes = posts.filter((p) => p.type === 'complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]?.text ?? '').not.toContain('Welcome to Spoken mode!');
  });
});

describe("#422 item 2 — 'complete' mode failed POST arms the re-emit (double-send over skip)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a 503 on the complete POST leaves the flag unset and pending armed; the next turn re-emits', async () => {
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    const fetchState = setupStreamingFetch(503);
    const { posts } = fetchState;

    await runCallbackEntry(stub, body('#spoken hi'), 'complete');
    await pendingEventually(stub);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain('Welcome to Spoken mode!');

    // The only POST carrying the welcome failed ⇒ NOT welcomed, pending armed
    // (with its marker), first_interaction untouched.
    expect(await readWelcomed(stub, 'spoken')).toBeUndefined();
    expect(await readPendingAny(stub)).toBe(true);
    expect((await readPreferences(stub))?.first_interaction ?? true).toBe(true);

    // Next plain same-mode turn with the gateway back: the welcome re-emits
    // inside that turn's single complete POST, and only then is it recorded.
    fetchState.callbackStatus = 200;
    await runCallbackEntry(stub, body('hello again'), 'complete');
    await welcomedEventually(stub);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.type).toBe('complete');
    expect(posts[1]?.text).toContain('Welcome to Spoken mode!');
    expect(await readPending(stub, 'spoken')).toBeUndefined();
    expect(await readPendingAny(stub)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 3 — pending marker gates the per-slug reads
// ─────────────────────────────────────────────────────────────────────────────

describe('#422 item 3 — steady-state turns skip the per-slug pending reads', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const pendingGets = (gets: string[]) => gets.filter((k) => k.startsWith(PENDING_PREFIX));

  it('a plain same-mode turn with an alias does ZERO mode_welcome_pending:* reads once nothing is pending', async () => {
    // Turn 1: explicit scan ⇒ welcomed (canonical flag). Turn 2: plain turn
    // initialises the marker from the live bits (none ⇒ false).
    await postChatFinalJson(stub, body('#spoken-v2 hi', ORG_MODES_RESLUGGED));
    await postChatFinalJson(stub, body('hello', ORG_MODES_RESLUGGED));
    expect(await readPendingAny(stub)).toBe(false);

    // Turn 3: steady state. Count the durable reads the pending lookup issues.
    const ops = await runInDurableObject(stub, (_instance, state) => recordStorageOps(state));
    const result = await postChatFinalJson(stub, body('hello again', ORG_MODES_RESLUGGED));
    expect(result.responses).toEqual(['ok']);

    // One cheap marker read, NO per-slug reads (canonical + alias would be 2).
    expect(ops.gets.filter((k) => k === PENDING_ANY_KEY)).toHaveLength(1);
    expect(pendingGets(ops.gets)).toEqual([]);
  });

  it('a legacy pending bit (written before the marker existed) still re-emits, then the marker reads false', async () => {
    await putKey(stub, 'selected_mode', 'spoken');
    await putKey(stub, `${PENDING_PREFIX}spoken`, true); // no marker alongside
    expect(await readPendingAny(stub)).toBeUndefined();

    const result = await postChatFinalJson(stub, body('hello'));

    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');
    expect(await readWelcomed(stub, 'spoken')).toBe(true);
    expect(await readPending(stub, 'spoken')).toBeUndefined();
    // The successful record cleared the last pending bit ⇒ marker is false.
    expect(await readPendingAny(stub)).toBe(false);
  });
});

describe('#422 item 3 — marker lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is armed by a failed delivery and cleared when the re-emit records', async () => {
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupStreamingFetch();
    await putKey(stub, 'selected_mode', 'spoken');

    await runProcessChat(stub, body('#spoken hi'), throwingWelcome());
    expect(await readPending(stub, 'spoken')).toBe(true);
    expect(await readPendingAny(stub)).toBe(true);

    const delivered: string[] = [];
    await runProcessChat(stub, body('hello again'), deliveringWelcome(delivered));
    expect(delivered).toHaveLength(1);
    expect(await readWelcomed(stub, 'spoken')).toBe(true);
    expect(await readPending(stub, 'spoken')).toBeUndefined();
    expect(await readPendingAny(stub)).toBe(false);
  });

  it("stays true while ANOTHER member's pending bit remains in a shared group DO", async () => {
    const groupStub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupStreamingFetch();

    // Alice's and Bob's deliveries both fail ⇒ two per-user pending bits.
    await runProcessChat(groupStub, groupBody('alice', '#spoken hi'), throwingWelcome());
    await runProcessChat(groupStub, groupBody('bob', '#spoken hi'), throwingWelcome());
    expect(await readPending(groupStub, 'alice:spoken')).toBe(true);
    expect(await readPending(groupStub, 'bob:spoken')).toBe(true);
    expect(await readPendingAny(groupStub)).toBe(true);

    // Alice's re-emit records: her bit clears, Bob's remains ⇒ marker stays true.
    const alice: string[] = [];
    await runProcessChat(groupStub, groupBody('alice', 'hello'), deliveringWelcome(alice));
    expect(alice).toHaveLength(1);
    expect(await readPending(groupStub, 'alice:spoken')).toBeUndefined();
    expect(await readPending(groupStub, 'bob:spoken')).toBe(true);
    expect(await readPendingAny(groupStub)).toBe(true);

    // Bob's re-emit records: the last bit clears ⇒ marker false.
    const bob: string[] = [];
    await runProcessChat(groupStub, groupBody('bob', 'hello'), deliveringWelcome(bob));
    expect(bob).toHaveLength(1);
    expect(await readPending(groupStub, 'bob:spoken')).toBeUndefined();
    expect(await readPendingAny(groupStub)).toBe(false);
  });
});
