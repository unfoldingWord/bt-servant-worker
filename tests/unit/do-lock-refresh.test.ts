/**
 * Per-user processing lock under long turns (#481).
 *
 * The DO treats a lock older than 90 s as dead and lets the next message take
 * it over. Once the 90 s streaming cap was replaced by a stall timer, a live
 * turn can run well past 90 s, so the turn re-stamps its lock while it runs
 * (`refreshLock`, driven by the orchestrator). These tests pin both halves:
 * a refreshed lock keeps refusing a second message, and a lock nobody
 * refreshes (a crashed turn) still goes stale exactly as before.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { UserDO } from '../../src/durable-objects/user-do.js';
import type { Env } from '../../src/config/types.js';

const PROCESSING_LOCK_KEY = '_processing_lock';

interface LockInternals {
  tryAcquireLock(): Promise<boolean>;
  refreshLock(): Promise<void>;
  releaseLock(): Promise<void>;
}

function createDO() {
  const store = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string): Promise<unknown> => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => store.delete(key)),
    setAlarm: vi.fn(async () => undefined),
  };
  const state = {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
  const env = { DEFAULT_ORG: 'unfoldingWord' } as unknown as Env;
  return { userDo: new UserDO(state, env) as unknown as LockInternals, store, storage };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('processing lock refresh (#481)', () => {
  it('a turn that keeps refreshing its lock still refuses a second message after 90 s', async () => {
    vi.useFakeTimers();
    const { userDo } = createDO();
    expect(await userDo.tryAcquireLock()).toBe(true);

    // A 150 s turn refreshing every 30 s (the orchestrator's worst case is ~45 s).
    for (let t = 0; t < 150_000; t += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
      await userDo.refreshLock();
    }

    expect(await userDo.tryAcquireLock()).toBe(false);
  });

  it('a crashed turn (no refreshes) still goes stale after 90 s, as before', async () => {
    vi.useFakeTimers();
    const { userDo } = createDO();
    expect(await userDo.tryAcquireLock()).toBe(true);

    await vi.advanceTimersByTimeAsync(89_000);
    expect(await userDo.tryAcquireLock()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await userDo.tryAcquireLock()).toBe(true);
  });

  it('a refresh never re-creates a lock that was already released', async () => {
    const { userDo, store } = createDO();
    expect(await userDo.tryAcquireLock()).toBe(true);
    await userDo.releaseLock();

    await userDo.refreshLock();

    expect(store.has(PROCESSING_LOCK_KEY)).toBe(false);
    expect(await userDo.tryAcquireLock()).toBe(true);
  });

  it('a refresh in flight when the lock is released does not put it back', async () => {
    const { userDo, store, storage } = createDO();
    expect(await userDo.tryAcquireLock()).toBe(true);

    // Hold the refresh's read open; it will return the pre-release timestamp,
    // as a get issued before the delete does.
    const staleValue = store.get(PROCESSING_LOCK_KEY);
    let releaseRead: () => void = () => undefined;
    storage.get.mockImplementationOnce(
      () => new Promise((resolve) => (releaseRead = () => resolve(staleValue)))
    );
    const refreshing = userDo.refreshLock();

    await userDo.releaseLock();
    releaseRead();
    await refreshing;

    expect(store.has(PROCESSING_LOCK_KEY)).toBe(false);
    expect(await userDo.tryAcquireLock()).toBe(true);
  });
});
