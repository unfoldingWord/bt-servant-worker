/**
 * Partner-key store (admin-portal#354), round-5 behaviour against FakeKV:
 *
 * - rotation post-commit steps are non-fatal: once the old record names the
 *   new key, a failed re-read or chain revoke is logged
 *   (`partner_key_rotation_followup_failed`) and reported in `warnings`, and
 *   the new plaintext is still returned;
 * - the list reports `truncated` when the index walk hits its page cap;
 * - revoke and rotate re-read the record by its hash (no ptr: indirection).
 */
import { describe, expect, it } from 'vitest';
import {
  createPartnerKey,
  getPartnerKeyById,
  listPartnerKeys,
  revokePartnerKey,
  rotatePartnerKey,
} from '../../src/services/partner-keys/store.js';
import { partnerKeyStatus } from '../../src/types/partner-keys.js';
import { FakeKV } from '../helpers/fake-kv.js';
import { createMockLogger } from '../helpers/mock-logger.js';

const INPUT = { org: 'bcs', name: 'BCS prod', app: 'BCS app', createdBy: 'a@b.org' };

async function seed(kv: FakeKV, org = 'bcs') {
  return createPartnerKey(kv.asKV(), { ...INPUT, org }, { logger: createMockLogger() });
}

describe('rotatePartnerKey: post-commit failures are non-fatal', () => {
  it('a failed verification re-read still returns the new key, with rotation_unverified', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    // The pre-write read succeeds; fail only the read after our commit.
    kv.afterPut(`key:${old.hash}`, () => kv.failGet(`key:${old.hash}`));
    const logger = createMockLogger();
    const result = await rotatePartnerKey(kv.asKV(), old.record.id, {
      graceSeconds: 3600,
      logger,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.plaintext).toMatch(/^bts_/);
    expect(result.warnings).toEqual(['rotation_unverified']);
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_rotation_followup_failed',
      expect.any(Error),
      expect.objectContaining({
        key_id: old.record.id,
        new_key_id: result.record.id,
        step: 'verify',
      })
    );
    const replacement = await getPartnerKeyById(kv.asKV(), result.record.id);
    expect(replacement?.record.revokedAt).toBeUndefined();
  });
});

describe('rotatePartnerKey: a failed chain revoke is non-fatal', () => {
  it('a failed chain revoke (grace 0) still returns the new key, with chain_revoke_incomplete', async () => {
    const kv = new FakeKV();
    const a = await seed(kv);
    const logger = createMockLogger();
    const toB = await rotatePartnerKey(kv.asKV(), a.record.id, { graceSeconds: 3600, logger });
    if (toB.status !== 'ok') throw new Error('rotate A failed');
    // A is still in grace; revoking it as part of B's grace-0 rotation fails.
    kv.failPut(`key:${a.hash}`);
    const toC = await rotatePartnerKey(kv.asKV(), toB.record.id, { graceSeconds: 0, logger });
    expect(toC.status).toBe('ok');
    if (toC.status !== 'ok') return;
    expect(toC.plaintext).toMatch(/^bts_/);
    expect(toC.warnings).toEqual(['chain_revoke_incomplete']);
    expect(toC.revokedIds).toEqual([toB.record.id]);
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_rotation_followup_failed',
      expect.any(Error),
      expect.objectContaining({ key_id: toB.record.id, step: 'chain_revoke' })
    );
  });

  it('a clean rotation has no warnings', async () => {
    const kv = new FakeKV();
    const old = await seed(kv);
    const result = await rotatePartnerKey(kv.asKV(), old.record.id, {
      graceSeconds: 0,
      logger: createMockLogger(),
    });
    expect(result.status === 'ok' && result.warnings).toEqual([]);
  });
});

describe('listPartnerKeys truncation', () => {
  it('reports truncated: true when the index walk hits its page cap', async () => {
    const kv = new FakeKV();
    kv.pageSize = 1;
    for (let i = 0; i < 21; i++) await seed(kv);
    const logger = createMockLogger();
    const { records, truncated } = await listPartnerKeys(kv.asKV(), 'bcs', logger);
    expect(truncated).toBe(true);
    expect(records).toHaveLength(20);
    expect(logger.warn).toHaveBeenCalledWith(
      'partner_key_list_truncated',
      expect.objectContaining({ org: 'bcs' })
    );
  });

  it('reports truncated: false when every page was read', async () => {
    const kv = new FakeKV();
    kv.pageSize = 1;
    for (let i = 0; i < 3; i++) await seed(kv);
    const { records, truncated } = await listPartnerKeys(kv.asKV(), 'bcs', createMockLogger());
    expect(truncated).toBe(false);
    expect(records).toHaveLength(3);
  });
});

describe('re-reads go straight to key:<hash>', () => {
  it('revoke reads ptr: once (to find the hash), then the record by hash', async () => {
    const kv = new FakeKV();
    const { record, hash } = await seed(kv);
    const keysRead: string[] = [];
    const realGet = kv.get.bind(kv);
    kv.get = async (key, type) => {
      keysRead.push(key);
      return realGet(key, type);
    };
    await revokePartnerKey(kv.asKV(), record.id, { logger: createMockLogger() });
    expect(keysRead.filter((k) => k === `ptr:${record.id}`)).toHaveLength(1);
    expect(keysRead.filter((k) => k === `key:${hash}`).length).toBeGreaterThanOrEqual(2);
    const now = await getPartnerKeyById(kv.asKV(), record.id);
    expect(partnerKeyStatus(now!.record, Date.now())).toBe('revoked');
  });

  it('rotate reads ptr: only for the initial lookup', async () => {
    const kv = new FakeKV();
    const { record } = await seed(kv);
    const keysRead: string[] = [];
    const realGet = kv.get.bind(kv);
    kv.get = async (key, type) => {
      keysRead.push(key);
      return realGet(key, type);
    };
    await rotatePartnerKey(kv.asKV(), record.id, {
      graceSeconds: 3600,
      logger: createMockLogger(),
    });
    expect(keysRead.filter((k) => k === `ptr:${record.id}`)).toHaveLength(1);
  });
});
