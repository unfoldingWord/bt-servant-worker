/**
 * Partner API key store (admin-portal#354), backed by the API_KEYS KV namespace.
 *
 * Layout:
 *   key:<sha256 hex of the plaintext key>  → JSON PartnerKeyRecord
 *   id:<key id>                            → <sha256 hex>, metadata { org }
 *
 * The plaintext key never touches storage: only its SHA-256 is used, as the KV
 * key. A plain (unsalted, fast) hash is the right tool here because the key is
 * 256 bits of CSPRNG output — there is nothing to brute-force, unlike a
 * password — and it keeps the auth hot path to one KV read.
 *
 * Consistency: KV is eventually consistent and the auth lookup caches for
 * AUTH_LOOKUP_CACHE_TTL_SECONDS, so a revocation (or a brand-new key) can take
 * about a minute to be seen everywhere. That delay is a known, accepted trade
 * (portal#354 question 5).
 */

import {
  type PartnerKeyCreateInput,
  type PartnerKeyRecord,
  PARTNER_KEY_ID_PATTERN,
} from '../../types/partner-keys.js';
import type { RequestLogger } from '../../utils/logger.js';

/** Cloudflare's minimum `cacheTtl` for KV reads; also the revocation-delay bound we document. */
export const AUTH_LOOKUP_CACHE_TTL_SECONDS = 60;

const KEY_PREFIX = 'key:';
const ID_PREFIX = 'id:';
const PLAINTEXT_PREFIX = 'bts_';
/** Plaintext shape: `bts_<8 hex prefix>_<43 base64url chars = 256 random bits>`. */
const PLAINTEXT_PATTERN = /^bts_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;
/** Upper bound on index pages walked by a list, so a runaway namespace cannot pin a request. */
const MAX_LIST_PAGES = 20;

interface IdIndexMetadata {
  org: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(byteCount: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

function randomBase64Url(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 of a string, lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
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

async function writeRecord(kv: KVNamespace, hash: string, record: PartnerKeyRecord) {
  await kv.put(`${KEY_PREFIX}${hash}`, JSON.stringify(record));
}

/**
 * Issue a new key. `carry` is used by rotation to keep the user namespace and
 * link the two records. Returns the stored record and the one-time plaintext.
 */
export async function createPartnerKey(
  kv: KVNamespace,
  input: PartnerKeyCreateInput,
  carry: { userNamespace?: string; rotatedFrom?: string } = {}
): Promise<{ record: PartnerKeyRecord; plaintext: string }> {
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
  // Record first, index second: a crash between the two leaves an unlisted but
  // unusable-by-anyone record (its plaintext was never returned), never an
  // index entry pointing at nothing.
  await writeRecord(kv, hash, record);
  await kv.put(`${ID_PREFIX}${id}`, hash, {
    metadata: { org: input.org } satisfies IdIndexMetadata,
  });
  return { record, plaintext };
}

/**
 * Revoke by id. Idempotent: revoking a revoked key returns it unchanged with
 * `alreadyRevoked: true`. Returns null when no such key exists.
 */
export async function revokePartnerKey(
  kv: KVNamespace,
  id: string,
  revokedBy?: string
): Promise<{ record: PartnerKeyRecord; alreadyRevoked: boolean } | null> {
  const found = await getPartnerKeyById(kv, id);
  if (!found) return null;
  if (found.record.revokedAt !== undefined) return { record: found.record, alreadyRevoked: true };
  const record: PartnerKeyRecord = {
    ...found.record,
    revokedAt: new Date().toISOString(),
    ...(revokedBy !== undefined ? { revokedBy } : {}),
  };
  await writeRecord(kv, found.hash, record);
  return { record, alreadyRevoked: false };
}

export type RotateResult =
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'ok'; previous: PartnerKeyRecord; record: PartnerKeyRecord; plaintext: string };

/**
 * Rotate: issue a new key with the same metadata (and the same user namespace,
 * so the partner's users keep their history), then revoke the old one. The
 * new key is written first so a failure part-way never leaves the partner with
 * no usable key; the worst case is two active keys, and the thrown error names both.
 */
export async function rotatePartnerKey(
  kv: KVNamespace,
  id: string,
  createdBy?: string
): Promise<RotateResult> {
  const found = await getPartnerKeyById(kv, id);
  if (!found) return { status: 'not_found' };
  const old = found.record;
  if (old.revokedAt !== undefined) return { status: 'revoked' };

  const { record, plaintext } = await createPartnerKey(
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
  const previous: PartnerKeyRecord = {
    ...old,
    revokedAt: record.createdAt,
    rotatedTo: record.id,
    ...(createdBy !== undefined ? { revokedBy: createdBy } : {}),
  };
  try {
    await writeRecord(kv, found.hash, previous);
  } catch (error) {
    // Re-throw with both ids so the route's 500 log says exactly what to clean up.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Rotation incomplete: new key ${record.id} issued but ${old.id} not revoked: ${message}`,
      { cause: error }
    );
  }
  return { status: 'ok', previous, record, plaintext };
}

/** Walk the id index, optionally keeping only one org's entries (by index metadata). */
async function listIndexHashes(
  kv: KVNamespace,
  org: string | undefined
): Promise<{ hashes: string[]; truncated: boolean }> {
  const hashes: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await kv.list<IdIndexMetadata>({
      prefix: ID_PREFIX,
      ...(cursor ? { cursor } : {}),
    });
    const keys = result.keys.filter((k) => org === undefined || k.metadata?.org === org);
    const values = await Promise.all(keys.map((k) => kv.get(k.name)));
    for (const v of values) if (v) hashes.push(v);
    if (result.list_complete) return { hashes, truncated: false };
    cursor = result.cursor;
  }
  return { hashes, truncated: true };
}

/**
 * List keys, all orgs or one. Sorted newest first. The KV list index is
 * eventually consistent, so a key created seconds ago may be missing briefly.
 * An index entry whose record is gone is logged and skipped, never returned.
 */
export async function listPartnerKeys(
  kv: KVNamespace,
  org: string | undefined,
  logger: RequestLogger
): Promise<PartnerKeyRecord[]> {
  const { hashes, truncated } = await listIndexHashes(kv, org);
  if (truncated) {
    logger.warn('partner_key_list_truncated', { org: org ?? null, max_pages: MAX_LIST_PAGES });
  }
  const records = await Promise.all(
    hashes.map((h) => kv.get<PartnerKeyRecord>(`${KEY_PREFIX}${h}`, 'json'))
  );
  const present: PartnerKeyRecord[] = [];
  records.forEach((record, i) => {
    if (record) {
      present.push(record);
    } else {
      // eslint-disable-next-line security/detect-object-injection -- i is the forEach index
      logger.warn('partner_key_index_orphan', { hash_prefix: hashes[i]?.slice(0, 8) });
    }
  });
  return present.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
