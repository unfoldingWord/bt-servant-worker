/**
 * Bearer-key classification for `/api/*` and the admin surfaces.
 *
 * Two deployment-wide keys exist:
 *
 * - `ENGINE_API_KEY` — the key chat clients and integrations use.
 * - `ADMIN_API_KEY` (optional) — a dedicated key for the admin routes.
 *
 * Both pass the global `/api/*` bearer check. Super-admin authority (every
 * `/api/v1/admin/*` route, global MCP pool writes, DO snapshots) belongs to
 * `ADMIN_API_KEY`. During the transition `ENGINE_API_KEY` keeps super-admin
 * authority too, until `ADMIN_KEY_REQUIRED` is `"true"`; from then on it is a
 * chat/user key only and admin surfaces answer 403.
 *
 * Enforcement only takes effect when `ADMIN_API_KEY` is configured: with no
 * admin key set, behaviour is exactly what it was before the split (the engine
 * key is super admin), so the flag can never lock every caller out of admin.
 *
 * Org-scoped admin keys (`ORG_ADMIN_KEYS` KV) are not handled here; the
 * `/api/v1/admin/orgs/:org/*` gate still checks them after this module.
 */
import { constantTimeCompare } from './crypto.js';

/** Which deployment-wide key a bearer token matched. Never the key itself. */
export type KeyClass = 'admin' | 'engine';

/** The env fields this module reads. */
export interface AuthKeys {
  ENGINE_API_KEY: string;
  ADMIN_API_KEY?: string | undefined;
  ADMIN_KEY_REQUIRED?: string | undefined;
}

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  return authorizationHeader.slice(7);
}

/** True when a dedicated admin key is configured (non-empty). */
export function adminKeyConfigured(keys: AuthKeys): boolean {
  return typeof keys.ADMIN_API_KEY === 'string' && keys.ADMIN_API_KEY.length > 0;
}

/**
 * True when the engine key has lost super-admin authority: the flag is
 * `"true"` AND an admin key exists to take its place.
 */
export function adminKeyEnforced(keys: AuthKeys): boolean {
  return keys.ADMIN_KEY_REQUIRED === 'true' && adminKeyConfigured(keys);
}

/**
 * Classify a bearer token. Both comparisons always run (constant-time, no
 * short-circuit on which key matched). If the two keys were ever configured
 * to the same value, the token classifies as `engine`, so a misconfiguration
 * can only withhold admin authority, never grant it to engine-key holders.
 */
export function classifyToken(token: string, keys: AuthKeys): KeyClass | null {
  const matchesEngine = constantTimeCompare(token, keys.ENGINE_API_KEY);
  const matchesAdmin = adminKeyConfigured(keys)
    ? constantTimeCompare(token, keys.ADMIN_API_KEY ?? '')
    : false;
  if (matchesEngine) return 'engine';
  if (matchesAdmin) return 'admin';
  return null;
}

/** Whether a key class carries super-admin authority under the current config. */
export function isSuperAdminClass(keyClass: KeyClass | null, keys: AuthKeys): boolean {
  if (keyClass === 'admin') return true;
  if (keyClass === 'engine') return !adminKeyEnforced(keys);
  return false;
}

/** Convenience: classify the header and decide super-admin authority in one step. */
export function hasSuperAdminAuthority(
  authorizationHeader: string | undefined,
  keys: AuthKeys
): boolean {
  const token = bearerToken(authorizationHeader);
  if (token === null || token.length === 0) return false;
  return isSuperAdminClass(classifyToken(token, keys), keys);
}
