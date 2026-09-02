/**
 * MCP server pool helpers (admin-portal#278).
 *
 * The pool is one library shared by every organization (unlike modes and
 * languages), stored under MCP_GLOBAL_KEY. This module holds:
 *
 * - the read path with its transitional fallback to the legacy per-org key,
 * - the public projection that never serialises `authToken`,
 * - the write-rule merge that keeps a stored token across a redacted
 *   read → edit → write round-trip.
 *
 * All helpers are pure or take the KV namespace explicitly so they unit-test
 * without the Worker.
 */

import { MCPServerConfig, MCPServerConfigPublic, MCPServerWrite } from '../types/mcp.js';
import { constantTimeCompare } from './crypto.js';
import { RequestLogger } from './logger.js';
import { MCP_GLOBAL_KEY } from './mcp-validation.js';

// ─── Read path ────────────────────────────────────────────────────────────────

/** Where a pool read originates; controls how the fallback is logged. */
export type PoolReadSource = 'admin' | 'chat';

export interface McpServerPool {
  servers: MCPServerConfig[];
  /**
   * True when `__global__` exists in the namespace (even as `[]`). False means
   * the pool was served from the legacy DEFAULT_ORG key, or is empty because
   * neither key exists. Write routes refuse with 409 unless this is true: the
   * migration runbook on admin-portal#278 (or, for a fresh/local namespace,
   * seeding `__global__` with `[]`) is the only path that creates the key.
   * Letting a write create it would race KV's eventual consistency — a colo
   * with a stale miss on `__global__` could rebuild the pool from whatever
   * legacy view it had — and could seal off legacy keys of other orgs.
   */
  migrated: boolean;
  /** True when the legacy DEFAULT_ORG key exists and was read as the fallback (unmigrated only). */
  fallbackFound: boolean;
  /**
   * Names of every key in the namespace other than `__global__` — while
   * unmigrated, the legacy org lists the runbook must merge; once migrated,
   * leftovers that are no longer served. Populated for admin reads only
   * (always `[]` for chat reads). Best-effort: see `legacyListing`.
   */
  legacyKeys: string[];
  /**
   * Whether `legacyKeys` is trustworthy. KV `list` is eventually consistent
   * and can fail or lag `get`, so guidance that depends on "no legacy keys"
   * must require `'complete'` — never infer emptiness from `'failed'`,
   * `'truncated'`, or `'skipped'` (chat reads).
   */
  legacyListing: 'complete' | 'truncated' | 'failed' | 'skipped';
  /**
   * True when `get('__global__')` missed but the key listing returned
   * `__global__`: this read is a stale miss (KV eventual consistency), not a
   * fresh namespace. Guidance must say "retry", never "seed".
   */
  staleGlobalSuspected: boolean;
}

interface LegacyKeyListing {
  /** Every key except `__global__`. */
  names: string[];
  /** Whether `__global__` itself appeared in the listing. */
  globalListed: boolean;
  status: 'complete' | 'truncated' | 'failed';
}

/** Once-per-isolate latch so the chat hot path does not log on every turn. */
let chatFallbackWarned = false;

/** Test seam: reset the once-per-isolate chat warning latch. */
export function resetChatFallbackWarning(): void {
  chatFallbackWarned = false;
}

/** Upper bound on `kv.list` pages when enumerating legacy keys for the warn. */
const MAX_LEGACY_KEY_PAGES = 10;

/**
 * Structural check for a stored entry: what the chat path and the public
 * projection dereference. Deliberately looser than validateServerConfig so a
 * pre-#278 record with, say, an out-of-range priority still serves; it only
 * rejects shapes that would crash a caller or send `Bearer [object Object]`.
 */
function isStoredServer(value: unknown): value is MCPServerConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as { id?: unknown; url?: unknown; authToken?: unknown };
  return (
    typeof v.id === 'string' &&
    typeof v.url === 'string' &&
    (v.authToken === undefined || typeof v.authToken === 'string')
  );
}

function assertPoolShape(value: unknown, key: string): MCPServerConfig[] {
  if (!Array.isArray(value)) {
    throw new Error(`MCP_SERVERS key '${key}' is not a JSON array (got ${typeof value})`);
  }
  const bad = value.findIndex((v) => !isStoredServer(v));
  if (bad >= 0) {
    throw new Error(
      `MCP_SERVERS key '${key}' element ${String(bad)} is not a server config object`
    );
  }
  return value as MCPServerConfig[];
}

/**
 * Read a key as text and parse it, so an absent key (`null` from KV) is
 * distinguishable from a stored JSON `null` (corrupt — never written by the
 * API, and `get(..., 'json')` would have made it look like a missing key).
 */
async function readPoolKey(kv: KVNamespace, key: string): Promise<MCPServerConfig[] | null> {
  const raw = await kv.get(key, 'text');
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null) {
    throw new Error(`MCP_SERVERS key '${key}' holds JSON null`);
  }
  return assertPoolShape(parsed, key);
}

/**
 * Enumerate the namespace's keys (other than `__global__`) so the migration
 * runbook can see legacy org keys it must merge (admin-portal#278 Q#6). Purely
 * diagnostic: a listing failure is logged and must never fail the read.
 */
async function listLegacyKeys(kv: KVNamespace, logger: RequestLogger): Promise<LegacyKeyListing> {
  const names: string[] = [];
  let globalListed = false;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LEGACY_KEY_PAGES; page++) {
      const result = await kv.list(
        cursor === undefined ? { limit: 1000 } : { limit: 1000, cursor }
      );
      for (const { name } of result.keys) {
        if (name === MCP_GLOBAL_KEY) globalListed = true;
        else names.push(name);
      }
      if (result.list_complete) return { names, globalListed, status: 'complete' };
      cursor = result.cursor;
    }
    logger.warn('mcp_legacy_key_list_truncated', {
      pages: MAX_LEGACY_KEY_PAGES,
      listed: names.length,
    });
    return { names, globalListed, status: 'truncated' };
  } catch (error) {
    logger.error('mcp_legacy_key_list_failed', error, { listed: names.length });
    return { names, globalListed, status: 'failed' };
  }
}

/** Prepend a key that a direct `get` just found, if the listing did not report it. */
function withKnownKey(names: string[], key: string, known: boolean): string[] {
  return known && !names.includes(key) ? [key, ...names] : names;
}

/**
 * Read the global MCP server pool.
 *
 * Fallback (transitional, admin-portal#278 migration): when `__global__` is
 * JSON `null` (key absent) the legacy DEFAULT_ORG key is read instead so a
 * staging redeploy on a PR push never blanks the pool. `[]` under `__global__`
 * is a real, empty pool and disables the fallback. Reads never write.
 *
 * Throws when KV fails or a stored value is JSON null or not an array of
 * server configs; admin routes turn that into a 500 and the chat path degrades
 * to an empty pool.
 */
export async function readMcpServerPool(
  kv: KVNamespace,
  defaultOrg: string,
  logger: RequestLogger,
  source: PoolReadSource
): Promise<McpServerPool> {
  const global = await readPoolKey(kv, MCP_GLOBAL_KEY);
  if (global !== null) {
    return migratedPool(global, defaultOrg, kv, logger, source);
  }
  return fallbackPool(await readPoolKey(kv, defaultOrg), defaultOrg, kv, logger, source);
}

/** `__global__` exists: it is what is served; admin reads also surface leftovers. */
async function migratedPool(
  global: MCPServerConfig[],
  defaultOrg: string,
  kv: KVNamespace,
  logger: RequestLogger,
  source: PoolReadSource
): Promise<McpServerPool> {
  // A successful global read re-arms the chat warning so a rollback that
  // deletes `__global__` is reported again by reused isolates.
  chatFallbackWarned = false;
  if (source !== 'admin') {
    return {
      servers: global,
      migrated: true,
      fallbackFound: false,
      legacyKeys: [],
      legacyListing: 'skipped',
      staleGlobalSuspected: false,
    };
  }
  // Admin reads enumerate leftovers so a mistaken migration (e.g. `[]` seeded
  // over live legacy data) is visible on the API, not only in logs. The
  // listing is eventually consistent and may fail, so the legacy DEFAULT_ORG
  // key is also read directly and reported even when the listing misses it.
  const [listing, legacyStillPresent] = await Promise.all([
    listLegacyKeys(kv, logger),
    kv.get(defaultOrg, 'text').then((raw) => raw !== null),
  ]);
  const names = withKnownKey(listing.names, defaultOrg, legacyStillPresent);
  if (names.length > 0 || listing.status !== 'complete') {
    logger.warn('mcp_legacy_keys_leftover', {
      global_key: MCP_GLOBAL_KEY,
      global_server_count: global.length,
      legacy_keys: names,
      legacy_listing: listing.status,
    });
  }
  return {
    servers: global,
    migrated: true,
    fallbackFound: false,
    legacyKeys: names,
    legacyListing: listing.status,
    staleGlobalSuspected: false,
  };
}

/** `__global__` is absent: serve the legacy DEFAULT_ORG key (or nothing) and say so. */
async function fallbackPool(
  legacy: MCPServerConfig[] | null,
  defaultOrg: string,
  kv: KVNamespace,
  logger: RequestLogger,
  source: PoolReadSource
): Promise<McpServerPool> {
  const fallbackFound = legacy !== null;
  const data = {
    global_key: MCP_GLOBAL_KEY,
    fallback_key: defaultOrg,
    fallback_found: fallbackFound,
    server_count: legacy?.length ?? 0,
  };

  if (source === 'chat') {
    // Chat is the hot path: one warn per isolate is the operator signal.
    if (!chatFallbackWarned) {
      chatFallbackWarned = true;
      logger.warn('mcp_global_key_missing', { ...data, once_per_isolate: true });
    }
    return {
      servers: legacy ?? [],
      migrated: false,
      fallbackFound,
      legacyKeys: [],
      legacyListing: 'skipped',
      staleGlobalSuspected: false,
    };
  }

  // Admin reads are rare: always warn, with the namespace's other keys so any
  // legacy org list the runbook must merge is visible (also returned to the
  // caller for the GET warning and the 409 body). The key we just read is
  // always included even if `list` has not caught up with `get`, and a
  // listing that reports `__global__` while `get` missed it marks this read as
  // a stale miss.
  const listing = await listLegacyKeys(kv, logger);
  const names = withKnownKey(listing.names, defaultOrg, fallbackFound);
  logger.warn('mcp_global_key_missing', {
    ...data,
    legacy_keys: names,
    legacy_listing: listing.status,
    stale_global_suspected: listing.globalListed,
  });
  return {
    servers: legacy ?? [],
    migrated: false,
    fallbackFound,
    legacyKeys: names,
    legacyListing: listing.status,
    staleGlobalSuspected: listing.globalListed,
  };
}

// ─── Operator guidance ────────────────────────────────────────────────────────

/**
 * Human guidance for an unmigrated namespace, shared by the GET warning and the
 * 409 body. The API never tells an operator to seed `[]`: no server-side read
 * can prove a namespace empty (KV `get` and `list` are eventually consistent,
 * and a colo with a stale miss on `__global__` would otherwise instruct an
 * overwrite of the live pool). The operator runs `wrangler kv key list` and
 * seeds `[]` only if THAT listing is empty; anything else migrates from raw
 * values. GET-body write-back is always forbidden: GET bodies are redacted and
 * writing one over a `[]` seed would drop every stored authToken (rounds 3–5).
 */
export function describeMigrationHint(pool: McpServerPool): string {
  if (pool.staleGlobalSuspected) {
    return `The key listing shows '${MCP_GLOBAL_KEY}' although this read did not find it: this is a stale read (KV eventual consistency), not an unmigrated namespace. Retry shortly. Do NOT seed [] and do NOT write anything.`;
  }
  const known =
    pool.legacyKeys.length > 0
      ? `Legacy key(s) seen by this read: [${pool.legacyKeys.join(', ')}].`
      : 'This read saw no legacy keys, which is not proof that none exist.';
  const listingNote =
    pool.legacyListing === 'complete'
      ? ''
      : ` (Server-side key listing was ${pool.legacyListing === 'skipped' ? 'not run' : pool.legacyListing}.)`;
  return `${known}${listingNote} Run wrangler kv key list --binding=MCP_SERVERS yourself: if it shows ANY key, create '${MCP_GLOBAL_KEY}' from the RAW KV value(s) of the legacy key(s) with the admin-portal#278 runbook (wrangler kv key get … then wrangler kv key put … ${MCP_GLOBAL_KEY} --path …); only if it shows no keys at all, seed '${MCP_GLOBAL_KEY}' with []. Never write an admin GET body back: GET bodies are redacted and carry no authToken.`;
}

/**
 * Human warning for a migrated pool whose namespace may still hold legacy
 * keys. Not an error state: `__global__` is what is served. Fires when
 * leftovers were seen OR the listing was incomplete (leftovers may exist
 * unseen). Returns null only for a complete listing with no leftovers.
 */
export function describeLeftoverLegacyKeys(pool: McpServerPool): string | null {
  if (!pool.migrated) return null;
  if (pool.legacyKeys.length === 0 && pool.legacyListing === 'complete') return null;
  const seen =
    pool.legacyKeys.length > 0
      ? `leftover legacy key(s) [${pool.legacyKeys.join(', ')}] are no longer read`
      : `the server-side key listing was ${pool.legacyListing === 'skipped' ? 'not run' : pool.legacyListing}, so leftover legacy keys may exist unseen`;
  return `'${MCP_GLOBAL_KEY}' exists and is what is served; ${seen}. If '${MCP_GLOBAL_KEY}' was seeded with [] by mistake, restore it from the RAW KV value of the legacy key (runbook on admin-portal#278). Do not delete legacy keys until the global copy is confirmed (wrangler kv key list --binding=MCP_SERVERS).`;
}

/**
 * Writes to the global pool are super-admin only: an org-scoped admin key must
 * never be able to replace every org's pool. Returns the 403 message, or null
 * when the bearer token is ENGINE_API_KEY. Pure so it can be unit-tested even
 * though the global `/api/*` middleware already rejects other tokens upstream.
 */
export function poolWriteAuthError(
  authorizationHeader: string | undefined,
  engineApiKey: string
): string | null {
  const token = authorizationHeader?.startsWith('Bearer ') ? authorizationHeader.slice(7) : '';
  if (token.length > 0 && constantTimeCompare(token, engineApiKey)) return null;
  return 'Writing the global MCP server pool requires the super admin key';
}

/**
 * Chat-path wrapper: every KV read on the chat path is non-critical, so a KV
 * failure or corrupt value is logged and chat proceeds with no servers.
 */
export async function readMcpServerPoolOrEmpty(
  kv: KVNamespace,
  defaultOrg: string,
  logger: RequestLogger
): Promise<MCPServerConfig[]> {
  try {
    return (await readMcpServerPool(kv, defaultOrg, logger, 'chat')).servers;
  } catch (error) {
    logger.error('mcp_kv_read_error', error, { global_key: MCP_GLOBAL_KEY });
    return [];
  }
}

// ─── Public projection ────────────────────────────────────────────────────────

/**
 * Project a stored config to its public shape. Built from an allowlist, not by
 * deleting `authToken`: the pre-#278 POST persisted `{...body}` verbatim, so a
 * stored object may carry unknown keys that must not reach every org's admins.
 */
export function toPublicServerConfig(server: MCPServerConfig): MCPServerConfigPublic {
  const pub: MCPServerConfigPublic = {
    id: server.id,
    name: server.name,
    url: server.url,
    enabled: server.enabled,
    priority: server.priority,
    hasAuthToken: typeof server.authToken === 'string' && server.authToken.length > 0,
  };
  if (server.allowedTools !== undefined) pub.allowedTools = server.allowedTools;
  if (server.transport !== undefined) pub.transport = server.transport;
  return pub;
}

/** Project a whole pool to its public shape, preserving order. */
export function toPublicServerConfigs(servers: MCPServerConfig[]): MCPServerConfigPublic[] {
  return servers.map(toPublicServerConfig);
}

// ─── Write rule ───────────────────────────────────────────────────────────────

/**
 * Resolve the stored token for one write under the #278 write rule:
 * key omitted → preserve; null or "" → clear; non-empty string → set.
 *
 * Returns `undefined` when no token should be stored so the field is dropped
 * from the persisted JSON rather than written as null or "".
 */
export function resolveAuthToken(
  write: MCPServerWrite,
  existing: MCPServerConfig | undefined
): string | undefined {
  const incoming = 'authToken' in write ? write.authToken : undefined;
  if (incoming === undefined) {
    // Omitted (or an explicit undefined from an in-process caller): preserve,
    // but never re-persist a stored empty string.
    return existing?.authToken ? existing.authToken : undefined;
  }
  if (incoming === null || incoming === '') {
    return undefined;
  }
  return incoming;
}

/**
 * Build the stored config for one write, merging the token against `existing`.
 *
 * Only known MCPServerConfig fields are persisted (allowlist): the pool is
 * shown to every org's admins, so an unknown key such as `password` or the
 * public shape's `hasAuthToken` must not round-trip into KV and back out.
 * Optional fields absent from the write are dropped, matching the previous
 * replace semantics for everything except the token.
 */
export function mergeServerWrite(
  write: MCPServerWrite,
  existing: MCPServerConfig | undefined
): MCPServerConfig {
  const stored: MCPServerConfig = {
    id: write.id,
    name: write.name,
    url: write.url,
    enabled: write.enabled,
    priority: write.priority,
  };
  if (write.allowedTools !== undefined) stored.allowedTools = write.allowedTools;
  if (write.transport !== undefined) stored.transport = write.transport;
  const authToken = resolveAuthToken(write, existing);
  if (authToken !== undefined) stored.authToken = authToken;
  return stored;
}

/**
 * Apply a replace-all write (PUT) to the pool: the result contains exactly the
 * servers in `writes`, in that order, with each entry's token merged by `id`
 * against the current pool. Servers absent from `writes` are dropped.
 * Callers must reject duplicate ids first (findDuplicateServerIds).
 */
export function mergeServerPool(
  writes: MCPServerWrite[],
  existing: MCPServerConfig[]
): MCPServerConfig[] {
  const byId = new Map(existing.map((s) => [s.id, s] as const));
  return writes.map((write) => mergeServerWrite(write, byId.get(write.id)));
}

/**
 * Apply a single-server upsert (POST) to the pool: replaces the entry with the
 * same `id` in place, or appends. Token merged by `id` as above.
 */
export function upsertServer(
  write: MCPServerWrite,
  existing: MCPServerConfig[]
): MCPServerConfig[] {
  const current = existing.find((s) => s.id === write.id);
  const merged = mergeServerWrite(write, current);
  if (current !== undefined) {
    return existing.map((s) => (s.id === write.id ? merged : s));
  }
  return [...existing, merged];
}
