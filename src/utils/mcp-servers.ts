/**
 * MCP server pool helpers (admin-portal#278).
 *
 * Pure projection and merge logic shared by the admin routes in src/index.ts:
 * responses never carry the `authToken` secret, and writes merge the token by
 * server `id` so a redacted read → edit → write round-trip preserves it.
 */

import { MCPServerConfig, MCPServerConfigPublic, MCPServerWrite } from '../types/mcp.js';

/** Project a stored config to its public shape: drop authToken, add hasAuthToken. */
export function toPublicServerConfig(server: MCPServerConfig): MCPServerConfigPublic {
  const { authToken, ...rest } = server;
  return { ...rest, hasAuthToken: typeof authToken === 'string' && authToken.length > 0 };
}

/** Project a whole pool to its public shape, preserving order. */
export function toPublicServerConfigs(servers: MCPServerConfig[]): MCPServerConfigPublic[] {
  return servers.map(toPublicServerConfig);
}

/**
 * Resolve the stored token for one write under the #278 write rule:
 * key omitted → preserve; null or "" → clear; non-empty string → set.
 *
 * Returns `undefined` when no token should be stored so the field is dropped
 * from the persisted JSON rather than written as null.
 */
export function resolveAuthToken(
  write: MCPServerWrite,
  existing: MCPServerConfig | undefined
): string | undefined {
  if (!('authToken' in write)) {
    return existing?.authToken;
  }
  const incoming = write.authToken;
  if (incoming === undefined) {
    // `{ authToken: undefined }` is indistinguishable from omitted after JSON
    // parsing; treat an explicit undefined the same way for in-process callers.
    return existing?.authToken;
  }
  if (incoming === null || incoming === '') {
    return undefined;
  }
  return incoming;
}

/** Build the stored config for one write, merging the token against `existing`. */
export function mergeServerWrite(
  write: MCPServerWrite,
  existing: MCPServerConfig | undefined
): MCPServerConfig {
  const { authToken: _ignored, ...rest } = write;
  const authToken = resolveAuthToken(write, existing);
  return authToken === undefined ? { ...rest } : { ...rest, authToken };
}

/**
 * Apply a replace-all write (PUT) to the pool: the result contains exactly the
 * servers in `writes`, in that order, with each entry's token merged by `id`
 * against the current pool. Servers absent from `writes` are dropped.
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
