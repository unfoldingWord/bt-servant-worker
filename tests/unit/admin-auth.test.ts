/**
 * Unit tests for bearer-key classification and super-admin authority
 * (src/utils/admin-auth.ts). The route-level behaviour is covered end to end
 * in tests/e2e/admin-key.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  adminKeyConfigured,
  adminKeyEnforced,
  bearerToken,
  configuredAdminKey,
  classifyToken,
  hasSuperAdminAuthority,
  isSuperAdminClass,
} from '../../src/utils/admin-auth';

const ENGINE = 'engine-key';
const ADMIN = 'admin-key';
const unset = { ENGINE_API_KEY: ENGINE };
const transition = { ENGINE_API_KEY: ENGINE, ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'false' };
const enforced = { ENGINE_API_KEY: ENGINE, ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'true' };

describe('bearerToken', () => {
  it('extracts the token after "Bearer "', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('Bearer ')).toBe('');
  });

  it.each([undefined, 'abc', 'bearer abc', 'Basic abc'])('returns null for %s', (header) => {
    expect(bearerToken(header)).toBeNull();
  });
});

describe('adminKeyConfigured / adminKeyEnforced', () => {
  it('treats an unset or empty admin key as not configured', () => {
    expect(adminKeyConfigured(unset)).toBe(false);
    expect(adminKeyConfigured({ ENGINE_API_KEY: ENGINE, ADMIN_API_KEY: '' })).toBe(false);
    expect(adminKeyConfigured(transition)).toBe(true);
  });

  it('enforces only when the flag is exactly "true" and an admin key exists', () => {
    expect(adminKeyEnforced(transition)).toBe(false);
    expect(adminKeyEnforced(enforced)).toBe(true);
    expect(adminKeyEnforced({ ...enforced, ADMIN_KEY_REQUIRED: 'TRUE' })).toBe(false);
    expect(adminKeyEnforced({ ...enforced, ADMIN_KEY_REQUIRED: undefined })).toBe(false);
    // Flag on but no admin key: not enforced, so admin is never locked out.
    expect(adminKeyEnforced({ ENGINE_API_KEY: ENGINE, ADMIN_KEY_REQUIRED: 'true' })).toBe(false);
  });
});

describe('blank and padded admin keys', () => {
  it.each([undefined, '', ' ', '   ', '\n', ' \t\n '])(
    'treats %j as not configured (behaviour unchanged, flag has no effect)',
    (value) => {
      const keys = { ENGINE_API_KEY: ENGINE, ADMIN_API_KEY: value, ADMIN_KEY_REQUIRED: 'true' };
      expect(configuredAdminKey(keys)).toBeNull();
      expect(adminKeyConfigured(keys)).toBe(false);
      expect(adminKeyEnforced(keys)).toBe(false);
      expect(hasSuperAdminAuthority(`Bearer ${ENGINE}`, keys)).toBe(true);
      expect(classifyToken('', keys)).toBeNull();
      expect(classifyToken(' ', keys)).toBeNull();
    }
  );

  it('compares against the trimmed secret', () => {
    const keys = {
      ENGINE_API_KEY: ENGINE,
      ADMIN_API_KEY: `  ${ADMIN}\n`,
      ADMIN_KEY_REQUIRED: 'true',
    };
    expect(configuredAdminKey(keys)).toBe(ADMIN);
    expect(adminKeyEnforced(keys)).toBe(true);
    expect(classifyToken(ADMIN, keys)).toBe('admin');
    expect(hasSuperAdminAuthority(`Bearer ${ADMIN}`, keys)).toBe(true);
    // The untrimmed form is not the key.
    expect(classifyToken(`  ${ADMIN}\n`, keys)).toBeNull();
    expect(hasSuperAdminAuthority(`Bearer ${ENGINE}`, keys)).toBe(false);
  });
});

describe('classifyToken', () => {
  it('classifies the engine and admin keys', () => {
    expect(classifyToken(ENGINE, transition)).toBe('engine');
    expect(classifyToken(ADMIN, transition)).toBe('admin');
  });

  it('never matches an admin key that is not configured', () => {
    expect(classifyToken('', unset)).toBeNull();
    expect(classifyToken('', { ENGINE_API_KEY: ENGINE, ADMIN_API_KEY: '' })).toBeNull();
    expect(classifyToken(ADMIN, unset)).toBeNull();
  });

  it.each(['wrong', 'admin', 'admin-key-extra', 'engine', ''])('rejects %j', (token) => {
    expect(classifyToken(token, enforced)).toBeNull();
  });

  it('treats a value shared by both keys as the engine key (fails safe)', () => {
    const same = { ENGINE_API_KEY: ENGINE, ADMIN_API_KEY: ENGINE, ADMIN_KEY_REQUIRED: 'true' };
    expect(classifyToken(ENGINE, same)).toBe('engine');
    expect(isSuperAdminClass('engine', same)).toBe(false);
  });
});

describe('super-admin authority matrix', () => {
  it('admin key unset: engine key is super admin (unchanged behaviour)', () => {
    expect(hasSuperAdminAuthority(`Bearer ${ENGINE}`, unset)).toBe(true);
    expect(
      hasSuperAdminAuthority(`Bearer ${ENGINE}`, { ...unset, ADMIN_KEY_REQUIRED: 'true' })
    ).toBe(true);
  });

  it('admin key set, flag false: both keys are super admin', () => {
    expect(hasSuperAdminAuthority(`Bearer ${ADMIN}`, transition)).toBe(true);
    expect(hasSuperAdminAuthority(`Bearer ${ENGINE}`, transition)).toBe(true);
  });

  it('admin key set, flag true: only the admin key is super admin', () => {
    expect(hasSuperAdminAuthority(`Bearer ${ADMIN}`, enforced)).toBe(true);
    expect(hasSuperAdminAuthority(`Bearer ${ENGINE}`, enforced)).toBe(false);
  });

  it.each([undefined, 'Bearer ', 'Bearer wrong', ADMIN])('denies %j', (header) => {
    expect(hasSuperAdminAuthority(header, enforced)).toBe(false);
    expect(hasSuperAdminAuthority(header, transition)).toBe(false);
  });
});
