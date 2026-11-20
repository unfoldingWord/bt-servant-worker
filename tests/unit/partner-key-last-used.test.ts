/**
 * Unit tests for "last used" recording of partner API keys (admin-portal#354):
 * the per-isolate throttle, background-only writes, and that a failed write
 * is logged, never thrown. The DO side (forward-only `used:` rows, the join
 * into list/get/revoke/rotate) is covered in tests/e2e/partner-key-store-do.test.ts
 * and the HTTP path in tests/e2e/partner-api-keys.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimLastUsedSlot,
  LAST_USED_THROTTLE_MS,
  recordPartnerKeyUse,
  resetLastUsedThrottle,
} from '../../src/services/partner-keys/last-used.js';
import { toPublicPartnerKey, type PartnerKeyRecord } from '../../src/types/partner-keys.js';
import { createMockLogger } from '../helpers/mock-logger.js';

const T0 = Date.parse('2026-11-13T12:00:00.000Z');

/** Run recordPartnerKeyUse and collect what it handed to waitUntil. */
function record(keyId: string, now: number, recordUse: (id: string) => Promise<boolean>) {
  const logger = createMockLogger();
  const background: Promise<unknown>[] = [];
  recordPartnerKeyUse({
    keyId,
    recordUse,
    waitUntil: (work) => background.push(work),
    logger,
    now,
  });
  return { logger, background };
}

beforeEach(() => resetLastUsedThrottle());

describe('claimLastUsedSlot: one recording per key per window per isolate', () => {
  it('allows the first use, refuses inside the window, allows again once it has passed', () => {
    expect(claimLastUsedSlot('pk_a', T0)).toBe(true);
    expect(claimLastUsedSlot('pk_a', T0 + 1)).toBe(false);
    expect(claimLastUsedSlot('pk_a', T0 + LAST_USED_THROTTLE_MS - 1)).toBe(false);
    expect(claimLastUsedSlot('pk_a', T0 + LAST_USED_THROTTLE_MS)).toBe(true);
  });

  it('throttles each key on its own', () => {
    expect(claimLastUsedSlot('pk_a', T0)).toBe(true);
    expect(claimLastUsedSlot('pk_b', T0 + 1)).toBe(true);
    expect(claimLastUsedSlot('pk_a', T0 + 2)).toBe(false);
  });
});

describe('recordPartnerKeyUse', () => {
  it('writes in the background only (never awaited by the caller) and logs the outcome', async () => {
    const recordUse = vi.fn(async () => true);
    const { logger, background } = record('pk_a', T0, recordUse);
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(recordUse).toHaveBeenCalledWith('pk_a');
    expect(logger.log).toHaveBeenCalledWith('partner_key_last_used_recorded', {
      key_id: 'pk_a',
      recorded: true,
    });
  });

  it('sends nothing for a second use inside the window, and again after it', async () => {
    const recordUse = vi.fn(async () => true);
    await Promise.all(record('pk_a', T0, recordUse).background);
    expect(record('pk_a', T0 + 60_000, recordUse).background).toHaveLength(0);
    await Promise.all(record('pk_a', T0 + LAST_USED_THROTTLE_MS, recordUse).background);
    expect(recordUse).toHaveBeenCalledTimes(2);
  });

  it('logs a failed write as an error and never rejects the background promise', async () => {
    const failure = new Error('DO unavailable');
    const { logger, background } = record('pk_a', T0, async () => {
      throw failure;
    });
    await Promise.all(background);
    expect(logger.error).toHaveBeenCalledWith('partner_key_last_used_write_failed', failure, {
      key_id: 'pk_a',
    });
  });

  it('a synchronous throw from the store client is caught and logged too', async () => {
    const { logger, background } = record('pk_a', T0, () => {
      throw new Error('bad binding');
    });
    await Promise.all(background);
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_last_used_write_failed',
      expect.any(Error),
      { key_id: 'pk_a' }
    );
  });

  it('keeps the throttle after a failure, so a failing store is retried once per window', async () => {
    const recordUse = vi.fn(async () => {
      throw new Error('DO unavailable');
    });
    await Promise.all(record('pk_a', T0, recordUse).background);
    expect(record('pk_a', T0 + 1000, recordUse).background).toHaveLength(0);
    expect(recordUse).toHaveBeenCalledTimes(1);
  });
});

describe('toPublicPartnerKey and lastUsedAt', () => {
  const base: PartnerKeyRecord = {
    id: 'pk_0123456789abcdef',
    prefix: 'bts_01234567',
    name: 'n',
    app: 'a',
    org: 'o',
    createdBy: 'c',
    createdAt: '2026-11-01T00:00:00.000Z',
    scopes: ['chat'],
    userNamespace: 'pk_0123456789abcdef',
  };

  it('carries lastUsedAt when present and omits the field when absent', () => {
    const at = '2026-11-13T12:00:00.000Z';
    expect(toPublicPartnerKey({ ...base, lastUsedAt: at })).toMatchObject({ lastUsedAt: at });
    expect('lastUsedAt' in toPublicPartnerKey(base)).toBe(false);
  });
});
