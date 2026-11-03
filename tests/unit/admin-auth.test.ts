/**
 * Unit tests for bearer-key classification and super-admin authority
 * (src/utils/admin-auth.ts). The route-level behaviour is covered end to end
 * in tests/e2e/admin-key.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  adminKeyConfigured,
  adminKeyEnforced,
  adminKeyEqualsEngineKey,
  adminKeyRequiredSetting,
  bearerToken,
  classifyToken,
  configuredAdminKey,
  isSuperAdminClass,
  type AuthKeys,
} from '../../src/utils/admin-auth';

/** Parse + classify the header, then decide super-admin authority (what `/api/*` does). */
function hasSuperAdminAuthority(header: string | undefined, keys: AuthKeys): boolean {
  const token = bearerToken(header);
  return token !== null && isSuperAdminClass(classifyToken(token, keys), keys);
}

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

  it('enforces only when the flag is "true" and an admin key exists', () => {
    expect(adminKeyEnforced(transition)).toBe(false);
    expect(adminKeyEnforced(enforced)).toBe(true);
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

describe('ADMIN_KEY_REQUIRED parsing', () => {
  const withFlag = (flag: string | undefined) => ({
    ENGINE_API_KEY: ENGINE,
    ADMIN_API_KEY: ADMIN,
    ADMIN_KEY_REQUIRED: flag,
  });

  it.each(['true', 'TRUE', 'True', ' true ', 'true\n'])('%j enforces', (flag) => {
    expect(adminKeyRequiredSetting(withFlag(flag))).toBe('true');
    expect(adminKeyEnforced(withFlag(flag))).toBe(true);
  });

  it.each([undefined, '', '  ', 'false', 'FALSE', ' False '])('%j is false', (flag) => {
    expect(adminKeyRequiredSetting(withFlag(flag))).toBe('false');
    expect(adminKeyEnforced(withFlag(flag))).toBe(false);
  });

  it.each(['yes', '1', 'on', 'tru', 'enabled', 'no', '0'])(
    '%j is invalid and enforces (fails closed)',
    (flag) => {
      expect(adminKeyRequiredSetting(withFlag(flag))).toBe('invalid');
      expect(adminKeyEnforced(withFlag(flag))).toBe(true);
      expect(hasSuperAdminAuthority(`Bearer ${ENGINE}`, withFlag(flag))).toBe(false);
      expect(hasSuperAdminAuthority(`Bearer ${ADMIN}`, withFlag(flag))).toBe(true);
    }
  );

  it('an invalid value without an admin key is not enforced (no lockout)', () => {
    const keys = { ENGINE_API_KEY: ENGINE, ADMIN_KEY_REQUIRED: 'yes' };
    expect(adminKeyEnforced(keys)).toBe(false);
    expect(hasSuperAdminAuthority(`Bearer ${ENGINE}`, keys)).toBe(true);
  });
});

describe('adminKeyEqualsEngineKey', () => {
  it('is true only when both are set and equal after trimming', () => {
    expect(adminKeyEqualsEngineKey({ ENGINE_API_KEY: ENGINE, ADMIN_API_KEY: ENGINE })).toBe(true);
    expect(
      adminKeyEqualsEngineKey({ ENGINE_API_KEY: ` ${ENGINE}`, ADMIN_API_KEY: `${ENGINE}\n` })
    ).toBe(true);
    expect(adminKeyEqualsEngineKey(transition)).toBe(false);
    expect(adminKeyEqualsEngineKey(unset)).toBe(false);
    expect(adminKeyEqualsEngineKey({ ENGINE_API_KEY: '', ADMIN_API_KEY: '' })).toBe(false);
    expect(adminKeyEqualsEngineKey({ ENGINE_API_KEY: '  ', ADMIN_API_KEY: '  ' })).toBe(false);
  });
});

describe('padded ENGINE_API_KEY', () => {
  it('accepts both the stored and the trimmed engine value', () => {
    const keys = { ENGINE_API_KEY: ` ${ENGINE}\n` };
    expect(classifyToken(ENGINE, keys)).toBe('engine');
    expect(classifyToken(` ${ENGINE}\n`, keys)).toBe('engine');
  });

  it('a padded engine secret equal to the admin secret still classifies as engine', () => {
    const keys = {
      ENGINE_API_KEY: `  shared-key\n`,
      ADMIN_API_KEY: 'shared-key',
      ADMIN_KEY_REQUIRED: 'true',
    };
    expect(classifyToken('shared-key', keys)).toBe('engine');
    expect(hasSuperAdminAuthority('Bearer shared-key', keys)).toBe(false);
  });

  it('an engine secret equal to a padded admin secret still classifies as engine', () => {
    const keys = {
      ENGINE_API_KEY: 'shared-key',
      ADMIN_API_KEY: '\tshared-key  ',
      ADMIN_KEY_REQUIRED: 'true',
    };
    expect(classifyToken('shared-key', keys)).toBe('engine');
  });

  it('a blank engine secret never matches a blank token', () => {
    expect(classifyToken('', { ENGINE_API_KEY: '   ' })).toBeNull();
  });
});

describe('guarded classifier: blank tokens and unset secrets', () => {
  const noEngine = { ENGINE_API_KEY: undefined as unknown as string };

  it.each(['', ' ', '   ', '\t', '\n'])('a blank token %j never classifies', (token) => {
    expect(classifyToken(token, unset)).toBeNull();
    expect(classifyToken(token, enforced)).toBeNull();
    expect(classifyToken(token, noEngine)).toBeNull();
    expect(classifyToken(token, { ENGINE_API_KEY: '' })).toBeNull();
    expect(classifyToken(token, { ENGINE_API_KEY: token })).toBeNull();
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('an %s ENGINE_API_KEY matches nothing', (_label, value) => {
    const keys = { ENGINE_API_KEY: value as unknown as string };
    for (const token of ['x', 'undefined', 'null', ' ', '']) {
      expect(classifyToken(token, keys)).toBeNull();
    }
  });

  it('an empty bearer header is never super admin, even with no secrets set', () => {
    expect(hasSuperAdminAuthority('Bearer ', noEngine)).toBe(false);
    expect(hasSuperAdminAuthority('Bearer ', { ENGINE_API_KEY: '' })).toBe(false);
    expect(hasSuperAdminAuthority(undefined, noEngine)).toBe(false);
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
