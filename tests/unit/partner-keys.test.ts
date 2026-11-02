/**
 * Unit tests for partner API keys (admin-portal#354): the pure policy rules
 * (route allowlist, org forcing, refusals, user namespacing), the create-body
 * validation, the public projection, and key-material shape.
 *
 * The HTTP-level behaviour (middleware, admin CRUD, hash at rest) is covered
 * end to end in tests/e2e/partner-api-keys.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPartnerChatPolicy,
  isPartnerRouteAllowed,
  principalKeyId,
  scopePartnerSubject,
} from '../../src/services/partner-keys/policy.js';
import {
  generatePartnerKeyMaterial,
  looksLikePartnerKey,
  sha256Hex,
} from '../../src/services/partner-keys/store.js';
import {
  readOptionalActor,
  toPublicPartnerKey,
  validatePartnerKeyCreate,
  type PartnerKeyRecord,
} from '../../src/types/partner-keys.js';

const KEY: PartnerKeyRecord = {
  id: 'pk_0123456789abcdef',
  prefix: 'bts_01234567',
  name: 'BCS production',
  app: 'BCS app',
  org: 'bcs',
  createdBy: 'admin@example.org',
  createdAt: '2026-11-02T00:00:00.000Z',
  scopes: ['chat'],
  userNamespace: 'pk_0123456789abcdef',
};

const chat = (extra: Record<string, unknown> = {}) => ({
  client_id: 'bcs-app',
  user_id: 'alice',
  message: 'hi',
  message_type: 'text',
  ...extra,
});

describe('isPartnerRouteAllowed', () => {
  it('allows only POST /api/v1/chat and /api/v1/chat/stream', () => {
    expect(isPartnerRouteAllowed('POST', '/api/v1/chat')).toBe(true);
    expect(isPartnerRouteAllowed('POST', '/api/v1/chat/stream')).toBe(true);
  });

  it.each([
    ['POST', '/api/v1/chat/callback'],
    ['GET', '/api/v1/chat'],
    ['POST', '/api/v1/chat/'],
    ['GET', '/api/v1/orgs/bcs/users/alice/preferences'],
    ['PUT', '/api/v1/orgs/bcs/users/alice/preferences'],
    ['GET', '/api/v1/orgs/bcs/users/alice/history'],
    ['GET', '/api/v1/audio/audio/x.ogg'],
    ['GET', '/api/v1/voice-submissions/x'],
    ['GET', '/api/v1/admin/api-keys'],
    ['GET', '/api/v1/admin/orgs/bcs/modes'],
  ])('denies %s %s', (method, path) => {
    expect(isPartnerRouteAllowed(method, path)).toBe(false);
  });
});

describe('principalKeyId', () => {
  it('is "internal" for ENGINE_API_KEY and the key id for a partner', () => {
    expect(principalKeyId({ kind: 'internal' })).toBe('internal');
    expect(principalKeyId({ kind: 'partner', key: KEY })).toBe(KEY.id);
  });
});

describe('applyPartnerChatPolicy', () => {
  it('forces org to the key org and namespaces user_id', () => {
    const result = applyPartnerChatPolicy(chat(), KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.org).toBe('bcs');
    expect(result.body.user_id).toBe(`partner:${KEY.userNamespace}:alice`);
    expect(result.body.user_id).toBe(scopePartnerSubject(KEY, 'alice'));
  });

  it('accepts an explicit org equal to the key org and drops org_id', () => {
    const result = applyPartnerChatPolicy(chat({ org: 'bcs', org_id: 'bcs' }), KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.org).toBe('bcs');
    expect(result.body.org_id).toBeUndefined();
  });

  it.each([{ org: 'unfoldingWord' }, { org_id: 'unfoldingWord' }, { org: 'bcs', org_id: 'other' }])(
    'rejects a mismatched org with 400 (%o)',
    (orgFields) => {
      const result = applyPartnerChatPolicy(chat(orgFields), KEY);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.rejection.status).toBe(400);
      expect(result.rejection.reason).toBe('partner_org_mismatch');
    }
  );
});

describe('applyPartnerChatPolicy refusals', () => {
  it('refuses client_id admin-portal with 403', () => {
    const result = applyPartnerChatPolicy(chat({ client_id: 'admin-portal' }), KEY);
    expect(result).toMatchObject({
      ok: false,
      rejection: { status: 403, reason: 'partner_admin_client' },
    });
  });

  it('refuses progress_callback_url with 400, even when empty', () => {
    for (const url of ['https://evil.example/cb', '']) {
      const result = applyPartnerChatPolicy(chat({ progress_callback_url: url }), KEY);
      expect(result).toMatchObject({
        ok: false,
        rejection: { status: 400, reason: 'partner_callback_url' },
      });
    }
  });

  it.each([123, '', undefined, null])('rejects a non-string or empty user_id (%o)', (userId) => {
    const result = applyPartnerChatPolicy(chat({ user_id: userId }), KEY);
    expect(result).toMatchObject({ ok: false, rejection: { reason: 'partner_user_id' } });
  });
});

describe('applyPartnerChatPolicy namespacing', () => {
  it('namespaces chat_id for group chats', () => {
    const result = applyPartnerChatPolicy(chat({ chat_type: 'group', chat_id: 'g1' }), KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.chat_id).toBe(`partner:${KEY.userNamespace}:g1`);
  });

  it('rejects a non-object body', () => {
    for (const body of [null, [], 'x']) {
      expect(applyPartnerChatPolicy(body, KEY)).toMatchObject({
        ok: false,
        rejection: { reason: 'partner_body_shape' },
      });
    }
  });

  it('does not mutate the input body', () => {
    const input = chat({ org_id: 'bcs' });
    applyPartnerChatPolicy(input, KEY);
    expect(input).toEqual(chat({ org_id: 'bcs' }));
  });
});

describe('key material', () => {
  it('has the documented shape and >=128 bits of secret', () => {
    const { id, prefix, plaintext } = generatePartnerKeyMaterial();
    expect(id).toMatch(/^pk_[0-9a-f]{16}$/);
    expect(prefix).toMatch(/^bts_[0-9a-f]{8}$/);
    expect(plaintext.startsWith(`${prefix}_`)).toBe(true);
    // 43 base64url chars = 256 bits of CSPRNG output after the prefix.
    expect(plaintext.slice(prefix.length + 1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(looksLikePartnerKey(plaintext)).toBe(true);
  });

  it('is unique per call', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePartnerKeyMaterial().plaintext));
    expect(seen.size).toBe(50);
  });

  it('rejects other token shapes before any lookup', () => {
    expect(looksLikePartnerKey('test-api-key')).toBe(false);
    expect(looksLikePartnerKey('bts_0123_short')).toBe(false);
  });

  it('hashes with SHA-256 hex', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('validatePartnerKeyCreate', () => {
  const valid = { org: 'bcs', name: ' BCS prod ', app: 'BCS app', createdBy: 'a@b.org' };

  it('accepts a valid body and trims labels', () => {
    const result = validatePartnerKeyCreate(valid);
    expect(result).toEqual({
      ok: true,
      input: { org: 'bcs', name: 'BCS prod', app: 'BCS app', createdBy: 'a@b.org' },
    });
  });

  it('normalises termsAcceptedAt and keeps termsVersion', () => {
    const result = validatePartnerKeyCreate({
      ...valid,
      termsVersion: '2026-11',
      termsAcceptedAt: '2026-11-02T10:00:00Z',
    });
    expect(result).toMatchObject({
      ok: true,
      input: { termsVersion: '2026-11', termsAcceptedAt: '2026-11-02T10:00:00.000Z' },
    });
  });

  it.each([
    [{ ...valid, org: '__global__' }, 'org'],
    [{ ...valid, org: 'a:b' }, 'org'],
    [{ ...valid, name: '' }, 'name'],
    [{ ...valid, app: 5 }, 'app'],
    [{ ...valid, createdBy: undefined }, 'createdBy'],
    [{ ...valid, termsAcceptedAt: 'not a date' }, 'termsAcceptedAt'],
    [{ ...valid, scopes: ['admin'] }, 'Unknown field'],
    [{ ...valid, limits: { rpm: 1 } }, 'Unknown field'],
  ])('rejects %o', (body, fragment) => {
    const result = validatePartnerKeyCreate(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(fragment);
  });
});

describe('readOptionalActor', () => {
  it('accepts an empty body or the named actor, rejects others', () => {
    expect(readOptionalActor(undefined, 'revokedBy')).toEqual({ ok: true });
    expect(readOptionalActor({ revokedBy: 'x@y.org' }, 'revokedBy')).toEqual({
      ok: true,
      actor: 'x@y.org',
    });
    expect(readOptionalActor({ other: 1 }, 'revokedBy').ok).toBe(false);
  });
});

describe('toPublicPartnerKey', () => {
  it('projects known fields only and derives status', () => {
    const stored = { ...KEY, hash: 'deadbeef', plaintext: 'bts_x' } as unknown as PartnerKeyRecord;
    const pub = toPublicPartnerKey(stored);
    expect(pub).not.toHaveProperty('hash');
    expect(pub).not.toHaveProperty('plaintext');
    expect(pub.status).toBe('active');
    expect(toPublicPartnerKey({ ...KEY, revokedAt: '2026-11-03T00:00:00.000Z' }).status).toBe(
      'revoked'
    );
  });
});
