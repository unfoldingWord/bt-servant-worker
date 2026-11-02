/**
 * Partner API key store (admin-portal#354), backed by the API_KEYS KV namespace.
 *
 * Layout:
 *   key:<sha256 hex of the plaintext key>  → JSON PartnerKeyRecord (authoritative)
 *   ptr:<key id>                           → <sha256 hex> (immutable pointer)
 *   id:<org>:<key id>                      → <sha256 hex>, metadata = the record
 *
 * The `key:` entry is the source of truth (auth reads it; so do get/revoke/
 * rotate, through the `ptr:` pointer). The `id:` entry is the list index: its
 * metadata is a copy of the record, so a list is served by `kv.list()` alone,
 * with no per-key reads, and an org-scoped list is a prefix list of
 * `id:<org>:` (org ids cannot contain ":"; see ORG_PATTERN). Record fields are size-capped (types/partner-keys.ts) so the copy
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
  partnerKeyStatus,
} from '../../types/partner-keys.js';
import { bytesToHex, sha256Hex } from '../../utils/crypto.js';
import type { RequestLogger } from '../../utils/logger.js';

/** Cloudflare's minimum `cacheTtl` for KV reads; also the revocation-delay bound we document. */
export const AUTH_LOOKUP_CACHE_TTL_SECONDS = 60;
/** Cloudflare's limit on the serialized metadata of one KV key. */
export const KV_METADATA_MAX_BYTES = 1024;

const KEY_PREFIX = 'key:';
const PTR_PREFIX = 'ptr:';
const ID_PREFIX = 'id:';

/** List-index key for a record: `id:<org>:<keyId>`. */
function indexKey(record: Pick<PartnerKeyRecord, 'org' | 'id'>): string {
  return `${ID_PREFIX}${record.org}:${record.id}`;
}
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

/** The non-secret display prefix (`bts_<8 hex>`) of a partner-shaped token. */
export function partnerKeyPrefix(token: string): string {
  return token.slice(0, PLAINTEXT_PREFIX.length + 8);
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
  const hash = await kv.get(`${PTR_PREFIX}${id}`);
  if (!hash) return null;
  const record = await kv.get<PartnerKeyRecord>(`${KEY_PREFIX}${hash}`, 'json');
  return record ? { record, hash } : null;
}

async function putIndex(kv: KVNamespace, hash: string, record: PartnerKeyRecord): Promise<void> {
  await kv.put(indexKey(record), hash, { metadata: record });
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
 * The pointer + list-index writes for a brand-new key. Without the pointer the
 * key could never be found by id (so never revoked), so a failure is fatal.
 * What was already written is deleted first (the plaintext was never
 * returned); if even that fails, an orphan log names the key —
 * `partner_key_create_orphan` or `partner_key_rotation_orphan` by path.
 */
async function indexNewKey(
  kv: KVNamespace,
  hash: string,
  record: PartnerKeyRecord,
  logger: RequestLogger
): Promise<void> {
  const phase = record.rotatedFrom === undefined ? 'create' : 'rotation';
  try {
    await kv.put(`${PTR_PREFIX}${record.id}`, hash);
    await putIndex(kv, hash, record);
  } catch (error) {
    logger.error('partner_key_index_write_failed', error, { key_id: record.id, phase });
    try {
      await kv.delete(`${KEY_PREFIX}${hash}`);
      await kv.delete(`${PTR_PREFIX}${record.id}`);
    } catch (cleanupError) {
      logger.error(`partner_key_${phase}_orphan`, cleanupError, {
        new_key_id: record.id,
        action_required: 'partly written key left behind; its plaintext was never returned',
      });
    }
    throw error;
  }
}

/**
 * Issue a new key. `carry` is used by rotation to keep the user namespace and
 * link the two records. Returns the stored record and the one-time plaintext.
 */
export async function createPartnerKey(
  kv: KVNamespace,
  input: PartnerKeyCreateInput,
  opts: { logger: RequestLogger; carry?: { userNamespace?: string; rotatedFrom?: string } }
): Promise<{ record: PartnerKeyRecord; plaintext: string; hash: string }> {
  const carry = opts.carry ?? {};
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
  // Record first, then index (compensated on failure; see indexNewKey). A crash
  // between the two leaves an unlisted record whose plaintext was never
  // returned, so nobody can use it.
  await kv.put(`${KEY_PREFIX}${hash}`, JSON.stringify(record));
  await indexNewKey(kv, hash, record, opts.logger);
  return { record, plaintext, hash };
}

/** Upper bound on predecessors walked by a cascading revoke (guards against cycles). */
const MAX_CHAIN_DEPTH = 50;

type RevocationStamp = { revokedAt: string; revokedBy?: string | undefined };

/**
 * Write `revokedAt` onto a key, then re-read: if a concurrent writer (a rotate
 * built from a stale read) clobbered it, apply it again on top of what is now
 * stored. Returns the stored record and whether it had to re-apply.
 */
async function writeRevocation(
  kv: KVNamespace,
  found: { record: PartnerKeyRecord; hash: string },
  stamp: RevocationStamp,
  logger: RequestLogger
): Promise<{ record: PartnerKeyRecord; reapplied: boolean }> {
  const fields = {
    revokedAt: stamp.revokedAt,
    ...(stamp.revokedBy !== undefined ? { revokedBy: stamp.revokedBy } : {}),
  };
  const record: PartnerKeyRecord = { ...found.record, ...fields };
  await updateRecord(kv, found.hash, record, logger);
  const reread = await getPartnerKeyById(kv, found.record.id);
  if (!reread || reread.record.revokedAt !== undefined) {
    return { record: reread?.record ?? record, reapplied: false };
  }
  logger.warn('partner_key_revoke_reapplied', { key_id: found.record.id });
  const merged: PartnerKeyRecord = { ...reread.record, ...fields };
  await updateRecord(kv, reread.hash, merged, logger);
  return { record: merged, reapplied: true };
}

/**
 * Revoke the successors of `key` forward along `rotatedTo` (each link checked
 * via the successor's `rotatedFrom`). Used only when a revoke had to re-apply
 * itself: the rotation that clobbered it issued a successor in the race, and
 * the admin's intent was to cut the partner off. Returns the ids it revoked.
 */
async function revokeRaceSuccessors(
  kv: KVNamespace,
  key: PartnerKeyRecord,
  stamp: RevocationStamp,
  logger: RequestLogger
): Promise<string[]> {
  const revoked: string[] = [];
  let predecessor = key;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && predecessor.rotatedTo; depth++) {
    const found = await getPartnerKeyById(kv, predecessor.rotatedTo);
    if (!found || found.record.rotatedFrom !== predecessor.id) break;
    if (found.record.revokedAt === undefined) {
      const { record } = await writeRevocation(kv, found, stamp, logger);
      revoked.push(record.id);
    }
    predecessor = found.record;
  }
  return revoked;
}

/**
 * Revoke every predecessor of `key` that is still in its rotation grace
 * window (walks `rotatedFrom`; a predecessor counts only if its `rotatedTo`
 * is the key that replaced it). Returns the ids it revoked.
 */
async function revokeGracePredecessors(
  kv: KVNamespace,
  key: PartnerKeyRecord,
  stamp: RevocationStamp,
  logger: RequestLogger
): Promise<string[]> {
  const revoked: string[] = [];
  let successor = key;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && successor.rotatedFrom; depth++) {
    const found = await getPartnerKeyById(kv, successor.rotatedFrom);
    if (!found || found.record.rotatedTo !== successor.id) break;
    if (partnerKeyStatus(found.record, Date.parse(stamp.revokedAt)) === 'active') {
      await writeRevocation(kv, found, stamp, logger);
      revoked.push(found.record.id);
    }
    successor = found.record;
  }
  return revoked;
}

/**
 * Revoke by id — and the whole rotation chain behind it: any predecessor
 * still working in its grace window is revoked too, so revoking the current
 * key really cuts the partner off. If the revocation had to be re-applied
 * because a concurrent rotate clobbered it, the successor that rotate issued
 * (and its chain forward) is revoked as well. Idempotent: revoking a revoked key returns
 * it with `alreadyRevoked: true` (the chain is still checked). Returns null
 * when no such key exists. `revokedIds` lists every key this call revoked.
 */
export async function revokePartnerKey(
  kv: KVNamespace,
  id: string,
  opts: { revokedBy?: string | undefined; logger: RequestLogger }
): Promise<{ record: PartnerKeyRecord; alreadyRevoked: boolean; revokedIds: string[] } | null> {
  const found = await getPartnerKeyById(kv, id);
  if (!found) return null;
  const stamp = { revokedAt: new Date().toISOString(), revokedBy: opts.revokedBy };
  const alreadyRevoked = found.record.revokedAt !== undefined;
  const written = alreadyRevoked
    ? { record: found.record, reapplied: false }
    : await writeRevocation(kv, found, stamp, opts.logger);
  const { record } = written;
  const predecessors = await revokeGracePredecessors(kv, record, stamp, opts.logger);
  const successors = written.reapplied
    ? await revokeRaceSuccessors(kv, record, stamp, opts.logger)
    : [];
  const self = alreadyRevoked ? [] : [record.id];
  return { record, alreadyRevoked, revokedIds: [...self, ...predecessors, ...successors] };
}

export type RotateResult =
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'already_rotated'; rotatedTo: string }
  | { status: 'conflict' }
  | {
      status: 'ok';
      previous: PartnerKeyRecord;
      record: PartnerKeyRecord;
      plaintext: string;
      /** Keys this rotation killed: with grace 0, the rotated key and its in-grace predecessors. */
      revokedIds: string[];
    };

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
function issueReplacement(
  kv: KVNamespace,
  old: PartnerKeyRecord,
  createdBy: string | undefined,
  logger: RequestLogger
) {
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
    { logger, carry: { userNamespace: old.userNamespace, rotatedFrom: old.id } }
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
 * Concurrency: KV has no compare-and-swap, so rotate checks twice:
 * - just before writing, it re-reads the old record; if it is no longer active
 *   or was rotated meanwhile, it revokes its new key and reports 409;
 * - after writing, it re-reads again; if `rotatedTo` is not its key (another
 *   rotate won) or a revocation it did not write is now present, it revokes
 *   its new key and reports 409.
 * A revoke that lands between the pre-write read and the write would be
 * clobbered by it; revokePartnerKey closes that by re-reading after its own
 * write and re-applying revokedAt if it was lost.
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
  const { logger } = opts;
  const found = await getPartnerKeyById(kv, id);
  if (!found) return { status: 'not_found' };
  const refusal = rotationRefusal(found.record);
  if (refusal) return refusal;

  const issued = await issueReplacement(kv, found.record, opts.createdBy, logger);
  // Re-read just before writing so a revoke/rotate that landed while the new
  // key was being issued is not silently overwritten by our stale copy.
  const fresh = await getPartnerKeyById(kv, id);
  if (!fresh || rotationRefusal(fresh.record)) {
    return abortRotation(kv, issued, { key_id: id, phase: 'pre_write' }, logger);
  }
  const previous = retiredRecord(fresh.record, issued.record, opts);
  try {
    await updateRecord(kv, fresh.hash, previous, logger);
  } catch (error) {
    logger.error('partner_key_rotation_failed', error, {
      key_id: id,
      new_key_id: issued.record.id,
    });
    await revokeIssuedKey(kv, issued, logger);
    throw error;
  }

  const reread = await getPartnerKeyById(kv, id);
  if (!rotationHeld(reread?.record, previous, issued.record.id)) {
    return abortRotation(kv, issued, { key_id: id, phase: 'post_write' }, logger);
  }
  const revokedIds = await killChainIfImmediate(kv, previous, logger);
  const { record, plaintext } = issued;
  return { status: 'ok', previous, record, plaintext, revokedIds };
}

/**
 * `graceSeconds: 0` means "rotate and kill now" for the whole chain, same as
 * revoke: the rotated key is already revoked by retiredRecord; this also
 * revokes its predecessors still in their grace window. Returns all killed ids.
 */
async function killChainIfImmediate(
  kv: KVNamespace,
  previous: PartnerKeyRecord,
  logger: RequestLogger
): Promise<string[]> {
  if (previous.revokedAt === undefined) return [];
  const stamp = { revokedAt: previous.revokedAt, revokedBy: previous.revokedBy };
  return [previous.id, ...(await revokeGracePredecessors(kv, previous, stamp, logger))];
}

/** Why `record` cannot be rotated now, or null when it can. */
function rotationRefusal(record: PartnerKeyRecord): RotateResult | null {
  if (record.rotatedTo !== undefined) {
    return { status: 'already_rotated', rotatedTo: record.rotatedTo };
  }
  if (partnerKeyStatus(record, Date.now()) !== 'active') return { status: 'revoked' };
  return null;
}

/**
 * Our write survived: the stored old record names our key AND carries no
 * revocation we did not write ourselves (a concurrent revoke that read after
 * our write keeps rotatedTo but adds revokedAt — that revoke wins).
 */
function rotationHeld(
  stored: PartnerKeyRecord | undefined,
  written: PartnerKeyRecord,
  newKeyId: string
): boolean {
  if (stored?.rotatedTo !== newKeyId) return false;
  return stored.revokedAt === undefined || written.revokedAt !== undefined;
}

/** A concurrent writer won: revoke the key we issued and report a conflict. */
async function abortRotation(
  kv: KVNamespace,
  issued: Issued,
  context: { key_id: string; phase: string },
  logger: RequestLogger
): Promise<RotateResult> {
  logger.warn('partner_key_rotation_conflict', { ...context, new_key_id: issued.record.id });
  await revokeIssuedKey(kv, issued, logger);
  return { status: 'conflict' };
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
      prefix: org === undefined ? ID_PREFIX : `${ID_PREFIX}${org}:`,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of result.keys) {
      if (!entry.metadata) {
        logger.warn('partner_key_index_missing_metadata', { index_key: entry.name });
      } else {
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
