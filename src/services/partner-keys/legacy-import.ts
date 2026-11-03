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
 * The source is never modified, so a re-run (or a mistake) loses nothing.
 */

import type { Env } from '../../config/types.js';
import type { PartnerKeyRecord } from '../../types/partner-keys.js';
import type { UserDataExport } from '../../durable-objects/user-data-transfer.js';
import type { RequestLogger } from '../../utils/logger.js';
import { isValidPartnerIdentifier, scopePartnerSubject } from './policy.js';

export const MAX_LEGACY_IMPORT_USERS = 100;
const MAX_LEGACY_CLIENT_ID_LENGTH = 64;

export type LegacyImportInput = { legacyClientId: string; userIds: string[] };

export type LegacyImportStatus =
  'copied' | 'not_found' | 'client_mismatch' | 'destination_not_empty' | 'failed';

export type LegacyImportResult = { userId: string; status: LegacyImportStatus; entries?: number };

/** 1-MAX distinct ids, each a valid partner user_id. */
function areImportUserIds(userIds: unknown): userIds is string[] {
  return (
    Array.isArray(userIds) &&
    userIds.length > 0 &&
    userIds.length <= MAX_LEGACY_IMPORT_USERS &&
    userIds.every(isValidPartnerIdentifier) &&
    new Set(userIds).size === userIds.length
  );
}

/** Validate `{ legacyClientId, userIds }`. Returns the input or an error message. */
export function readLegacyImportBody(
  body: unknown
): { ok: true; input: LegacyImportInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const { legacyClientId, userIds, ...unknown } = body as Record<string, unknown>;
  if (Object.keys(unknown).length > 0) {
    return { ok: false, error: `Unknown field(s): ${Object.keys(unknown).join(', ')}` };
  }
  if (
    !isValidPartnerIdentifier(legacyClientId) ||
    legacyClientId.length > MAX_LEGACY_CLIENT_ID_LENGTH
  ) {
    return {
      ok: false,
      error: `legacyClientId must be a single-line string of 1-${MAX_LEGACY_CLIENT_ID_LENGTH} characters`,
    };
  }
  const idsOk = areImportUserIds(userIds);
  if (!idsOk) {
    return {
      ok: false,
      error: `userIds must be 1-${MAX_LEGACY_IMPORT_USERS} distinct user ids, each a valid partner user_id`,
    };
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

function userDo(env: Env, name: string): DurableObjectStub {
  return env.USER_DO.get(env.USER_DO.idFromName(name));
}

async function copyOneUser(
  env: Env,
  key: PartnerKeyRecord,
  legacyClientId: string,
  userId: string
): Promise<LegacyImportResult> {
  const source = await userDo(env, `user:${key.org}:${userId}`).fetch(
    'https://user-do/admin/user-data'
  );
  if (!source.ok) throw new Error(`source export failed with ${source.status}`);
  const exported = (await source.json()) as UserDataExport;
  if (exported.identity === null) return { userId, status: 'not_found' };
  if (!ownedByLegacyClient(exported.identity, key.org, legacyClientId)) {
    return { userId, status: 'client_mismatch' };
  }
  const destName = `user:${key.org}:${scopePartnerSubject(key, userId)}`;
  const dest = await userDo(env, destName).fetch('https://user-do/admin/user-data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: exported.entries }),
  });
  if (dest.status === 409) return { userId, status: 'destination_not_empty' };
  if (!dest.ok) throw new Error(`destination import failed with ${dest.status}`);
  const { imported } = (await dest.json()) as { imported: number };
  return { userId, status: 'copied', entries: imported };
}

/** Copy each named user, one at a time. A failure is logged and reported for that user only. */
export async function importLegacyUsers(
  env: Env,
  key: PartnerKeyRecord,
  input: LegacyImportInput,
  logger: RequestLogger
): Promise<LegacyImportResult[]> {
  const results: LegacyImportResult[] = [];
  for (const userId of input.userIds) {
    try {
      results.push(await copyOneUser(env, key, input.legacyClientId, userId));
    } catch (error) {
      logger.error('partner_key_legacy_import_user_failed', error, { key_id: key.id });
      results.push({ userId, status: 'failed' });
    }
  }
  return results;
}
