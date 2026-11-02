/**
 * Store-level tests for partner API keys (admin-portal#354) against an
 * in-memory KV that can inject failures and concurrent writes:
 *
 * - list is served by `kv.list()` metadata alone (no per-key reads);
 * - a worst-case record fits KV's 1024-byte metadata limit;
 * - rotation: old-record write failure is compensated (new key revoked, old
 *   untouched); compensation failure is logged as an orphan; a concurrent
 *   writer that replaces `rotatedTo` makes the rotation report a conflict and
 *   revoke its own new key.
 */
import { describe, expect, it } from 'vitest';
import {
  assertFitsMetadata,
  createPartnerKey,
  getPartnerKeyById,
  KV_METADATA_MAX_BYTES,
  listPartnerKeys,
  revokePartnerKey,
  rotatePartnerKey,
} from '../../src/services/partner-keys/store.js';
import {
  partnerKeyStatus,
  validatePartnerKeyCreate,
  type PartnerKeyRecord,
} from '../../src/types/partner-keys.js';
import { FakeKV } from '../helpers/fake-kv.js';
import { createMockLogger } from '../helpers/mock-logger.js';

const INPUT = { org: 'bcs', name: 'BCS prod', app: 'BCS app', createdBy: 'a@b.org' };

async function seed(kv: FakeKV, org = 'bcs') {
  return createPartnerKey(kv.asKV(), { ...INPUT, org }, { logger: createMockLogger() });
}

const allKeyIds = (records: PartnerKeyRecord[]): string[] => records.map((r) => r.id).sort();

describe('listPartnerKeys', () => {
  it('serves the list from index metadata without any per-key get', async () => {
    const kv = new FakeKV();
    const a = await seed(kv, 'org-a');
    const b = await seed(kv, 'org-b');
    kv.gets = 0;
    const { records: all } = await listPartnerKeys(kv.asKV(), undefined, createMockLogger());
    expect(allKeyIds(all)).toEqual([a.record.id, b.record.id].sort());
    const { records: onlyA } = await listPartnerKeys(kv.asKV(), 'org-a', createMockLogger());
    expect(allKeyIds(onlyA)).toEqual([a.record.id]);
    expect(kv.gets).toBe(0);
  });

  it('reflects revocation through the refreshed index metadata', async () => {
    const kv = new FakeKV();
    const { record } = await seed(kv);
    await revokePartnerKey(kv.asKV(), record.id, { logger: createMockLogger() });
    const {
      records: [listed],
    } = await listPartnerKeys(kv.asKV(), 'bcs', createMockLogger());
    expect(listed?.revokedAt).toBeDefined();
  });
});

describe('metadata size', () => {
  it('a worst-case record (max-size multibyte fields) fits KV metadata', () => {
    // 3-byte UTF-8 characters, as many as each field's byte cap allows.
    const fill = (bytes: number) => '€'.repeat(Math.floor(bytes / 3));
    const validated = validatePartnerKeyCreate({
      org: 'o'.repeat(64),
      name: fill(100),
      app: fill(100),
      createdBy: fill(120),
      termsVersion: fill(32),
      termsAcceptedAt: '2026-11-02T00:00:00Z',
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const record: PartnerKeyRecord = {
      ...validated.input,
      id: 'pk_0123456789abcdef',
      prefix: 'bts_01234567',
      createdAt: '2026-11-02T00:00:00.000Z',
      scopes: ['chat'],
      userNamespace: 'pk_0123456789abcdef',
      revokedAt: '2026-11-02T00:00:00.000Z',
      expiresAt: '2026-11-09T00:00:00.000Z',
      revokedBy: fill(120),
      rotatedFrom: 'pk_0123456789abcdef',
      rotatedTo: 'pk_0123456789abcdef',
    };
    expect(() => assertFitsMetadata(record)).not.toThrow();
    expect(new TextEncoder().encode(JSON.stringify(record)).length).toBeLessThanOrEqual(
      KV_METADATA_MAX_BYTES
    );
  });

  it('rejects labels over their byte cap even when under it in characters', () => {
    const result = validatePartnerKeyCreate({ ...INPUT, name: '€'.repeat(40) });
    expect(result.ok).toBe(false);
  });
});

describe('rotatePartnerKey failure handling', () => {
  it('compensates when the old-record write fails: new key revoked, old untouched', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    kv.failPut(`key:${old.hash}`);
    const logger = createMockLogger();
    await expect(
      rotatePartnerKey(kv.asKV(), old.record.id, { graceSeconds: 0, logger })
    ).rejects.toThrow('injected put failure');

    const stillOld = await getPartnerKeyById(kv.asKV(), old.record.id);
    expect(stillOld?.record.revokedAt).toBeUndefined();
    const { records: all } = await listPartnerKeys(kv.asKV(), 'bcs', createMockLogger());
    const replacement = all.find((r) => r.rotatedFrom === old.record.id);
    expect(replacement?.revokedAt).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'partner_key_rotation_compensated',
      expect.objectContaining({ new_key_id: replacement?.id })
    );
  });

  it('logs an orphan when the compensation also fails', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    // Let the new key's two writes (key:, then id:) through, then fail every
    // later `key:` write: the old-record update AND the compensation.
    const realPut = kv.put.bind(kv);
    let creating = true;
    kv.put = async (key, value, opts) => {
      if (!creating && key.startsWith('key:')) throw new Error('compensation failure');
      if (key.startsWith('id:') && creating) creating = false;
      return realPut(key, value, opts);
    };
    const logger = createMockLogger();
    await expect(
      rotatePartnerKey(kv.asKV(), old.record.id, { graceSeconds: 0, logger })
    ).rejects.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_rotation_orphan',
      expect.any(Error),
      expect.objectContaining({ new_key_id: expect.stringMatching(/^pk_/) })
    );
  });
});

describe('rotatePartnerKey concurrency', () => {
  it('reports a conflict and revokes its own new key when a concurrent write wins', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    // Simulate a concurrent revoke landing right after our write of the old record.
    kv.afterPut(`key:${old.hash}`, () => {
      const current = JSON.parse(kv.store.get(`key:${old.hash}`)!.value) as PartnerKeyRecord;
      const { rotatedTo: _ours, ...rest } = current;
      kv.store.set(`key:${old.hash}`, { value: JSON.stringify({ ...rest, revokedBy: 'other' }) });
    });
    const result = await rotatePartnerKey(kv.asKV(), old.record.id, {
      graceSeconds: 0,
      logger: createMockLogger(),
    });
    expect(result.status).toBe('conflict');
    const { records: all } = await listPartnerKeys(kv.asKV(), 'bcs', createMockLogger());
    const replacement = all.find((r) => r.rotatedFrom === old.record.id);
    expect(replacement?.revokedAt).toBeDefined();
  });
});

describe('rotatePartnerKey grace window', () => {
  it('keeps the old key active until expiresAt = now + grace, then it is expired', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    const result = await rotatePartnerKey(kv.asKV(), old.record.id, {
      graceSeconds: 3600,
      logger: createMockLogger(),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const { previous } = result;
    expect(previous.revokedAt).toBeUndefined();
    expect(previous.rotatedTo).toBe(result.record.id);
    const expiresAt = Date.parse(previous.expiresAt ?? '');
    expect(expiresAt - Date.parse(result.record.createdAt)).toBe(3600 * 1000);
    expect(partnerKeyStatus(previous, expiresAt - 1)).toBe('active');
    expect(partnerKeyStatus(previous, expiresAt)).toBe('expired');
  });

  it('grace 0 revokes the old key immediately', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    const result = await rotatePartnerKey(kv.asKV(), old.record.id, {
      graceSeconds: 0,
      createdBy: 'ops@b.org',
      logger: createMockLogger(),
    });
    expect(result).toMatchObject({ status: 'ok', previous: { revokedBy: 'ops@b.org' } });
    if (result.status !== 'ok') return;
    expect(result.previous.expiresAt).toBeUndefined();
    expect(partnerKeyStatus(result.previous, Date.now())).toBe('revoked');
  });

  it('refuses to rotate a key that was already rotated (still in grace)', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    const opts = { graceSeconds: 3600, logger: createMockLogger() };
    const first = await rotatePartnerKey(kv.asKV(), old.record.id, opts);
    const second = await rotatePartnerKey(kv.asKV(), old.record.id, opts);
    expect(second).toEqual({
      status: 'already_rotated',
      rotatedTo: first.status === 'ok' ? first.record.id : '',
    });
  });
});

/** Read a stored record straight from the fake KV. */
function stored(kv: FakeKV, hash: string): PartnerKeyRecord {
  return JSON.parse(kv.store.get(`key:${hash}`)!.value) as PartnerKeyRecord;
}

/** Run `hook` once, right after the first put whose key matches `match`. */
function afterFirstPut(kv: FakeKV, match: (key: string) => boolean, hook: () => void): void {
  const realPut = kv.put.bind(kv);
  let fired = false;
  kv.put = async (key, value, opts) => {
    await realPut(key, value, opts);
    if (!fired && match(key)) {
      fired = true;
      hook();
    }
  };
}

const replacementOf = async (kv: FakeKV, oldId: string) =>
  (await listPartnerKeys(kv.asKV(), 'bcs', createMockLogger())).records.find(
    (r) => r.rotatedFrom === oldId
  );

describe('rotate vs concurrent revoke', () => {
  it('aborts (409) when the old key is revoked while the new key is being issued', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    // The concurrent revoke lands right after the new key's index write.
    afterFirstPut(
      kv,
      (key) => key.startsWith('id:') && !key.endsWith(old.record.id),
      () => {
        const revoked = { ...stored(kv, old.hash), revokedAt: '2026-11-02T00:00:00.000Z' };
        kv.store.set(`key:${old.hash}`, { value: JSON.stringify(revoked) });
      }
    );
    const result = await rotatePartnerKey(kv.asKV(), old.record.id, {
      graceSeconds: 3600,
      logger: createMockLogger(),
    });
    expect(result.status).toBe('conflict');
    expect(stored(kv, old.hash).revokedAt).toBeDefined();
    expect(stored(kv, old.hash).rotatedTo).toBeUndefined();
    expect((await replacementOf(kv, old.record.id))?.revokedAt).toBeDefined();
  });

  it('aborts (409) when a revoke lands after its write (rotatedTo kept, revokedAt added)', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    kv.afterPut(`key:${old.hash}`, () => {
      const revoked = { ...stored(kv, old.hash), revokedAt: '2026-11-02T00:00:00.000Z' };
      kv.store.set(`key:${old.hash}`, { value: JSON.stringify(revoked) });
    });
    const result = await rotatePartnerKey(kv.asKV(), old.record.id, {
      graceSeconds: 3600,
      logger: createMockLogger(),
    });
    expect(result.status).toBe('conflict');
    expect(stored(kv, old.hash).revokedAt).toBeDefined();
    expect((await replacementOf(kv, old.record.id))?.revokedAt).toBeDefined();
  });
});

describe('revoke vs concurrent rotate', () => {
  it('revoke re-applies revokedAt when a stale rotate write clobbers it', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    const beforeRevoke = stored(kv, old.hash);
    const logger = createMockLogger();
    // A rotate built from the pre-revoke read writes right after the revoke.
    kv.afterPut(`key:${old.hash}`, () => {
      const clobber = { ...beforeRevoke, rotatedTo: 'pk_00000000000000aa' };
      kv.store.set(`key:${old.hash}`, { value: JSON.stringify(clobber) });
    });
    await revokePartnerKey(kv.asKV(), old.record.id, { logger });
    expect(stored(kv, old.hash)).toMatchObject({
      rotatedTo: 'pk_00000000000000aa',
      revokedAt: expect.any(String),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'partner_key_revoke_reapplied',
      expect.objectContaining({ key_id: old.record.id })
    );
  });
});

describe('revoke kills the whole rotation chain', () => {
  it('revoking the newest key also revokes every predecessor still in grace', async () => {
    const kv = new FakeKV();
    const a = await seed(kv);
    const opts = { graceSeconds: 3600, logger: createMockLogger() };
    const toB = await rotatePartnerKey(kv.asKV(), a.record.id, opts);
    if (toB.status !== 'ok') throw new Error('rotate A failed');
    const toC = await rotatePartnerKey(kv.asKV(), toB.record.id, opts);
    if (toC.status !== 'ok') throw new Error('rotate B failed');

    const result = await revokePartnerKey(kv.asKV(), toC.record.id, { logger: opts.logger });
    expect(result?.revokedIds).toEqual([toC.record.id, toB.record.id, a.record.id]);
    const now = Date.now();
    for (const id of [a.record.id, toB.record.id, toC.record.id]) {
      const found = await getPartnerKeyById(kv.asKV(), id);
      expect(partnerKeyStatus(found!.record, now)).toBe('revoked');
    }
  });

  it('leaves an already-dead predecessor alone', async () => {
    const kv = new FakeKV();
    const a = await seed(kv);
    const toB = await rotatePartnerKey(kv.asKV(), a.record.id, {
      graceSeconds: 0,
      logger: createMockLogger(),
    });
    if (toB.status !== 'ok') throw new Error('rotate failed');
    const result = await revokePartnerKey(kv.asKV(), toB.record.id, { logger: createMockLogger() });
    expect(result?.revokedIds).toEqual([toB.record.id]);
  });
});

describe('createPartnerKey index-write failure', () => {
  const failIndexPuts = (kv: FakeKV) => {
    const realPut = kv.put.bind(kv);
    kv.put = async (key, value, opts) => {
      if (key.startsWith('id:')) throw new Error('index down');
      return realPut(key, value, opts);
    };
  };

  it('deletes the unindexed key: record and rethrows', async () => {
    const kv = new FakeKV();
    failIndexPuts(kv);
    await expect(
      createPartnerKey(kv.asKV(), INPUT, { logger: createMockLogger() })
    ).rejects.toThrow('index down');
    expect([...kv.store.keys()]).toEqual([]);
  });

  it('logs partner_key_create_orphan when the cleanup delete also fails', async () => {
    const kv = new FakeKV();
    failIndexPuts(kv);
    kv.delete = async () => {
      throw new Error('delete down');
    };
    const logger = createMockLogger();
    await expect(createPartnerKey(kv.asKV(), INPUT, { logger })).rejects.toThrow('index down');
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_create_orphan',
      expect.any(Error),
      expect.objectContaining({ new_key_id: expect.stringMatching(/^pk_/) })
    );
  });
});

describe('revoke vs rotate: successor issued in the race', () => {
  it('revokes the successor a clobbering rotate issued, and lists it in revokedIds', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    const logger = createMockLogger();
    // A concurrent rotate (read before the revoke) issues a real successor and
    // then writes the old record without revokedAt, right after the revoke's write.
    const successor = await createPartnerKey(
      kv.asKV(),
      { ...INPUT },
      { logger, carry: { userNamespace: old.record.userNamespace, rotatedFrom: old.record.id } }
    );
    const beforeRevoke = stored(kv, old.hash);
    kv.afterPut(`key:${old.hash}`, () => {
      const clobber = { ...beforeRevoke, rotatedTo: successor.record.id };
      kv.store.set(`key:${old.hash}`, { value: JSON.stringify(clobber) });
    });

    const result = await revokePartnerKey(kv.asKV(), old.record.id, { logger });
    expect(result?.revokedIds).toEqual([old.record.id, successor.record.id]);
    expect(stored(kv, old.hash).revokedAt).toBeDefined();
    expect(stored(kv, successor.hash).revokedAt).toBeDefined();
  });

  it('does not touch a successor when nothing raced (revoking an in-grace old key)', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    const logger = createMockLogger();
    const rotated = await rotatePartnerKey(kv.asKV(), old.record.id, {
      graceSeconds: 3600,
      logger,
    });
    if (rotated.status !== 'ok') throw new Error('rotate failed');
    const result = await revokePartnerKey(kv.asKV(), old.record.id, { logger });
    expect(result?.revokedIds).toEqual([old.record.id]);
    const successor = await getPartnerKeyById(kv.asKV(), rotated.record.id);
    expect(successor?.record.revokedAt).toBeUndefined();
  });
});

describe('rotate with graceSeconds 0 kills the whole chain', () => {
  it('revokes the rotated key and its in-grace predecessors', async () => {
    const kv = new FakeKV();
    const a = await seed(kv);
    const logger = createMockLogger();
    const toB = await rotatePartnerKey(kv.asKV(), a.record.id, { graceSeconds: 3600, logger });
    if (toB.status !== 'ok') throw new Error('rotate A failed');
    expect(toB.revokedIds).toEqual([]);
    const toC = await rotatePartnerKey(kv.asKV(), toB.record.id, { graceSeconds: 0, logger });
    if (toC.status !== 'ok') throw new Error('rotate B failed');
    expect(toC.revokedIds).toEqual([toB.record.id, a.record.id]);
    const aNow = await getPartnerKeyById(kv.asKV(), a.record.id);
    expect(partnerKeyStatus(aNow!.record, Date.now())).toBe('revoked');
  });
});

describe('index layout', () => {
  it('org-scoped list is a prefix list: org "bcs" does not include org "bcs2"', async () => {
    const kv = new FakeKV();
    const mine = await seed(kv, 'bcs');
    await seed(kv, 'bcs2');
    const { records: listed } = await listPartnerKeys(kv.asKV(), 'bcs', createMockLogger());
    expect(listed.map((r) => r.id)).toEqual([mine.record.id]);
    expect(kv.store.has(`id:bcs:${mine.record.id}`)).toBe(true);
    expect(kv.store.get(`ptr:${mine.record.id}`)?.value).toBe(mine.hash);
  });

  it('logs partner_key_rotation_orphan (not create) when a rotation index write and cleanup fail', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    const realPut = kv.put.bind(kv);
    kv.put = async (key, value, opts) => {
      if (key.startsWith('id:') && !key.endsWith(old.record.id)) throw new Error('index down');
      return realPut(key, value, opts);
    };
    kv.delete = async () => {
      throw new Error('delete down');
    };
    const logger = createMockLogger();
    await expect(
      rotatePartnerKey(kv.asKV(), old.record.id, { graceSeconds: 0, logger })
    ).rejects.toThrow('index down');
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_rotation_orphan',
      expect.any(Error),
      expect.objectContaining({ new_key_id: expect.stringMatching(/^pk_/) })
    );
  });
});
