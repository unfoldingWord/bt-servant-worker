/**
 * E2E tests for the #392 fields on the QUEUED transports (codex review of PR #434):
 *
 *   1. The callback path must deliver `history_entry` / `history_length` in the
 *      final `complete` webhook, not just on `/chat/final`. Drives the DO's real
 *      `processCallbackEntry` with the Anthropic call mocked as SSE (the callback
 *      path streams) and the webhook URL intercepted at `globalThis.fetch`.
 *   2. The callback/SSE queue is persisted as ONE storage value, so several
 *      individually valid near-cap bodies must be turned away with a 429 before
 *      the serialized queue passes `MAX_QUEUE_BYTES`, rather than failing the put.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { buildChatBody, readMockRequestBody } from '../helpers/anthropic-capture.js';
import { MAX_QUEUE_BYTES, QUEUE_REJECT_BYTES } from '../../src/durable-objects/user-do.js';
import { MAX_CLIENT_HISTORY_FIELD_CHARS } from '../../src/utils/history-validation.js';
import type { ChatRequest } from '../../src/types/engine.js';
import type { InternalQueueEntry } from '../../src/types/queue.js';
import { createRequestLogger, type RequestLogger } from '../../src/utils/logger.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const HOOK_URL = 'https://hook.example.test/cb';

/** White-box handles to the DO's private queue + callback machinery. */
interface QueueInstance {
  enqueueEntry(entry: InternalQueueEntry, maxDepth: number): Promise<number>;
  enqueueAndReturn(
    body: ChatRequest,
    messageId: string,
    workerOrigin: string,
    locale: string,
    logger: RequestLogger
  ): Promise<Response>;
  processCallbackEntry(entry: InternalQueueEntry, logger: RequestLogger): Promise<void>;
}

/** SSE-shaped single-message Anthropic response (the callback path streams). */
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
 * Stub the SDK ctor and intercept `globalThis.fetch`: Anthropic answers 'ok'
 * as SSE; POSTs to HOOK_URL are captured as parsed webhook payloads.
 */
function setupCallbackPathMocks(): { hooks: Array<Record<string, unknown>> } {
  const hooks: Array<Record<string, unknown>> = [];
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
    if (url.startsWith(HOOK_URL)) {
      const raw = await readMockRequestBody(input, init);
      hooks.push(JSON.parse(raw) as Record<string, unknown>);
      return new Response('ok', { status: 200 });
    }
    return realFetch(input, init);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { hooks };
}

function callbackBody(overrides: Partial<ChatRequest>): ChatRequest {
  return buildChatBody({
    message: 'next',
    progress_callback_url: HOOK_URL,
    message_key: 'm1',
    _transport: 'callback',
    ...overrides,
  });
}

function queueEntry(body: ChatRequest, id: string): InternalQueueEntry {
  return { message_id: id, body, enqueued_at: Date.now(), retry_count: 0 };
}

/**
 * A valid `history` of ~406 KiB (13 turns × 2 fields × 16k chars), well under
 * the per-request 512 KiB cap. Three fit under the 1.5 MiB queue budget
 * (~1.19 MiB); a fourth would cross it (~1.59 MiB).
 */
function nearCapHistory() {
  const big = 'x'.repeat(MAX_CLIENT_HISTORY_FIELD_CHARS);
  return Array.from({ length: 13 }, () => ({ user_message: big, assistant_response: big }));
}

describe('callback transport delivers the #392 receipt', () => {
  let stub: DurableObjectStub;
  let hooks: Array<Record<string, unknown>>;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    hooks = setupCallbackPathMocks().hooks;
  });
  afterEach(() => vi.restoreAllMocks());

  it('puts history_entry and history_length on the final complete webhook', async () => {
    const entry = queueEntry(callbackBody({ history: [], suppress_welcome: true }), 'm1');

    await runInDurableObject(stub, (instance) =>
      (instance as unknown as QueueInstance).processCallbackEntry(
        entry,
        createRequestLogger('test-callback')
      )
    );

    const complete = hooks.find((h) => h.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete?.text).toBe('ok');
    expect(complete?.history_length).toBe(1);
    expect(complete?.history_entry).toMatchObject({
      user_message: 'next',
      assistant_response: 'ok',
    });
    expect(typeof (complete?.history_entry as { timestamp: unknown }).timestamp).toBe('number');
  });

  it('adds nothing to the complete webhook when the request sent no history', async () => {
    const entry = queueEntry(callbackBody({}), 'm2');

    await runInDurableObject(stub, (instance) =>
      (instance as unknown as QueueInstance).processCallbackEntry(
        entry,
        createRequestLogger('test-callback')
      )
    );

    const complete = hooks.find((h) => h.type === 'complete');
    expect(complete?.text).toBe('ok');
    expect(complete).not.toHaveProperty('history_entry');
    expect(complete).not.toHaveProperty('history_length');
  });
});

describe('queue byte budget (one storage value)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupCallbackPathMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects the enqueue that would push the serialized queue past MAX_QUEUE_BYTES', async () => {
    const results = await runInDurableObject(stub, async (instance, state) => {
      const q = instance as unknown as QueueInstance;
      // Mark the queue as already draining so enqueue never arms the alarm —
      // nothing may drain what we queue while the assertions run.
      await state.storage.put('queue_processing', true);
      const positions: number[] = [];
      for (let i = 0; i < 5; i++) {
        const body = callbackBody({ history: nearCapHistory(), message_key: `m${i}` });
        positions.push(await q.enqueueEntry(queueEntry(body, `m${i}`), 50));
      }
      const stored = (await state.storage.get<InternalQueueEntry[]>('queue')) ?? [];
      const bytes = new TextEncoder().encode(JSON.stringify(stored)).byteLength;
      return { positions, storedLength: stored.length, bytes };
    });

    // Three fit under 1.5 MiB; the fourth would cross, and so would the fifth.
    expect(results.positions).toEqual([1, 2, 3, QUEUE_REJECT_BYTES, QUEUE_REJECT_BYTES]);
    expect(results.storedLength).toBe(3);
    expect(results.bytes).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
  });
});

describe('queue byte budget → client response', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupCallbackPathMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it('surfaces the rejection to the client as 429 QUEUE_BYTES_EXCEEDED with Retry-After', async () => {
    // Fill the budget and issue the rejected + accepted enqueues inside ONE DO
    // event: `enqueueAndReturn` is exactly what the /chat/callback route calls
    // after validation, and it owns the rejection → HTTP mapping under test.
    const logger = createRequestLogger('test-enqueue');
    const results = await runInDurableObject(stub, async (instance, state) => {
      const q = instance as unknown as QueueInstance;
      // As above: no alarm, so the three queued bodies stay put.
      await state.storage.put('queue_processing', true);
      for (let i = 0; i < 3; i++) {
        const body = callbackBody({ history: nearCapHistory(), message_key: `m${i}` });
        await q.enqueueEntry(queueEntry(body, `m${i}`), 50);
      }
      const big = callbackBody({ history: nearCapHistory(), message_key: 'm-big' });
      const rejected = await q.enqueueAndReturn(big, 'm-big', '', 'en', logger);
      const small = callbackBody({ message_key: 'm-small' });
      const accepted = await q.enqueueAndReturn(small, 'm-small', '', 'en', logger);
      const queueLen = ((await state.storage.get<InternalQueueEntry[]>('queue')) ?? []).length;
      return {
        rejected: {
          status: rejected.status,
          retryAfter: rejected.headers.get('Retry-After'),
          body: (await rejected.json()) as Record<string, unknown>,
        },
        acceptedStatus: accepted.status,
        queueLen,
      };
    });

    expect(results.rejected).toMatchObject({
      status: 429,
      retryAfter: '5',
      body: { code: 'QUEUE_BYTES_EXCEEDED', error: 'Queue full' },
    });
    // The small body still fits — the budget is about bytes, not depth.
    expect(results.acceptedStatus).toBe(202);
    expect(results.queueLen).toBe(4);
  });
});
