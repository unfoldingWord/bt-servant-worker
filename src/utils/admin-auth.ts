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

/**
 * The configured admin key, trimmed, or null when it is unset, empty or
 * whitespace-only. The comparison is always against the trimmed secret, so a
 * stray newline in the stored secret cannot break or weaken the match. Admin
 * clients (portal, Baruch) apply the same blank rule and send the trimmed
 * value.
 */
export function configuredAdminKey(keys: AuthKeys): string | null {
  if (typeof keys.ADMIN_API_KEY !== 'string') return null;
  const trimmed = keys.ADMIN_API_KEY.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when a dedicated admin key is configured (non-blank after trimming). */
export function adminKeyConfigured(keys: AuthKeys): boolean {
  return configuredAdminKey(keys) !== null;
}

/** Parsed `ADMIN_KEY_REQUIRED`. `invalid` is any non-blank value other than true/false. */
export type AdminKeyRequiredSetting = 'true' | 'false' | 'invalid';

/**
 * Parse `ADMIN_KEY_REQUIRED`: trimmed and case-insensitive. Unset or blank is
 * `false`. Any other value is `invalid`, which is NOT enforced (the caller
 * logs it).
 */
export function adminKeyRequiredSetting(keys: AuthKeys): AdminKeyRequiredSetting {
  const value = (keys.ADMIN_KEY_REQUIRED ?? '').trim().toLowerCase();
  if (value === 'true') return 'true';
  if (value === '' || value === 'false') return 'false';
  return 'invalid';
}

/**
 * True when the engine key has lost super-admin authority: the flag is
 * `"true"` AND an admin key exists to take its place.
 */
export function adminKeyEnforced(keys: AuthKeys): boolean {
  return adminKeyRequiredSetting(keys) === 'true' && adminKeyConfigured(keys);
}

/**
 * Whether a token matches ENGINE_API_KEY. Both the stored value and its trimmed
 * form are accepted: the trimmed form keeps the "same value classifies as
 * engine" rule true when either secret carries stray whitespace, and the raw
 * form keeps every token that matched before this change matching now.
 */
function matchesEngineKey(token: string, engineKey: string): boolean {
  const raw = constantTimeCompare(token, engineKey);
  const trimmedKey = typeof engineKey === 'string' ? engineKey.trim() : '';
  const trimmed = trimmedKey.length > 0 ? constantTimeCompare(token, trimmedKey) : false;
  return raw || trimmed;
}

/**
 * Classify a bearer token. All comparisons always run (constant-time, no
 * short-circuit on which key matched). If the two keys were ever configured
 * to the same value (after trimming), the token classifies as `engine`, so a
 * misconfiguration can only withhold admin authority, never grant it to
 * engine-key holders.
 */
export function classifyToken(token: string, keys: AuthKeys): KeyClass | null {
  const adminKey = configuredAdminKey(keys);
  const matchesEngine = matchesEngineKey(token, keys.ENGINE_API_KEY);
  const matchesAdmin = adminKey !== null ? constantTimeCompare(token, adminKey) : false;
  if (matchesEngine) return 'engine';
  if (matchesAdmin) return 'admin';
  return null;
}

/** Classify an `Authorization` header (null when it is not a non-empty bearer token). */
export function classifyAuthorization(
  authorizationHeader: string | undefined,
  keys: AuthKeys
): KeyClass | null {
  const token = bearerToken(authorizationHeader);
  if (token === null || token.length === 0) return null;
  return classifyToken(token, keys);
}

/** Whether a key class carries super-admin authority under the current config. */
export function isSuperAdminClass(keyClass: KeyClass | null, keys: AuthKeys): boolean {
  if (keyClass === 'admin') return true;
  if (keyClass === 'engine') return !adminKeyEnforced(keys);
  return false;
}
