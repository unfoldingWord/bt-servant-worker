/**
 * Partner API keys (admin-portal#354).
 *
 * A partner key is a named, revocable bearer credential issued to one partner
 * app. It lets that app call the chat endpoints only (see
 * src/services/partner-keys/policy.ts), always for the key's own org. The
 * plaintext key is shown exactly once, in the create/rotate response; at rest
 * the store keeps only its SHA-256 (see src/services/partner-keys/store.ts).
 *
 * Pure types + input validation; no internal dependencies.
 */

import { stripControlChars } from './prompt-overrides.js';

/** The only scope a partner key can hold today. */
export const PARTNER_KEY_SCOPES = ['chat'] as const;
export type PartnerKeyScope = (typeof PARTNER_KEY_SCOPES)[number];

/**
 * The record stored in the API_KEYS namespace, keyed by the SHA-256 of the
 * plaintext key. It never contains the plaintext or the hash itself.
 */
export interface PartnerKeyRecord {
  /** Stable public id (`pk_<16 hex>`). Used by the admin endpoints and in logs. */
  id: string;
  /** Leading, non-secret part of the plaintext key (`bts_<8 hex>`) so a person can tell keys apart. */
  prefix: string;
  /** Human label, e.g. "BCS production". */
  name: string;
  /** The partner app this key is for, e.g. "BCS Translator App". */
  app: string;
  /** The org every request made with this key is locked to. */
  org: string;
  /** Who issued the key (portal user email or operator name). */
  createdBy: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 revocation time; absent while the key is active. */
  revokedAt?: string;
  /** Who revoked the key, when known. */
  revokedBy?: string;
  scopes: PartnerKeyScope[];
  /**
   * Isolation namespace for this partner's end users. Set once when the first
   * key is created and carried over on rotation, so rotating a key never
   * orphans its users' history. See scopePartnerSubject in policy.ts.
   */
  userNamespace: string;
  /** Id of the key this one replaced (rotation). */
  rotatedFrom?: string;
  /** Id of the key that replaced this one (rotation). */
  rotatedTo?: string;
  /** Version of the partner terms of use accepted when the key was issued. */
  termsVersion?: string;
  /** ISO-8601 time the terms were accepted. */
  termsAcceptedAt?: string;
  /**
   * Reserved for future per-key limits (rate, quota). Not settable through the
   * API yet and not enforced; present so the record shape does not need a
   * migration when limits land.
   */
  limits?: Record<string, number>;
}

/** What the admin endpoints return for a key: the record plus a derived status. */
export type PublicPartnerKey = PartnerKeyRecord & { status: 'active' | 'revoked' };

/** Validated body of `POST /api/v1/admin/api-keys`. */
export interface PartnerKeyCreateInput {
  org: string;
  name: string;
  app: string;
  createdBy: string;
  termsVersion?: string;
  termsAcceptedAt?: string;
}

/** Org ids a key may be bound to: a conservative id shape, never a `__` reserved key. */
const ORG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/**
 * Field limits are UTF-8 bytes of the JSON-encoded value, not characters: the
 * whole record is also stored as KV list metadata (store.ts), which Cloudflare
 * caps at 1024 bytes. These caps keep a worst-case record under that limit
 * (asserted in tests/unit/partner-keys.test.ts and checked again at write).
 */
const MAX_LABEL_BYTES = 100;
const MAX_ACTOR_BYTES = 120;
const MAX_TERMS_VERSION_BYTES = 32;

/** Size of a string once JSON-encoded, in UTF-8 bytes, without the surrounding quotes. */
function jsonByteLength(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).length - 2;
}

/** Pattern for a partner key id as issued by the store. */
export const PARTNER_KEY_ID_PATTERN = /^pk_[0-9a-f]{16}$/;

/** Validate an org id a key would be bound to. Returns an error string or null. */
export function validatePartnerKeyOrg(org: unknown): string | null {
  if (typeof org !== 'string' || !ORG_PATTERN.test(org)) {
    return 'org is required: 1-64 characters, letters, digits, ".", "_" or "-", starting with a letter or digit';
  }
  return null;
}

/** Validate a required, single-line label. Returns the cleaned value or an error. */
function readLabel(
  value: unknown,
  field: string,
  max: number
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} is required and must be a string` };
  }
  const cleaned = stripControlChars(value).trim();
  if (cleaned.length === 0) return { ok: false, error: `${field} must not be empty` };
  if (jsonByteLength(cleaned) > max) {
    return { ok: false, error: `${field} must be <= ${max} bytes (UTF-8, JSON-encoded)` };
  }
  return { ok: true, value: cleaned };
}

/** Validate the optional terms fields. Returns the cleaned pair or an error. */
function readTerms(
  body: Record<string, unknown>
): { ok: true; termsVersion?: string; termsAcceptedAt?: string } | { ok: false; error: string } {
  const { termsVersion, termsAcceptedAt } = body;
  const out: { termsVersion?: string; termsAcceptedAt?: string } = {};
  if (termsVersion !== undefined) {
    const version = readLabel(termsVersion, 'termsVersion', MAX_TERMS_VERSION_BYTES);
    if (!version.ok) return version;
    out.termsVersion = version.value;
  }
  if (termsAcceptedAt !== undefined) {
    if (typeof termsAcceptedAt !== 'string' || Number.isNaN(Date.parse(termsAcceptedAt))) {
      return { ok: false, error: 'termsAcceptedAt must be an ISO-8601 date-time string' };
    }
    out.termsAcceptedAt = new Date(termsAcceptedAt).toISOString();
  }
  return { ok: true, ...out };
}

/**
 * Validate a create body. Unknown fields are rejected so a caller cannot
 * believe it set something (scopes, limits) the API does not honour.
 */
export function validatePartnerKeyCreate(
  body: unknown
): { ok: true; input: PartnerKeyCreateInput } | { ok: false; error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(['org', 'name', 'app', 'createdBy', 'termsVersion', 'termsAcceptedAt']);
  const unknown = Object.keys(record).filter((k) => !allowed.has(k));
  if (unknown.length > 0) return { ok: false, error: `Unknown field(s): ${unknown.join(', ')}` };

  const orgError = validatePartnerKeyOrg(record.org);
  if (orgError) return { ok: false, error: orgError };
  const name = readLabel(record.name, 'name', MAX_LABEL_BYTES);
  if (!name.ok) return name;
  const app = readLabel(record.app, 'app', MAX_LABEL_BYTES);
  if (!app.ok) return app;
  const createdBy = readLabel(record.createdBy, 'createdBy', MAX_ACTOR_BYTES);
  if (!createdBy.ok) return createdBy;
  const terms = readTerms(record);
  if (!terms.ok) return terms;

  const { ok: _ok, ...termsFields } = terms;
  return {
    ok: true,
    input: {
      org: record.org as string,
      name: name.value,
      app: app.value,
      createdBy: createdBy.value,
      ...termsFields,
    },
  };
}

/**
 * Validate the optional actor field on revoke/rotate bodies (`revokedBy` /
 * `createdBy`). An absent or empty body is fine. Returns the actor or an error.
 */
export function readOptionalActor(
  body: unknown,
  field: 'revokedBy' | 'createdBy'
): { ok: true; actor?: string } | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true };
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => k !== field);
  if (unknown.length > 0) return { ok: false, error: `Unknown field(s): ${unknown.join(', ')}` };
  const value = field === 'revokedBy' ? record.revokedBy : record.createdBy;
  if (value === undefined) return { ok: true };
  const actor = readLabel(value, field, MAX_ACTOR_BYTES);
  return actor.ok ? { ok: true, actor: actor.value } : actor;
}

/** Explicit allow-list projection: never spreads unknown stored fields into a response. */
export function toPublicPartnerKey(record: PartnerKeyRecord): PublicPartnerKey {
  const optional = {
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    ...(record.revokedBy !== undefined ? { revokedBy: record.revokedBy } : {}),
    ...(record.rotatedFrom !== undefined ? { rotatedFrom: record.rotatedFrom } : {}),
    ...(record.rotatedTo !== undefined ? { rotatedTo: record.rotatedTo } : {}),
    ...(record.termsVersion !== undefined ? { termsVersion: record.termsVersion } : {}),
    ...(record.termsAcceptedAt !== undefined ? { termsAcceptedAt: record.termsAcceptedAt } : {}),
    ...(record.limits !== undefined ? { limits: record.limits } : {}),
  };
  return {
    id: record.id,
    prefix: record.prefix,
    name: record.name,
    app: record.app,
    org: record.org,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    scopes: [...record.scopes],
    userNamespace: record.userNamespace,
    ...optional,
    status: record.revokedAt === undefined ? 'active' : 'revoked',
  };
}
