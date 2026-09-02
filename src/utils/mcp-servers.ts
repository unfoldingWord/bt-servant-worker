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
import { RequestLogger } from './logger.js';
import { MCP_GLOBAL_KEY } from './mcp-validation.js';

// ─── Read path ────────────────────────────────────────────────────────────────

/** Where a pool read originates; controls how loudly the fallback is logged. */
export type PoolReadSource = 'admin' | 'chat';

export interface McpServerPool {
  servers: MCPServerConfig[];
  /**
   * True when `__global__` exists in the namespace (even as `[]`). False means
   * the pool was served from the legacy DEFAULT_ORG key, or is empty because
   * neither key exists.
   */
  migrated: boolean;
  /**
   * True when `__global__` is absent but the legacy key holds data — the state
   * in which a write would silently orphan or overwrite that data. Write routes
   * refuse with 409 in this state; the migration runbook on admin-portal#278
   * is the only path that creates `__global__` from legacy data.
   */
  writeBlocked: boolean;
}

/** Once-per-isolate latch so the chat hot path does not warn on every turn. */
let chatFallbackWarned = false;

/** Test seam: reset the once-per-isolate chat warning latch. */
export function resetChatFallbackWarning(): void {
  chatFallbackWarned = false;
}

function assertPoolShape(value: unknown, key: string): MCPServerConfig[] {
  if (!Array.isArray(value)) {
    throw new Error(`MCP_SERVERS key '${key}' is not a JSON array (got ${typeof value})`);
  }
  return value as MCPServerConfig[];
}

/**
 * Read the global MCP server pool.
 *
 * Fallback (transitional, admin-portal#278 migration): when `__global__` is
 * JSON `null` (key absent) the legacy DEFAULT_ORG key is read instead so a
 * staging redeploy on a PR push never blanks the pool. `[]` under `__global__`
 * is a real, empty pool and disables the fallback. Reads never write.
 *
 * Throws when KV fails or a stored value is not an array; admin routes turn
 * that into a 500 and the chat path degrades to an empty pool.
 */
export async function readMcpServerPool(
  kv: KVNamespace,
  defaultOrg: string,
  logger: RequestLogger,
  source: PoolReadSource
): Promise<McpServerPool> {
  const global = await kv.get<unknown>(MCP_GLOBAL_KEY, 'json');
  if (global !== null) {
    return {
      servers: assertPoolShape(global, MCP_GLOBAL_KEY),
      migrated: true,
      writeBlocked: false,
    };
  }

  const legacyRaw = await kv.get<unknown>(defaultOrg, 'json');
  const legacy = legacyRaw === null ? null : assertPoolShape(legacyRaw, defaultOrg);
  const data = {
    global_key: MCP_GLOBAL_KEY,
    fallback_key: defaultOrg,
    fallback_found: legacy !== null,
    server_count: legacy?.length ?? 0,
  };

  if (source === 'admin') {
    // Admin reads are rare: always warn, and list the namespace so any other
    // legacy org key that the runbook must merge is visible (#278 Q#6).
    const listed = await kv.list({ limit: 100 });
    logger.warn('mcp_global_key_missing', {
      ...data,
      legacy_keys: listed.keys.map((k) => k.name),
    });
  } else if (!chatFallbackWarned) {
    chatFallbackWarned = true;
    logger.warn('mcp_global_key_missing', { ...data, once_per_isolate: true });
  } else {
    logger.info('mcp_global_key_missing', data);
  }

  return {
    servers: legacy ?? [],
    migrated: false,
    writeBlocked: legacy !== null && legacy.length > 0,
  };
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

/** Project a stored config to its public shape: drop authToken, add hasAuthToken. */
export function toPublicServerConfig(server: MCPServerConfig): MCPServerConfigPublic {
  const { authToken, ...rest } = server;
  return { ...rest, hasAuthToken: typeof authToken === 'string' && authToken.length > 0 };
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
