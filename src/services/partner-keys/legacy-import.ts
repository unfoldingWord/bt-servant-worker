/**
 * Legacy user import (admin-portal#354), super-admin only.
 *
 * A partner app that called with the shared ENGINE_API_KEY used raw user ids,
 * so its users' conversations live in `user:<org>:<user_id>`. With a partner
 * key the same user is `user:<org>:partner:<userNamespace>:<user_id>`. To keep
 * their history when the app switches keys, a super-admin COPIES the named
 * users' DO data from the old name to the new one, once.
 *
 * Why a copy by a super-admin, and not raw-id access for the key: user DOs are
 * named by org + user_id only; client_id plays no part in the name, and the
 * identity record's client_id is just the last caller's. A key allowed to
 * reach raw ids could reach any other client's user in the org (web,
 * WhatsApp, other partners) by guessing ids. The copy keeps the partner key
 * inside its namespace for good; only ENGINE_API_KEY can run it.
 *
 * Guards, per user (each is reported, never silent):
 * - `not_found`: the source DO has no identity record (never used, or last
 *   used before identities were recorded).
 * - `client_mismatch`: its identity is not a private chat of `legacyClientId`
 *   in the key's org — so a wrong id can't pull in someone else's user.
 * - `destination_not_empty`: the partner key has already been used for this
 *   user; the import never overwrites a conversation.
 * - `destination_busy` / `source_busy`: a turn is running or queued in that
 *   DO. The export and the check-and-write each run as one storage
 *   transaction inside that DO, which no turn can interleave with, and are
 *   refused while a turn holds its lock or anything is queued. Retry later.
 * The source is never modified, so a re-run (or a mistake) loses nothing.
 */

import type { Env } from '../../config/types.js';
import {
  readBodyObject,
  type PartnerKeyRecord,
  type PartnerKeyStatus,
} from '../../types/partner-keys.js';
import type {
  UserDataExport,
  UserDataImportResult,
} from '../../durable-objects/user-data-transfer.js';
import type { RequestLogger } from '../../utils/logger.js';
import { PARTNER_CLIENT_ID_PREFIX } from '../../utils/chat-validation.js';
import { isValidPartnerIdentifier, isValidPartnerUserId, scopePartnerSubject } from './policy.js';

export const MAX_LEGACY_IMPORT_USERS = 100;
const MAX_LEGACY_CLIENT_ID_LENGTH = 64;
/** Users copied at once (each copy is two UserDO requests). */
const IMPORT_CONCURRENCY = 5;
const IMPORT_FIELDS: ReadonlySet<string> = new Set(['legacyClientId', 'userIds']);

export type LegacyImportInput = { legacyClientId: string; userIds: string[] };

export type LegacyImportStatus =
  | 'copied'
  | 'not_found'
  | 'client_mismatch'
  | 'destination_not_empty'
  | 'destination_busy'
  | 'source_busy'
  | 'key_revoked'
  | 'key_expired'
  | 'status_check_failed'
  | 'failed';

export type LegacyImportResult = { userId: string; status: LegacyImportStatus; entries?: number };

/**
 * The import only ever reads SHARED-KEY users. A partner key's users live
 * under `partner:<ns>:...` with client_id `partner:<ns>`; accepting either
 * form would let one partner's users be copied into another partner's
 * namespace, so both are refused outright.
 */
const PARTNER_SOURCE_ERROR = `legacyClientId and userIds must not name partner-key users (no '${PARTNER_CLIENT_ID_PREFIX}' prefix or namespace)`;

/** 1-MAX distinct ids, each a valid partner user_id. */
function areImportUserIds(userIds: unknown): userIds is string[] {
  return (
    Array.isArray(userIds) &&
    userIds.length > 0 &&
    userIds.length <= MAX_LEGACY_IMPORT_USERS &&
    userIds.every(isValidPartnerUserId) &&
    new Set(userIds).size === userIds.length
  );
}

/** Validate `{ legacyClientId, userIds }`. Returns the input or an error message. */
export function readLegacyImportBody(
  body: unknown
): { ok: true; input: LegacyImportInput } | { ok: false; error: string } {
  const parsed = readBodyObject(body, IMPORT_FIELDS);
  if (!parsed.ok) return parsed;
  const { legacyClientId, userIds } = parsed.record;
  if (
    !isValidPartnerIdentifier(legacyClientId) ||
    legacyClientId.length > MAX_LEGACY_CLIENT_ID_LENGTH
  ) {
    return {
      ok: false,
      error: `legacyClientId must be a single-line string of 1-${MAX_LEGACY_CLIENT_ID_LENGTH} characters`,
    };
  }
  if (legacyClientId.startsWith(PARTNER_CLIENT_ID_PREFIX)) {
    return { ok: false, error: PARTNER_SOURCE_ERROR };
  }
  if (!areImportUserIds(userIds)) {
    return {
      ok: false,
      error: `userIds must be 1-${MAX_LEGACY_IMPORT_USERS} distinct user ids, each a valid partner user_id`,
    };
  }
  if (userIds.some((id) => id.includes(PARTNER_CLIENT_ID_PREFIX))) {
    return { ok: false, error: PARTNER_SOURCE_ERROR };
  }
  return { ok: true, input: { legacyClientId, userIds } };
}

/** True when the source DO is a private chat of `legacyClientId` in `org`. */
function ownedByLegacyClient(
  identity: UserDataExport['identity'],
  org: string,
  legacyClientId: string
): boolean {
  return (
    identity !== null &&
    identity.client_id === legacyClientId &&
    identity.org === org &&
    identity.chat_type === 'private'
  );
}

/** What one copy needs: the bindings, the key, the request id to forward. */
type ImportContext = {
  env: Env;
  key: PartnerKeyRecord;
  legacyClientId: string;
  requestId: string;
};

function userDoFetch(ctx: ImportContext, name: string, init: RequestInit = {}) {
  const stub = ctx.env.USER_DO.get(ctx.env.USER_DO.idFromName(name));
  const headers = { ...(init.headers as Record<string, string>), 'X-Request-ID': ctx.requestId };
  return stub.fetch('https://user-do/admin/user-data', { ...init, headers });
}

async function copyOneUser(ctx: ImportContext, userId: string): Promise<LegacyImportResult> {
  const { key } = ctx;
  const source = await userDoFetch(ctx, `user:${key.org}:${userId}`);
  if (source.status === 409) return { userId, status: 'source_busy' };
  if (!source.ok) throw new Error(`source export failed with ${source.status}`);
  const exported = (await source.json()) as UserDataExport;
  if (exported.identity === null) return { userId, status: 'not_found' };
  if (!ownedByLegacyClient(exported.identity, key.org, ctx.legacyClientId)) {
    return { userId, status: 'client_mismatch' };
  }
  const dest = await userDoFetch(ctx, `user:${key.org}:${scopePartnerSubject(key, userId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: exported.entries }),
  });
  // Status first: only a 200 or a 409 carries an import result (a storage
  // error answers 500 with an error body, which is not one).
  if (dest.status !== 200 && dest.status !== 409) {
    throw new Error(`destination import failed with ${dest.status}`);
  }
  const result = (await dest.json()) as UserDataImportResult;
  if (result.ok) return { userId, status: 'copied', entries: result.imported };
  return { userId, status: result.reason };
}

/**
 * Copy each named user, IMPORT_CONCURRENCY at a time, results in input order.
 * A failure is logged (with the user id) and reported for that user only.
 */
export async function importLegacyUsers(
  env: Env,
  key: PartnerKeyRecord,
  input: LegacyImportInput,
  opts: {
    logger: RequestLogger;
    requestId: string;
    /** The key's status NOW (re-read before each batch). */
    currentStatus: () => Promise<PartnerKeyStatus>;
  }
): Promise<LegacyImportResult[]> {
  const ctx = { env, key, legacyClientId: input.legacyClientId, requestId: opts.requestId };
  const results: LegacyImportResult[] = [];
  for (let i = 0; i < input.userIds.length; i += IMPORT_CONCURRENCY) {
    // A revoke (or the grace running out) during a long import stops it:
    // the users not yet copied are reported `key_revoked` / `key_expired`.
    // If the status cannot be read, stop too: `status_check_failed`.
    const stopped = await stopReason(key, opts);
    if (stopped) {
      results.push(...input.userIds.slice(i).map((userId) => ({ userId, status: stopped })));
      break;
    }
    const batch = input.userIds.slice(i, i + IMPORT_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((userId) => copyOneUser(ctx, userId)));
    settled.forEach((outcome, j) => {
      const userId = batch.at(j) ?? '';
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
        return;
      }
      opts.logger.error('partner_key_legacy_import_user_failed', outcome.reason, {
        key_id: key.id,
        user_id: userId,
      });
      results.push({ userId, status: 'failed' });
    });
  }
  return results;
}

/**
 * Why the import must stop before the next batch (logged), or null to go on:
 * the key is no longer active, or its status could not be read.
 */
async function stopReason(
  key: PartnerKeyRecord,
  opts: { logger: RequestLogger; currentStatus: () => Promise<PartnerKeyStatus> }
): Promise<LegacyImportStatus | null> {
  let status: PartnerKeyStatus;
  try {
    status = await opts.currentStatus();
  } catch (error) {
    opts.logger.error('partner_key_legacy_import_status_check_failed', error, { key_id: key.id });
    return 'status_check_failed';
  }
  if (status === 'active') return null;
  opts.logger.warn('partner_key_legacy_import_stopped', { key_id: key.id, status });
  return `key_${status}`;
}
