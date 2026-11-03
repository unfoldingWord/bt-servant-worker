/**
 * Partner API keys (admin-portal#354): the two ways the worker reaches them.
 *
 * 1. Auth (every partner request): one KV read of the projection at
 *    API_KEYS `key:<sha256 of the plaintext>`. The plaintext never touches
 *    storage; a plain SHA-256 is right here because the key carries 256
 *    bits of CSPRNG output (nothing to brute-force, unlike a password).
 * 2. Administration (create, list, get, revoke, rotate): calls to the single
 *    PartnerKeyStoreDO, the only writer and the source of truth (see
 *    ledger.ts). The DO writes the KV projection after each change.
 *
 * Consistency: KV is eventually consistent and the auth lookup caches for
 * AUTH_LOOKUP_CACHE_TTL_SECONDS, misses included. So a revocation can take
 * about a minute to be seen everywhere (portal#354 question 5), and a
 * brand-new key may also take up to ~60s to work everywhere; prefer rotation
 * with a grace period. Rotation-grace expiry is exact, not delayed: auth
 * compares `expiresAt` with the clock on every request.
 */

import type { PartnerKeyCreateInput, PartnerKeyRecord } from '../../types/partner-keys.js';
import type { RevokeOutcome, RotateOutcome } from './ledger.js';
import { PARTNER_KEY_KV_PREFIX, partnerKeyHash } from './key-material.js';

/**
 * `cacheTtl` for the auth lookup: Cloudflare's default (60s; the minimum is
 * 30). Per the KV docs, found keys AND misses ("negative lookups") are cached
 * at the edge, so this is the documented bound for a revocation — and for a
 * brand-new key — to be seen everywhere.
 */
export const AUTH_LOOKUP_CACHE_TTL_SECONDS = 60;

/** The one PartnerKeyStoreDO instance (`idFromName`). */
export const PARTNER_KEY_STORE_NAME = 'global';

/**
 * Auth hot path: resolve a presented bearer token to its record, or null when
 * no key has that hash. Status is NOT checked here — the caller decides (and
 * logs) so unknown, revoked and expired keys stay distinguishable.
 */
export async function lookupPartnerKeyByToken(
  kv: KVNamespace,
  token: string
): Promise<PartnerKeyRecord | null> {
  const hash = await partnerKeyHash(token);
  return kv.get<PartnerKeyRecord>(`${PARTNER_KEY_KV_PREFIX}${hash}`, {
    type: 'json',
    cacheTtl: AUTH_LOOKUP_CACHE_TTL_SECONDS,
  });
}

/** One operation sent to the PartnerKeyStoreDO (internal protocol, worker → DO). */
export type PartnerKeyStoreOp =
  | { op: 'create'; input: PartnerKeyCreateInput }
  | { op: 'list'; org?: string }
  | { op: 'get'; id: string }
  | { op: 'revoke'; id: string; revokedBy?: string }
  | { op: 'rotate'; id: string; createdBy?: string; graceSeconds: number }
  | { op: 'acquireImportLease'; namespace: string; holder: string }
  | { op: 'releaseImportLease'; namespace: string; holder: string };

export type CreateOutcome = { record: PartnerKeyRecord; plaintext: string; warnings: string[] };

/**
 * Admin client for the PartnerKeyStoreDO. Every call is one DO request; the
 * DO runs requests one at a time. A DO failure throws (the route answers 500).
 */
export function partnerKeyStore(ns: DurableObjectNamespace, requestId: string) {
  const stub = ns.get(ns.idFromName(PARTNER_KEY_STORE_NAME));
  async function call<T>(op: PartnerKeyStoreOp): Promise<T> {
    const res = await stub.fetch('https://partner-key-store/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
      body: JSON.stringify(op),
    });
    if (!res.ok) {
      throw new Error(
        `partner key store '${op.op}' failed with ${res.status}: ${await res.text()}`
      );
    }
    return (await res.json()) as T;
  }
  return {
    create: (input: PartnerKeyCreateInput) => call<CreateOutcome>({ op: 'create', input }),
    list: (org?: string) =>
      call<{ records: PartnerKeyRecord[] }>(
        org === undefined ? { op: 'list' } : { op: 'list', org }
      ),
    get: async (id: string) =>
      (await call<{ record: PartnerKeyRecord | null }>({ op: 'get', id })).record,
    revoke: (id: string, revokedBy?: string) =>
      call<RevokeOutcome | null>(
        revokedBy === undefined ? { op: 'revoke', id } : { op: 'revoke', id, revokedBy }
      ),
    rotate: (id: string, opts: { createdBy?: string; graceSeconds: number }) =>
      call<RotateOutcome>({ op: 'rotate', id, ...opts }),
    /**
     * Take the legacy-import lease of a user namespace for `holder`; false
     * while another import holds it. Keyed by namespace, not key id: every key
     * in a rotation chain shares the namespace (and so the audio partition).
     */
    acquireImportLease: async (namespace: string, holder: string) =>
      (await call<{ acquired: boolean }>({ op: 'acquireImportLease', namespace, holder })).acquired,
    /** Release the lease if `holder` still holds it. */
    releaseImportLease: async (namespace: string, holder: string) => {
      await call<{ released: boolean }>({ op: 'releaseImportLease', namespace, holder });
    },
  };
}
