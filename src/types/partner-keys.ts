/**
 * Partner API keys (admin-portal#354).
 *
 * A partner key is a named, revocable bearer credential issued to one partner
 * app. It lets that app call the chat endpoints only (see
 * src/services/partner-keys/policy.ts), always for the key's own org. The
 * plaintext key is shown exactly once, in the create/rotate response; at rest
 * the store keeps only its SHA-256 (see src/durable-objects/partner-key-store-do.ts).
 *
 * Pure types + input validation; no internal dependencies.
 */

import { hasLineBreakOrControl } from './single-line.js';

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
  /**
   * ISO-8601 end of a rotation grace window. Set on the OLD key when it is
   * rotated with a non-zero grace, so a partner's live app keeps working while
   * it ships the new key; from this instant auth treats the key as expired.
   */
  expiresAt?: string;
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

/** Lifecycle state of a key at a given instant. */
export type PartnerKeyStatus = 'active' | 'revoked' | 'expired';

/** What the admin endpoints return for a key: the record plus a derived status. */
export type PublicPartnerKey = PartnerKeyRecord & { status: PartnerKeyStatus };

/**
 * The one definition of whether a key works at `now` (ms). Explicit revocation
 * wins; otherwise a key past its rotation grace (`expiresAt`) is expired.
 * Used by the auth middleware and by every admin response.
 */
export function partnerKeyStatus(record: PartnerKeyRecord, now: number): PartnerKeyStatus {
  if (record.revokedAt !== undefined) return 'revoked';
  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now) return 'expired';
  return 'active';
}

/** Default rotation grace: 7 days for the partner to deploy the new key. */
export const DEFAULT_ROTATION_GRACE_SECONDS = 7 * 24 * 60 * 60;
/** Upper bound on rotation grace: 30 days. */
export const MAX_ROTATION_GRACE_SECONDS = 30 * 24 * 60 * 60;

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
 * Field limits are UTF-8 bytes of the JSON-encoded value, not characters, so
 * a record stays small however the labels are written (it is copied to the
 * API_KEYS KV projection read on every partner request).
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

/**
 * Validate a required, single-line label (name, app, createdBy, revokedBy,
 * termsVersion). Controls and line breaks of every kind (C0, C1, U+2028/9 —
 * see single-line.ts) are rejected, not silently stripped, so what is stored
 * is exactly what the admin typed. Surrounding spaces are trimmed.
 */
function readLabel(
  value: unknown,
  field: string,
  max: number
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} is required and must be a string` };
  }
  if (hasLineBreakOrControl(value)) {
    return {
      ok: false,
      error: `${field} must be a single line (no control, invisible format or line-break characters)`,
    };
  }
  const cleaned = value.trim();
  if (cleaned.length === 0) return { ok: false, error: `${field} must not be empty` };
  if (jsonByteLength(cleaned) > max) {
    return { ok: false, error: `${field} must be <= ${max} bytes (UTF-8, JSON-encoded)` };
  }
  return { ok: true, value: cleaned };
}

/**
 * Strict ISO-8601 date-time: `YYYY-MM-DDTHH:MM[:SS[.fraction]]` with `Z` or a
 * `±HH:MM` offset. Date.parse alone accepts "2026" or "Nov 2 2026", which are
 * not what a terms-acceptance timestamp should be.
 */
const DATE_HOUR_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SECONDS = /^:\d{2}/;
const FRACTION = /^\.\d{1,9}/;
const ZONE = /^(?:Z|[+-]\d{2}:\d{2})$/;

/** Consume an optional `:SS[.fraction]` from the start of `rest`. */
function skipSeconds(rest: string): string {
  const seconds = SECONDS.exec(rest);
  if (!seconds) return rest;
  const afterSeconds = rest.slice(seconds[0].length);
  const fraction = FRACTION.exec(afterSeconds);
  return fraction ? afterSeconds.slice(fraction[0].length) : afterSeconds;
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const head = DATE_HOUR_MINUTE.exec(value);
  if (!head) return false;
  const zone = skipSeconds(value.slice(head[0].length));
  return ZONE.test(zone) && !Number.isNaN(Date.parse(value));
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
    if (!isIsoDateTime(termsAcceptedAt)) {
      return {
        ok: false,
        error:
          'termsAcceptedAt must be an ISO-8601 date-time with a time zone, e.g. 2026-11-02T15:00:00Z',
      };
    }
    out.termsAcceptedAt = new Date(termsAcceptedAt).toISOString();
  }
  return { ok: true, ...out };
}

/**
 * Validate a create body. Unknown fields are rejected so a caller cannot
 * believe it set something (scopes, limits) the API does not honour.
 */
const CREATE_FIELDS: ReadonlySet<string> = new Set([
  'org',
  'name',
  'app',
  'createdBy',
  'termsVersion',
  'termsAcceptedAt',
  'allow_new_org',
]);

/** The three required labels of a create body. */
function readCreateLabels(
  record: Record<string, unknown>
): { ok: true; name: string; app: string; createdBy: string } | { ok: false; error: string } {
  const name = readLabel(record.name, 'name', MAX_LABEL_BYTES);
  if (!name.ok) return name;
  const app = readLabel(record.app, 'app', MAX_LABEL_BYTES);
  if (!app.ok) return app;
  const createdBy = readLabel(record.createdBy, 'createdBy', MAX_ACTOR_BYTES);
  if (!createdBy.ok) return createdBy;
  return { ok: true, name: name.value, app: app.value, createdBy: createdBy.value };
}

export function validatePartnerKeyCreate(
  body: unknown
): { ok: true; input: PartnerKeyCreateInput; allowNewOrg: boolean } | { ok: false; error: string } {
  // One rule for every body reader here (readBodyObject): an absent or null
  // body is an empty object, so a create without a body fails on `org`.
  const parsed = readBodyObject(body, CREATE_FIELDS);
  if (!parsed.ok) return parsed;
  const { record } = parsed;

  const orgError = validatePartnerKeyOrg(record.org);
  if (orgError) return { ok: false, error: orgError };
  const labels = readCreateLabels(record);
  if (!labels.ok) return labels;
  const terms = readTerms(record);
  if (!terms.ok) return terms;
  if (record.allow_new_org !== undefined && typeof record.allow_new_org !== 'boolean') {
    return { ok: false, error: 'allow_new_org must be a boolean' };
  }

  const { ok: _ok, ...termsFields } = terms;
  const { ok: _labelsOk, ...labelFields } = labels;
  return {
    ok: true,
    allowNewOrg: record.allow_new_org === true,
    input: { org: record.org as string, ...labelFields, ...termsFields },
  };
}

/** Reject a non-object body and any key outside `allowed`. Absent/null body → `{}`. */
export function readBodyObject(
  body: unknown,
  allowed: ReadonlySet<string>
): { ok: true; record: Record<string, unknown> } | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true, record: {} };
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !allowed.has(k));
  if (unknown.length > 0) return { ok: false, error: `Unknown field(s): ${unknown.join(', ')}` };
  return { ok: true, record };
}

/** Optional actor label (undefined → absent). */
function readActor(
  value: unknown,
  field: string
): { ok: true; actor?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  const actor = readLabel(value, field, MAX_ACTOR_BYTES);
  return actor.ok ? { ok: true, actor: actor.value } : actor;
}

/** Validate the optional revoke body: `{ revokedBy? }`. */
export function readRevokeBody(
  body: unknown
): { ok: true; revokedBy?: string } | { ok: false; error: string } {
  const parsed = readBodyObject(body, new Set(['revokedBy']));
  if (!parsed.ok) return parsed;
  const actor = readActor(parsed.record.revokedBy, 'revokedBy');
  if (!actor.ok) return actor;
  return actor.actor === undefined ? { ok: true } : { ok: true, revokedBy: actor.actor };
}

/**
 * Validate the optional rotate body: `{ createdBy?, graceSeconds? }`.
 * `graceSeconds` is an integer in [0, MAX_ROTATION_GRACE_SECONDS]; default
 * DEFAULT_ROTATION_GRACE_SECONDS. 0 means "rotate and kill the old key now".
 */
export function readRotateBody(
  body: unknown
): { ok: true; createdBy?: string; graceSeconds: number } | { ok: false; error: string } {
  const parsed = readBodyObject(body, new Set(['createdBy', 'graceSeconds']));
  if (!parsed.ok) return parsed;
  const actor = readActor(parsed.record.createdBy, 'createdBy');
  if (!actor.ok) return actor;
  // Absent → default. `null` is NOT absent here: it is a 400 like any other
  // non-integer, so a caller never gets a 7-day grace it did not ask for.
  const grace =
    parsed.record.graceSeconds === undefined
      ? DEFAULT_ROTATION_GRACE_SECONDS
      : parsed.record.graceSeconds;
  if (
    typeof grace !== 'number' ||
    !Number.isInteger(grace) ||
    grace < 0 ||
    grace > MAX_ROTATION_GRACE_SECONDS
  ) {
    return {
      ok: false,
      error: `graceSeconds must be an integer from 0 to ${MAX_ROTATION_GRACE_SECONDS}`,
    };
  }
  return {
    ok: true,
    graceSeconds: grace,
    ...(actor.actor !== undefined ? { createdBy: actor.actor } : {}),
  };
}

/** Optional lifecycle fields, copied only when present. */
function lifecycleFields(record: PartnerKeyRecord): Partial<PartnerKeyRecord> {
  return {
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    ...(record.revokedBy !== undefined ? { revokedBy: record.revokedBy } : {}),
    ...(record.rotatedFrom !== undefined ? { rotatedFrom: record.rotatedFrom } : {}),
    ...(record.rotatedTo !== undefined ? { rotatedTo: record.rotatedTo } : {}),
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
  };
}

/** Optional descriptive fields, copied only when present. */
function termsAndLimitFields(record: PartnerKeyRecord): Partial<PartnerKeyRecord> {
  return {
    ...(record.termsVersion !== undefined ? { termsVersion: record.termsVersion } : {}),
    ...(record.termsAcceptedAt !== undefined ? { termsAcceptedAt: record.termsAcceptedAt } : {}),
    ...(record.limits !== undefined ? { limits: record.limits } : {}),
  };
}

/**
 * Explicit allow-list projection: never spreads unknown stored fields into a
 * response. `status` is derived at `now` (ms; default the current time).
 */
export function toPublicPartnerKey(
  record: PartnerKeyRecord,
  now: number = Date.now()
): PublicPartnerKey {
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
    ...lifecycleFields(record),
    ...termsAndLimitFields(record),
    status: partnerKeyStatus(record, now),
  };
}
