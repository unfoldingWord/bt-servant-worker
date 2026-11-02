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
import { validatePartnerKeyCreate, type PartnerKeyRecord } from '../../src/types/partner-keys.js';
import { FakeKV } from '../helpers/fake-kv.js';
import { createMockLogger } from '../helpers/mock-logger.js';

const INPUT = { org: 'bcs', name: 'BCS prod', app: 'BCS app', createdBy: 'a@b.org' };

async function seed(kv: FakeKV, org = 'bcs') {
  return createPartnerKey(kv.asKV(), { ...INPUT, org });
}

const allKeyIds = (records: PartnerKeyRecord[]): string[] => records.map((r) => r.id).sort();

describe('listPartnerKeys', () => {
  it('serves the list from index metadata without any per-key get', async () => {
    const kv = new FakeKV();
    const a = await seed(kv, 'org-a');
    const b = await seed(kv, 'org-b');
    kv.gets = 0;
    const all = await listPartnerKeys(kv.asKV(), undefined, createMockLogger());
    expect(allKeyIds(all)).toEqual([a.record.id, b.record.id].sort());
    const onlyA = await listPartnerKeys(kv.asKV(), 'org-a', createMockLogger());
    expect(allKeyIds(onlyA)).toEqual([a.record.id]);
    expect(kv.gets).toBe(0);
  });

  it('reflects revocation through the refreshed index metadata', async () => {
    const kv = new FakeKV();
    const { record } = await seed(kv);
    await revokePartnerKey(kv.asKV(), record.id, { logger: createMockLogger() });
    const [listed] = await listPartnerKeys(kv.asKV(), 'bcs', createMockLogger());
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
    await expect(rotatePartnerKey(kv.asKV(), old.record.id, { logger })).rejects.toThrow(
      'injected put failure'
    );

    const stillOld = await getPartnerKeyById(kv.asKV(), old.record.id);
    expect(stillOld?.record.revokedAt).toBeUndefined();
    const all = await listPartnerKeys(kv.asKV(), 'bcs', createMockLogger());
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
    await expect(rotatePartnerKey(kv.asKV(), old.record.id, { logger })).rejects.toThrow();
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
      logger: createMockLogger(),
    });
    expect(result.status).toBe('conflict');
    const all = await listPartnerKeys(kv.asKV(), 'bcs', createMockLogger());
    const replacement = all.find((r) => r.rotatedFrom === old.record.id);
    expect(replacement?.revokedAt).toBeDefined();
  });
});
