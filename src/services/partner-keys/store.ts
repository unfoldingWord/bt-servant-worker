/**
 * Partner API key store (admin-portal#354), backed by the API_KEYS KV namespace.
 *
 * Layout:
 *   key:<sha256 hex of the plaintext key>  → JSON PartnerKeyRecord (authoritative)
 *   id:<key id>                            → <sha256 hex>, metadata = the record
 *
 * The `key:` entry is the source of truth (auth reads it; so do get/revoke/
 * rotate, through the `id:` pointer). The `id:` entry's metadata is a copy of
 * the record so the admin list is served by `kv.list()` alone, with no per-key
 * reads. Record fields are size-capped (types/partner-keys.ts) so the copy
 * always fits KV's 1024-byte metadata limit.
 *
 * The plaintext key never touches storage: only its SHA-256 is used, as the KV
 * key. A plain (unsalted, fast) hash is the right tool here because the key is
 * 256 bits of CSPRNG output — there is nothing to brute-force, unlike a
 * password — and it keeps the auth hot path to one KV read.
 *
 * Consistency: KV is eventually consistent and the auth lookup caches for
 * AUTH_LOOKUP_CACHE_TTL_SECONDS, so a revocation can take about a minute to
 * be seen everywhere (portal#354 question 5). Rotation-grace expiry is exact,
 * not delayed: the record is unchanged at `expiresAt`, and auth compares it
 * with the clock on every request. KV also has no compare-and-swap;
 * see rotatePartnerKey for what that means for concurrent admin writes.
 */

import {
  type PartnerKeyCreateInput,
  type PartnerKeyRecord,
  PARTNER_KEY_ID_PATTERN,
} from '../../types/partner-keys.js';
import { bytesToHex, sha256Hex } from '../../utils/crypto.js';
import type { RequestLogger } from '../../utils/logger.js';

/** Cloudflare's minimum `cacheTtl` for KV reads; also the revocation-delay bound we document. */
export const AUTH_LOOKUP_CACHE_TTL_SECONDS = 60;
/** Cloudflare's limit on the serialized metadata of one KV key. */
export const KV_METADATA_MAX_BYTES = 1024;

const KEY_PREFIX = 'key:';
const ID_PREFIX = 'id:';
const PLAINTEXT_PREFIX = 'bts_';
/** Plaintext shape: `bts_<8 hex prefix>_<43 base64url chars = 256 random bits>`. */
const PLAINTEXT_PATTERN = /^bts_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;
/**
 * Upper bound on index pages (1000 keys each) walked by a list. Revoked keys
 * are kept for audit and never deleted, so the index only grows; past this
 * bound the list is truncated and says so in the log.
 */
const MAX_LIST_PAGES = 20;

function randomHex(byteCount: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

function randomBase64Url(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Cheap shape check so garbage bearer tokens never cost a KV read. */
export function looksLikePartnerKey(token: string): boolean {
  return PLAINTEXT_PATTERN.test(token);
}

/** Fresh key material: public id, display prefix, and the one-time plaintext. */
export function generatePartnerKeyMaterial(): { id: string; prefix: string; plaintext: string } {
  const prefixHex = randomHex(4);
  return {
    id: `pk_${randomHex(8)}`,
    prefix: `${PLAINTEXT_PREFIX}${prefixHex}`,
    plaintext: `${PLAINTEXT_PREFIX}${prefixHex}_${randomBase64Url(32)}`,
  };
}

/** Serialized size of a record as index metadata. Throws if it would not fit. */
export function assertFitsMetadata(record: PartnerKeyRecord): void {
  const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
  if (bytes > KV_METADATA_MAX_BYTES) {
    throw new Error(
      `Partner key ${record.id} record is ${bytes} bytes; KV metadata allows ${KV_METADATA_MAX_BYTES}`
    );
  }
}

/**
 * Auth hot path: resolve a presented bearer token to its record, or null when
 * no key has that hash. Revocation is NOT checked here — the caller decides
 * (and logs) so unknown and revoked keys stay distinguishable in telemetry.
 */
export async function lookupPartnerKeyByToken(
  kv: KVNamespace,
  token: string
): Promise<PartnerKeyRecord | null> {
  const hash = await sha256Hex(token);
  return kv.get<PartnerKeyRecord>(`${KEY_PREFIX}${hash}`, {
    type: 'json',
    cacheTtl: AUTH_LOOKUP_CACHE_TTL_SECONDS,
  });
}

/** Admin read by id (uncached). Returns the record and its storage hash, or null. */
export async function getPartnerKeyById(
  kv: KVNamespace,
  id: string
): Promise<{ record: PartnerKeyRecord; hash: string } | null> {
  if (!PARTNER_KEY_ID_PATTERN.test(id)) return null;
  const hash = await kv.get(`${ID_PREFIX}${id}`);
  if (!hash) return null;
  const record = await kv.get<PartnerKeyRecord>(`${KEY_PREFIX}${hash}`, 'json');
  return record ? { record, hash } : null;
}

async function putIndex(kv: KVNamespace, hash: string, record: PartnerKeyRecord): Promise<void> {
  await kv.put(`${ID_PREFIX}${record.id}`, hash, { metadata: record });
}

/**
 * Update an EXISTING key: the authoritative `key:` record first, then the
 * index copy. An index failure after the record write is logged, not thrown:
 * the change already took effect for auth and get-by-id, and throwing would
 * report a revocation as failed when it happened. Only the list can be stale.
 */
async function updateRecord(
  kv: KVNamespace,
  hash: string,
  record: PartnerKeyRecord,
  logger: RequestLogger
): Promise<void> {
  assertFitsMetadata(record);
  await kv.put(`${KEY_PREFIX}${hash}`, JSON.stringify(record));
  try {
    await putIndex(kv, hash, record);
  } catch (error) {
    logger.error('partner_key_index_write_failed', error, { key_id: record.id });
  }
}

/**
 * Issue a new key. `carry` is used by rotation to keep the user namespace and
 * link the two records. Returns the stored record and the one-time plaintext.
 */
export async function createPartnerKey(
  kv: KVNamespace,
  input: PartnerKeyCreateInput,
  carry: { userNamespace?: string; rotatedFrom?: string } = {}
): Promise<{ record: PartnerKeyRecord; plaintext: string; hash: string }> {
  const { id, prefix, plaintext } = generatePartnerKeyMaterial();
  const hash = await sha256Hex(plaintext);
  const record: PartnerKeyRecord = {
    id,
    prefix,
    name: input.name,
    app: input.app,
    org: input.org,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    scopes: ['chat'],
    userNamespace: carry.userNamespace ?? id,
    ...(carry.rotatedFrom !== undefined ? { rotatedFrom: carry.rotatedFrom } : {}),
    ...(input.termsVersion !== undefined ? { termsVersion: input.termsVersion } : {}),
    ...(input.termsAcceptedAt !== undefined ? { termsAcceptedAt: input.termsAcceptedAt } : {}),
  };
  assertFitsMetadata(record);
  // Record first, index second, both fatal on failure: the `id:` entry is the
  // only pointer to the hash, so a key without it could never be revoked by
  // id. A crash between the two leaves an unlisted record whose plaintext was
  // never returned, so nobody can use it.
  await kv.put(`${KEY_PREFIX}${hash}`, JSON.stringify(record));
  await putIndex(kv, hash, record);
  return { record, plaintext, hash };
}

/**
 * Revoke by id. Idempotent: revoking a revoked key returns it unchanged with
 * `alreadyRevoked: true`. Returns null when no such key exists.
 */
export async function revokePartnerKey(
  kv: KVNamespace,
  id: string,
  opts: { revokedBy?: string | undefined; logger: RequestLogger }
): Promise<{ record: PartnerKeyRecord; alreadyRevoked: boolean } | null> {
  const found = await getPartnerKeyById(kv, id);
  if (!found) return null;
  if (found.record.revokedAt !== undefined) return { record: found.record, alreadyRevoked: true };
  const record: PartnerKeyRecord = {
    ...found.record,
    revokedAt: new Date().toISOString(),
    ...(opts.revokedBy !== undefined ? { revokedBy: opts.revokedBy } : {}),
  };
  await updateRecord(kv, found.hash, record, opts.logger);
  return { record, alreadyRevoked: false };
}

export type RotateResult =
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'already_rotated'; rotatedTo: string }
  | { status: 'conflict' }
  | { status: 'ok'; previous: PartnerKeyRecord; record: PartnerKeyRecord; plaintext: string };

type Issued = { record: PartnerKeyRecord; hash: string };

/**
 * Compensation for a rotation that will not complete: revoke the key we just
 * issued, whose plaintext the caller will never see. Logged either way; a
 * failure here is the documented worst case (an orphaned active key that
 * nobody holds), so the error names the key for manual revocation.
 */
async function revokeIssuedKey(kv: KVNamespace, issued: Issued, logger: RequestLogger) {
  const record = { ...issued.record, revokedAt: new Date().toISOString(), revokedBy: 'rotation' };
  try {
    await updateRecord(kv, issued.hash, record, logger);
    logger.warn('partner_key_rotation_compensated', { new_key_id: issued.record.id });
  } catch (error) {
    logger.error('partner_key_rotation_orphan', error, {
      new_key_id: issued.record.id,
      action_required: 'revoke this key id manually; its plaintext was never returned',
    });
  }
}

/**
 * The old key's record after rotation: linked to its replacement and either
 * expiring after the grace window or revoked now (grace 0).
 */
function retiredRecord(
  old: PartnerKeyRecord,
  replacement: PartnerKeyRecord,
  opts: { createdBy?: string | undefined; graceSeconds: number }
): PartnerKeyRecord {
  const now = Date.parse(replacement.createdAt);
  const end =
    opts.graceSeconds === 0
      ? { revokedAt: replacement.createdAt }
      : { expiresAt: new Date(now + opts.graceSeconds * 1000).toISOString() };
  return {
    ...old,
    ...end,
    rotatedTo: replacement.id,
    ...(opts.graceSeconds === 0 && opts.createdBy !== undefined
      ? { revokedBy: opts.createdBy }
      : {}),
  };
}

/** Issue the replacement for `old`, inheriting its metadata and user namespace. */
function issueReplacement(kv: KVNamespace, old: PartnerKeyRecord, createdBy?: string) {
  return createPartnerKey(
    kv,
    {
      org: old.org,
      name: old.name,
      app: old.app,
      createdBy: createdBy ?? old.createdBy,
      ...(old.termsVersion !== undefined ? { termsVersion: old.termsVersion } : {}),
      ...(old.termsAcceptedAt !== undefined ? { termsAcceptedAt: old.termsAcceptedAt } : {}),
    },
    { userNamespace: old.userNamespace, rotatedFrom: old.id }
  );
}

/**
 * Rotate: issue a new key with the same metadata (and the same user namespace,
 * so the partner's users keep their history), then retire the old one.
 *
 * Grace: with `graceSeconds > 0` the old key gets `expiresAt = now + grace`
 * and keeps working until then, so the partner can ship the new key without
 * an outage; auth treats it as expired afterwards (partnerKeyStatus). With
 * `graceSeconds === 0` the old key is revoked at once ("rotate and kill now").
 * A key that was already rotated cannot be rotated again (409).
 *
 * Order and failure handling:
 * - The new key is written first. If that fails, nothing changed.
 * - Then the old key is marked retired + `rotatedTo`. If THAT write fails, the
 *   new key is revoked again (compensation) and the error is re-thrown: the
 *   old key stays active and unchanged, and the rotation can simply be retried.
 * - Worst case: the old-key write AND the compensation both fail. Then one
 *   extra active key exists whose plaintext was never returned to anyone; it
 *   is unusable in practice, and `partner_key_rotation_orphan` names it.
 *
 * Concurrency: KV has no compare-and-swap. After writing the old record we
 * re-read it; if its `rotatedTo` is not our new key (a concurrent rotate or
 * revoke wrote after us), we revoke our new key and report a conflict (409).
 * RESIDUAL RACE: KV only guarantees read-your-writes in the location that
 * wrote, so two admin requests served by different Cloudflare locations at
 * the same moment can each re-read their own write and both "win" — leaving
 * two active replacement keys, with the old record naming only one. Admin
 * writes are rare and human-driven; closing this fully needs a single writer
 * (a Durable Object), which is out of scope here.
 */
export async function rotatePartnerKey(
  kv: KVNamespace,
  id: string,
  opts: { createdBy?: string | undefined; graceSeconds: number; logger: RequestLogger }
): Promise<RotateResult> {
  const { createdBy, logger } = opts;
  const found = await getPartnerKeyById(kv, id);
  if (!found) return { status: 'not_found' };
  const old = found.record;
  if (old.revokedAt !== undefined) return { status: 'revoked' };
  if (old.rotatedTo !== undefined) return { status: 'already_rotated', rotatedTo: old.rotatedTo };

  const issued = await issueReplacement(kv, old, createdBy);
  const previous = retiredRecord(old, issued.record, opts);
  try {
    await updateRecord(kv, found.hash, previous, logger);
  } catch (error) {
    logger.error('partner_key_rotation_failed', error, {
      key_id: id,
      new_key_id: issued.record.id,
    });
    await revokeIssuedKey(kv, issued, logger);
    throw error;
  }

  const reread = await getPartnerKeyById(kv, id);
  if (reread?.record.rotatedTo !== issued.record.id) {
    logger.warn('partner_key_rotation_conflict', {
      key_id: id,
      new_key_id: issued.record.id,
      stored_rotated_to: reread?.record.rotatedTo ?? null,
    });
    await revokeIssuedKey(kv, issued, logger);
    return { status: 'conflict' };
  }
  return { status: 'ok', previous, record: issued.record, plaintext: issued.plaintext };
}

/** Walk the id index, collecting the records carried as metadata. */
async function listIndex(
  kv: KVNamespace,
  org: string | undefined,
  logger: RequestLogger
): Promise<{ records: PartnerKeyRecord[]; truncated: boolean }> {
  const records: PartnerKeyRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await kv.list<PartnerKeyRecord>({
      prefix: ID_PREFIX,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of result.keys) {
      if (!entry.metadata) {
        logger.warn('partner_key_index_missing_metadata', { index_key: entry.name });
      } else if (org === undefined || entry.metadata.org === org) {
        records.push(entry.metadata);
      }
    }
    if (result.list_complete) return { records, truncated: false };
    cursor = result.cursor;
  }
  return { records, truncated: true };
}

/**
 * List keys, all orgs or one, newest first — served by `kv.list()` alone (the
 * record rides in each index entry's metadata; no per-key reads). The KV list
 * is eventually consistent, so a change made seconds ago may not show yet;
 * get-by-id reads the authoritative record.
 */
export async function listPartnerKeys(
  kv: KVNamespace,
  org: string | undefined,
  logger: RequestLogger
): Promise<PartnerKeyRecord[]> {
  const { records, truncated } = await listIndex(kv, org, logger);
  if (truncated) {
    logger.warn('partner_key_list_truncated', { org: org ?? null, max_pages: MAX_LIST_PAGES });
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
