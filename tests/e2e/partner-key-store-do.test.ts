/**
 * PartnerKeyStoreDO (admin-portal#354): the single writer for partner key
 * administration, in miniflare.
 *
 * - The ledger's operations against real DO storage (runInDurableObject, on a
 *   test-only instance so other suites sharing storage cannot interfere):
 *   create, rotate with grace and with 0 (chain kill), revoke chain and its
 *   short-circuits, complete lists (no truncation), the KV auth projection
 *   (into an in-memory KV).
 * - Projection failure: the change is committed, the response warns
 *   `auth_update_pending`, the key is marked owed, and the real DO alarm
 *   writes API_KEYS.
 * Concurrency through the real worker (the 'global' instance) is tested in
 * partner-api-keys.test.ts, which owns that instance.
 *
 * Skipped on Windows (SQLite/workerd incompatibility). Runs in CI on Linux.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerKeyStoreDO } from '../../src/durable-objects/partner-key-store-do';
import {
  AUTH_UPDATE_PENDING,
  PartnerKeyLedger,
  type LedgerEntry,
} from '../../src/services/partner-keys/ledger';
import { partnerKeyStatus, type PartnerKeyRecord } from '../../src/types/partner-keys';
import { sha256Hex } from '../../src/utils/crypto';
import { FakeKV } from '../helpers/fake-kv';
import { createMockLogger } from '../helpers/mock-logger';

const SECRET = 'test-partner-key-tag-secret';
const INPUT = { org: 'bcs', name: 'BCS prod', app: 'BCS app', createdBy: 'a@b.org' };

/** A test-only instance of the DO class (the worker uses 'global'). */
const stub = () => env.PARTNER_KEY_STORE.get(env.PARTNER_KEY_STORE.idFromName('ledger-test'));
let kv: FakeKV;

/** A KV binding whose writes always fail (an outage or the 1-write/s limit). */
const failingKv = {
  put: async () => {
    throw new Error('KV put failed (429)');
  },
} as unknown as KVNamespace;

/**
 * A KV binding whose put stalls until `fail()`: lets a test look at storage
 * while the projection is in flight (as if the DO died right then).
 */
function stallingKv(): { kv: KVNamespace; putCalled: Promise<void>; fail: () => void } {
  let signal: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const putCalled = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const put = () => {
    signal();
    return new Promise<void>((_resolve, rejectPut) => {
      reject = rejectPut;
    });
  };
  const fail = () => reject(new Error('the DO died before KV answered'));
  return { kv: { put } as unknown as KVNamespace, putCalled, fail };
}

/** A KV binding whose put never settles (a hung KV call). */
const hangingKv = {
  put: () => new Promise<void>(() => undefined),
} as unknown as KVNamespace;

const REQUEST_ID = 'req-test-1';
/** A test ledger over `storage` and `target`. */
const ledgerOver = (storage: DurableObjectStorage, target: KVNamespace) =>
  new PartnerKeyLedger({
    storage,
    kv: target,
    tagSecret: SECRET,
    logger: createMockLogger(),
    requestId: REQUEST_ID,
  });
/** Per-request loggers for retryProjections, remembered so tests can inspect them. */
function loggersById() {
  const made = new Map<string, ReturnType<typeof createMockLogger>>();
  const loggerFor = (requestId: string) => {
    const logger = made.get(requestId) ?? createMockLogger();
    made.set(requestId, logger);
    return logger;
  };
  return { made, loggerFor };
}

const failDelete = async () => {
  throw new Error('storage delete failed');
};

/** Real DO storage, except `delete` fails (projection bookkeeping breaks after commit). */
function storageWithFailingDelete(storage: DurableObjectStorage): DurableObjectStorage {
  return new Proxy(storage, {
    get(target, prop) {
      if (prop === 'delete') return failDelete;
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Run `fn` with a ledger over the DO's real storage (and a chosen KV). */
function withLedger<T>(
  fn: (ledger: PartnerKeyLedger, storage: DurableObjectStorage) => Promise<T>,
  target: KVNamespace = kv.asKV()
): Promise<T> {
  return runInDurableObject(stub(), async (_instance, state) =>
    fn(ledgerOver(state.storage, target), state.storage)
  );
}

async function reset(): Promise<void> {
  kv = new FakeKV();
  await runInDurableObject(stub(), async (_i, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
  });
}

beforeEach(reset);
afterEach(reset);

/** The projection the ledger wrote to the in-memory KV for this plaintext. */
const projected = async (plaintext: string) =>
  (await kv.get(`key:${await sha256Hex(plaintext)}`, 'json')) as PartnerKeyRecord | null;

describe('ledger: create, get, list and the KV projection', () => {
  it('stores the record in the DO and projects it to KV key:<hash>', async () => {
    const created = await withLedger((l) => l.create(INPUT));
    expect(created.warnings).toEqual([]);
    expect(await projected(created.plaintext)).toEqual(created.record);
    const got = await withLedger((l) => l.get(created.record.id));
    expect(got?.record).toEqual(created.record);
    expect(got?.hash).toBe(await sha256Hex(created.plaintext));
  });

  it('lists all keys or one org, newest first, completely (no page cap)', async () => {
    // 1200 synthetic keys in one org, written 60 at a time (DO puts take <=128 keys).
    const synthetic = Array.from({ length: 1200 }, (_, i) => {
      const id = `pk_${i.toString(16).padStart(16, '0')}`;
      const record = { ...INPUT, org: 'big', id, createdAt: new Date(i * 1000).toISOString() };
      return [
        [`rec:${id}`, { record, hash: `h${i}` }],
        [`org:big:${id}`, id],
      ] as const;
    });
    await withLedger(async (_l, storage) => {
      for (let i = 0; i < synthetic.length; i += 60) {
        await storage.put(Object.fromEntries(synthetic.slice(i, i + 60).flat()));
      }
    });
    await withLedger((l) => l.create(INPUT));
    const big = await withLedger((l) => l.list('big'));
    expect(big).toHaveLength(1200);
    expect(big[0]?.id).toBe(`pk_${(1199).toString(16).padStart(16, '0')}`);
    expect(await withLedger((l) => l.list())).toHaveLength(1201);
    expect(await withLedger((l) => l.list('bcs'))).toHaveLength(1);
  });
});

describe('ledger: rotate', () => {
  it('with grace: the old key expires later, the new key shares its namespace', async () => {
    const a = await withLedger((l) => l.create(INPUT));
    const result = await withLedger((l) => l.rotate(a.record.id, { graceSeconds: 3600 }));
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.revokedIds).toEqual([]);
    expect(result.previous).toMatchObject({ rotatedTo: result.record.id });
    expect(result.previous.revokedAt).toBeUndefined();
    expect(Date.parse(result.previous.expiresAt ?? '') - Date.parse(result.record.createdAt)).toBe(
      3600 * 1000
    );
    expect(result.record).toMatchObject({
      rotatedFrom: a.record.id,
      userNamespace: a.record.userNamespace,
    });
    expect(await projected(a.plaintext)).toEqual(result.previous);
    expect(await projected(result.plaintext)).toEqual(result.record);
  });

  it('with grace 0: revokes the rotated key and every in-grace predecessor', async () => {
    const a = await withLedger((l) => l.create(INPUT));
    const toB = await withLedger((l) => l.rotate(a.record.id, { graceSeconds: 3600 }));
    if (toB.status !== 'ok') throw new Error(toB.status);
    const toC = await withLedger((l) => l.rotate(toB.record.id, { graceSeconds: 0 }));
    if (toC.status !== 'ok') throw new Error(toC.status);
    expect(toC.revokedIds).toEqual([toB.record.id, a.record.id]);
    expect((await projected(a.plaintext))?.revokedAt).toBeDefined();
    expect((await projected(toB.plaintext))?.revokedAt).toBeDefined();
  });

  it('refuses an already-rotated, a revoked and an unknown key', async () => {
    const a = await withLedger((l) => l.create(INPUT));
    const toB = await withLedger((l) => l.rotate(a.record.id, { graceSeconds: 3600 }));
    if (toB.status !== 'ok') throw new Error(toB.status);
    expect(await withLedger((l) => l.rotate(a.record.id, { graceSeconds: 0 }))).toEqual({
      status: 'already_rotated',
      rotatedTo: toB.record.id,
    });
    await withLedger((l) => l.revoke(toB.record.id));
    expect(await withLedger((l) => l.rotate(toB.record.id, { graceSeconds: 0 }))).toEqual({
      status: 'revoked',
    });
    expect(await withLedger((l) => l.rotate('pk_0000000000000000', { graceSeconds: 0 }))).toEqual({
      status: 'not_found',
    });
  });
});

describe('ledger: revoke', () => {
  it('kills in-grace predecessors; revoking again writes nothing', async () => {
    const a = await withLedger((l) => l.create(INPUT));
    const toB = await withLedger((l) => l.rotate(a.record.id, { graceSeconds: 3600 }));
    if (toB.status !== 'ok') throw new Error(toB.status);
    const first = await withLedger((l) => l.revoke(toB.record.id, 'ops'));
    expect(first).toMatchObject({
      alreadyRevoked: false,
      revokedIds: [toB.record.id, a.record.id],
    });
    expect(partnerKeyStatus((await projected(a.plaintext))!, Date.now())).toBe('revoked');

    const before = await withLedger(async (_l, s) =>
      JSON.stringify([...(await s.list()).entries()])
    );
    const again = await withLedger((l) => l.revoke(toB.record.id, 'someone else'));
    expect(again).toMatchObject({ alreadyRevoked: true, revokedIds: [], warnings: [] });
    expect(again?.record.revokedBy).toBe('ops');
    const after = await withLedger(async (_l, s) =>
      JSON.stringify([...(await s.list()).entries()])
    );
    expect(after).toBe(before);
  });

  it('stops the chain walk at an already-revoked predecessor', async () => {
    const a = await withLedger((l) => l.create(INPUT));
    const toB = await withLedger((l) => l.rotate(a.record.id, { graceSeconds: 3600 }));
    if (toB.status !== 'ok') throw new Error(toB.status);
    const toC = await withLedger((l) => l.rotate(toB.record.id, { graceSeconds: 3600 }));
    if (toC.status !== 'ok') throw new Error(toC.status);
    // B revoked on its own: that already revoked A.
    await withLedger((l) => l.revoke(toB.record.id));
    const revokeC = await withLedger((l) => l.revoke(toC.record.id));
    expect(revokeC?.revokedIds).toEqual([toC.record.id]);
  });
});

describe('KV projection failure is retried by the DO alarm', () => {
  it('commits, warns auth_update_pending, marks the key owed, and the alarm writes KV', async () => {
    const created = await withLedger((l) => l.create(INPUT), failingKv);
    expect(created.warnings).toEqual([AUTH_UPDATE_PENDING]);
    expect(await projected(created.plaintext)).toBeNull();
    const owed = await withLedger(async (_l, s) => ({
      marker: await s.get(`proj:${created.record.id}`),
      alarm: await s.getAlarm(),
      entry: await s.get<LedgerEntry>(`rec:${created.record.id}`),
    }));
    expect(owed.marker).toEqual({ requestId: REQUEST_ID });
    expect(owed.alarm).not.toBeNull();
    expect(owed.entry?.record).toEqual(created.record);

    // The real alarm writes the real API_KEYS binding.
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const name = `key:${await sha256Hex(created.plaintext)}`;
    expect(await env.API_KEYS.get(name, 'json')).toEqual(created.record);
    expect(await withLedger(async (_l, s) => s.get(`proj:${created.record.id}`))).toBeUndefined();
    await env.API_KEYS.delete(name);
  });

  it('a retry that fails again keeps the key owed and re-arms the alarm', async () => {
    const created = await withLedger((l) => l.create(INPUT), failingKv);
    await withLedger(async (_l, s) => s.deleteAlarm());
    const retry = await withLedger((l) => l.retryProjections(loggersById().loggerFor), failingKv);
    expect(retry).toEqual({ retried: 1, remaining: 1 });
    const state = await withLedger(async (_l, s) => ({
      marker: await s.get(`proj:${created.record.id}`),
      alarm: await s.getAlarm(),
    }));
    expect(state).toMatchObject({ marker: { requestId: REQUEST_ID } });
    expect(state.alarm).not.toBeNull();
  });

  it('a later successful write settles a key owed from an earlier failure', async () => {
    const created = await withLedger((l) => l.create(INPUT), failingKv);
    const revoked = await withLedger((l) => l.revoke(created.record.id));
    expect(revoked?.warnings).toEqual([]);
    expect(await withLedger(async (_l, s) => s.get(`proj:${created.record.id}`))).toBeUndefined();
    expect((await projected(created.plaintext))?.revokedAt).toBeDefined();
  });
});

describe('a committed change always has its projection owed', () => {
  it('a revoke whose KV write never completes is still owed (marker + alarm in the commit) and the alarm projects it', async () => {
    const created = await withLedger((l) => l.create(INPUT));
    const { id } = created.record;
    const stalled = stallingKv();
    const snapshot = await runInDurableObject(stub(), async (_i, state) => {
      const revoking = ledgerOver(state.storage, stalled.kv).revoke(id);
      await stalled.putCalled; // committed; the KV write is in flight
      const seen = {
        entry: await state.storage.get<LedgerEntry>(`rec:${id}`),
        marker: await state.storage.get(`proj:${id}`),
        alarm: await state.storage.getAlarm(),
      };
      stalled.fail(); // the projection never lands
      return { ...seen, outcome: await revoking };
    });
    expect(snapshot.entry?.record.revokedAt).toBeDefined();
    expect(snapshot.marker).toEqual({ requestId: REQUEST_ID });
    expect(snapshot.outcome?.warnings).toEqual(['auth_update_pending']);
    expect(snapshot.alarm).not.toBeNull();
    // KV (what auth reads) still says active until the owed projection runs.
    expect((await projected(created.plaintext))?.revokedAt).toBeUndefined();

    const logs = loggersById();
    expect(await withLedger((l) => l.retryProjections(logs.loggerFor))).toEqual({
      retried: 1,
      remaining: 0,
    });
    expect((await projected(created.plaintext))?.revokedAt).toBeDefined();
    // The retry is logged under the request that owed it, not a random id.
    expect([...logs.made.keys()]).toEqual([REQUEST_ID]);
    expect(logs.made.get(REQUEST_ID)?.log).toHaveBeenCalledWith('partner_key_projection_retried', {
      key_id: id,
      found: true,
    });
  });

  it('a clean change leaves nothing owed and no alarm', async () => {
    const created = await withLedger((l) => l.create(INPUT));
    const state = await withLedger(async (_l, s) => ({
      owed: (await s.list({ prefix: 'proj:' })).size,
      alarm: await s.getAlarm(),
    }));
    expect(created.warnings).toEqual([]);
    expect(state).toEqual({ owed: 0, alarm: null });
  });
});

describe('after the commit nothing can fail create', () => {
  it('bookkeeping errors still return the plaintext, with auth_update_pending', async () => {
    const created = await runInDurableObject(stub(), async (_i, state) => {
      const storage = storageWithFailingDelete(state.storage);
      return ledgerOver(storage, kv.asKV()).create(INPUT);
    });
    expect(created.plaintext).toMatch(/^bts_/);
    expect(created.warnings).toEqual(['auth_update_pending']);
    // The KV put itself succeeded; the marker stays for the alarm (an idempotent re-put).
    expect(await projected(created.plaintext)).toEqual(created.record);
    expect(await withLedger(async (_l, s) => s.get(`proj:${created.record.id}`))).toEqual({
      requestId: REQUEST_ID,
    });
  });
});

describe('an owed retry is never pushed back', () => {
  it('a later commit keeps an earlier-due alarm, and only ever moves it earlier', async () => {
    await withLedger((l) => l.create(INPUT), failingKv); // owed: alarm due in ~30s
    const soon = Date.now() + 5_000;
    await withLedger(async (_l, s) => s.setAlarm(soon));
    await withLedger((l) => l.create(INPUT)); // a commit 25s "later" must not move it
    expect(await withLedger(async (_l, s) => s.getAlarm())).toBe(soon);

    const far = Date.now() + 10 * 60_000;
    await withLedger(async (_l, s) => s.setAlarm(far));
    const before = Date.now();
    await withLedger((l) => l.create(INPUT), failingKv);
    const due = await withLedger(async (_l, s) => s.getAlarm());
    expect(due).toBeLessThan(far);
    expect(due).toBeGreaterThanOrEqual(before + 30_000);
  });
});

describe('revoking an already-revoked key whose projection is still owed', () => {
  it('re-attempts the projection: pending while KV fails, settled once it works', async () => {
    const created = await withLedger((l) => l.create(INPUT));
    await withLedger((l) => l.revoke(created.record.id), failingKv); // revocation owed
    const again = await withLedger((l) => l.revoke(created.record.id), failingKv);
    expect(again).toMatchObject({ alreadyRevoked: true, warnings: ['auth_update_pending'] });

    const settled = await withLedger((l) => l.revoke(created.record.id));
    expect(settled).toMatchObject({ alreadyRevoked: true, revokedIds: [], warnings: [] });
    expect((await projected(created.plaintext))?.revokedAt).toBeDefined();
    expect(await withLedger(async (_l, s) => s.get(`proj:${created.record.id}`))).toBeUndefined();
  });
});

describe('the DO alarm', () => {
  it('logs and re-throws a failure, keeping an alarm scheduled while projections are owed', async () => {
    await withLedger((l) => l.create(INPUT), failingKv);
    await withLedger(async (_l, s) => s.deleteAlarm());
    const spy = vi
      .spyOn(PartnerKeyLedger.prototype, 'retryProjections')
      .mockRejectedValue(new Error('storage list failed'));
    try {
      await expect(
        runInDurableObject(stub(), async (instance) => (instance as PartnerKeyStoreDO).alarm())
      ).rejects.toThrow('storage list failed');
    } finally {
      spy.mockRestore();
    }
    expect(await withLedger(async (_l, s) => s.getAlarm())).not.toBeNull();
  });
});

describe('re-revoking re-attempts the owed projections of the whole killed chain', () => {
  it('reports pending while KV fails, then settles the key and its predecessor', async () => {
    const a = await withLedger((l) => l.create(INPUT));
    const toB = await withLedger((l) => l.rotate(a.record.id, { graceSeconds: 3600 }));
    if (toB.status !== 'ok') throw new Error(toB.status);
    const first = await withLedger((l) => l.revoke(toB.record.id), failingKv);
    expect(first?.revokedIds).toEqual([toB.record.id, a.record.id]);

    const again = await withLedger((l) => l.revoke(toB.record.id), failingKv);
    expect(again).toMatchObject({ alreadyRevoked: true, warnings: ['auth_update_pending'] });

    const settled = await withLedger((l) => l.revoke(toB.record.id));
    expect(settled?.warnings).toEqual([]);
    expect((await projected(a.plaintext))?.revokedAt).toBeDefined();
    expect((await projected(toB.plaintext))?.revokedAt).toBeDefined();
    const owed = await withLedger(async (_l, s) => (await s.list({ prefix: 'proj:' })).size);
    expect(owed).toBe(0);
  });
});

describe('a KV call that never settles times out as a projection failure', () => {
  const hangingLedger = (storage: DurableObjectStorage) =>
    new PartnerKeyLedger({
      storage,
      kv: hangingKv,
      tagSecret: SECRET,
      logger: createMockLogger(),
      requestId: REQUEST_ID,
      kvTimeoutMs: 20,
    });

  it('create and the alarm retry both settle; the key stays owed with an alarm', async () => {
    const created = await withLedger((_l, s) => hangingLedger(s).create(INPUT));
    expect(created.warnings).toEqual([AUTH_UPDATE_PENDING]);
    await withLedger(async (_l, s) => s.deleteAlarm());
    const retry = await withLedger((_l, s) =>
      hangingLedger(s).retryProjections(loggersById().loggerFor)
    );
    expect(retry).toEqual({ retried: 1, remaining: 1 });
    const state = await withLedger(async (_l, s) => ({
      marker: await s.get(`proj:${created.record.id}`),
      alarm: await s.getAlarm(),
    }));
    expect(state.marker).toEqual({ requestId: REQUEST_ID });
    expect(state.alarm).not.toBeNull();
  });
});
