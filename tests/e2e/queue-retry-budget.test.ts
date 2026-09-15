/**
 * E2E tests for the queue byte budget on the RETRY path (codex re-review of PR #434).
 *
 * `dequeueNext` reserves the dequeued entry's bytes until the turn ends, so:
 *   - enqueues that arrive while a large entry is in flight are budgeted as if
 *     that entry were still queued, and a transient-failure `reEnqueue` always fits;
 *   - a reservation older than the lock staleness threshold is ignored (a dead
 *     turn must not shrink the budget for good);
 *   - if a retry no longer fits (reservation expired + queue refilled), it is
 *     dropped as a permanent failure instead of exceeding the storage value limit.
 *
 * All queue mutations happen inside one DO event with `queue_processing` set,
 * so no alarm ever drains what the assertions inspect.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildChatBody,
  setupAnthropicFetchCapture,
  type AnthropicCapture,
} from '../helpers/anthropic-capture.js';
import {
  MAX_QUEUE_BYTES,
  QUEUE_REJECT_BYTES,
  liveInFlightBytes,
} from '../../src/durable-objects/user-do.js';
import { MAX_CLIENT_HISTORY_FIELD_CHARS } from '../../src/utils/history-validation.js';
import type { ChatRequest } from '../../src/types/engine.js';
import type { InternalQueueEntry } from '../../src/types/queue.js';
import { createRequestLogger, type RequestLogger } from '../../src/utils/logger.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

/** White-box handles to the DO's private queue machinery. */
interface QueueInstance {
  enqueueEntry(entry: InternalQueueEntry, maxDepth: number): Promise<number>;
  dequeueNext(): Promise<InternalQueueEntry | null>;
  reEnqueue(entry: InternalQueueEntry): Promise<boolean>;
  handleProcessingError(
    entry: InternalQueueEntry,
    error: unknown,
    logger: RequestLogger
  ): Promise<void>;
}

const STALE_MS = 90_000;

/** ~406 KiB valid body: three fit under the 1.5 MiB budget, a fourth does not. */
function bigEntry(id: string): InternalQueueEntry {
  const big = 'x'.repeat(MAX_CLIENT_HISTORY_FIELD_CHARS);
  const history = Array.from({ length: 13 }, () => ({
    user_message: big,
    assistant_response: big,
  }));
  const body: ChatRequest = buildChatBody({
    message: 'next',
    history,
    progress_callback_url: 'https://hook.example.test/cb',
    message_key: id,
    _transport: 'callback',
  });
  return { message_id: id, body, enqueued_at: Date.now(), retry_count: 0 };
}

function queueIds(state: DurableObjectState): Promise<string[]> {
  return state.storage
    .get<InternalQueueEntry[]>('queue')
    .then((q) => (q ?? []).map((e) => e.message_id));
}

describe('liveInFlightBytes', () => {
  it('counts a fresh reservation and ignores a stale or missing one', () => {
    const now = 1_000_000;
    expect(liveInFlightBytes(undefined, now)).toBe(0);
    expect(liveInFlightBytes({ bytes: 500, at: now - 1_000 }, now)).toBe(500);
    expect(liveInFlightBytes({ bytes: 500, at: now - STALE_MS }, now)).toBe(0);
  });
});

describe('queue byte budget — in-flight reservation', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps counting a dequeued entry so its retry always fits', async () => {
    const r = await runInDurableObject(stub, async (instance, state) => {
      const q = instance as unknown as QueueInstance;
      await state.storage.put('queue_processing', true);
      await q.enqueueEntry(bigEntry('A'), 50);
      const inFlight = await q.dequeueNext();
      const reservation = await state.storage.get<{ bytes: number; at: number }>('queue_inflight');
      const positions = [
        await q.enqueueEntry(bigEntry('B'), 50),
        await q.enqueueEntry(bigEntry('C'), 50),
        await q.enqueueEntry(bigEntry('D'), 50), // A(reserved)+B+C+D would cross the budget
      ];
      const reinserted = await q.reEnqueue({ ...inFlight!, retry_count: 1 });
      const ids = await queueIds(state);
      const bytes = new TextEncoder().encode(
        JSON.stringify(await state.storage.get('queue'))
      ).byteLength;
      const afterRetry = await state.storage.get('queue_inflight');
      const dAgain = await q.enqueueEntry(bigEntry('D'), 50);
      return {
        inFlightId: inFlight?.message_id,
        reservation,
        positions,
        reinserted,
        ids,
        bytes,
        afterRetry,
        dAgain,
      };
    });

    expect(r.inFlightId).toBe('A');
    expect(r.reservation?.bytes).toBeGreaterThan(400 * 1024);
    expect(r.positions).toEqual([1, 2, QUEUE_REJECT_BYTES]);
    expect(r.reinserted).toBe(true);
    expect(r.ids).toEqual(['A', 'B', 'C']);
    expect(r.bytes).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    expect(r.afterRetry).toBeUndefined();
    expect(r.dAgain).toBe(QUEUE_REJECT_BYTES);
  });
});

describe('queue byte budget — stale reservation', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });
  afterEach(() => vi.restoreAllMocks());

  it('ignores a stale reservation so a dead turn cannot shrink the budget for good', async () => {
    const position = await runInDurableObject(stub, async (instance, state) => {
      const q = instance as unknown as QueueInstance;
      await state.storage.put('queue_processing', true);
      await state.storage.put('queue_inflight', {
        bytes: MAX_QUEUE_BYTES,
        at: Date.now() - STALE_MS,
      });
      return q.enqueueEntry(bigEntry('B'), 50);
    });
    expect(position).toBe(1);
  });
});

describe('queue byte budget — retry that no longer fits', () => {
  let stub: DurableObjectStub;
  let capture: AnthropicCapture;
  let errors: string[];

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    capture = setupAnthropicFetchCapture();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('is dropped as a permanent failure instead of exceeding the storage value limit', async () => {
    const r = await runInDurableObject(stub, async (instance, state) => {
      const q = instance as unknown as QueueInstance;
      await state.storage.put('queue_processing', true);
      // A was dequeued long enough ago that its reservation expired, and the
      // queue refilled to the budget meanwhile.
      const a = bigEntry('A');
      await state.storage.put('queue_inflight', { bytes: 1, at: Date.now() - STALE_MS });
      for (const id of ['B', 'C', 'D']) await q.enqueueEntry(bigEntry(id), 50);
      const before = await queueIds(state);
      await q.handleProcessingError(
        a,
        new Error('Network error'),
        createRequestLogger('test-retry')
      );
      const after = await queueIds(state);
      return { before, after };
    });

    expect(r.before).toEqual(['B', 'C', 'D']);
    expect(r.after).toEqual(['B', 'C', 'D']);
    expect(errors.some((line) => line.includes('queue_retry_dropped_over_budget'))).toBe(true);
    // The turn was counted as a permanent failure (a failed `chat_turn` record), not silently lost.
    expect(capture.logs.some((l) => l.event === 'chat_turn')).toBe(true);
  });
});

describe('queue byte budget — retry that still fits (control)', () => {
  let stub: DurableObjectStub;
  let errors: string[];

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('control: the same transient error with room in the queue is retried', async () => {
    const r = await runInDurableObject(stub, async (instance, state) => {
      const q = instance as unknown as QueueInstance;
      await state.storage.put('queue_processing', true);
      await q.enqueueEntry(bigEntry('B'), 50);
      await q.handleProcessingError(
        bigEntry('A'),
        new Error('Network error'),
        createRequestLogger('t')
      );
      const ids = await queueIds(state);
      const retried = (await state.storage.get<InternalQueueEntry[]>('queue'))?.[0]?.retry_count;
      return { ids, retried };
    });
    expect(r.ids).toEqual(['A', 'B']);
    expect(r.retried).toBe(1);
    expect(errors.some((line) => line.includes('queue_retry_dropped_over_budget'))).toBe(false);
  });
});
