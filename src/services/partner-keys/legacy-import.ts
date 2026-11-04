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
 * - `import_outcome_unknown`: the destination write may or may not have
 *   happened (the request failed, or the answer was not a readable import
 *   result). The user's copied audio is KEPT (it may now be referenced) and
 *   this is logged; a re-run reports `destination_not_empty` if the write
 *   landed, or imports again and reuses that audio if it did not.
 * The source is never modified, so a re-run (or a mistake) loses nothing.
 * Audio this run copied is removed only when the destination DEFINITELY
 * did not take the write: an explicit 409 refusal, or a 400 (the body was
 * refused before any write).
 */

import type { Env } from '../../config/types.js';
import {
  readBodyObject,
  type PartnerKeyRecord,
  type PartnerKeyStatus,
} from '../../types/partner-keys.js';
import type { UserDataExport } from '../../durable-objects/user-data-transfer.js';
import type { RequestLogger } from '../../utils/logger.js';
import {
  isReservedPartnerId,
  PARTNER_PREFIX,
  scopePartnerSubject,
} from '../../types/partner-namespace.js';
import { codePointLength } from '../../types/single-line.js';
import { isValidPartnerIdentifier, isValidPartnerUserId } from './policy.js';
import {
  type AudioCopyCounts,
  R2_OPERATIONS_PER_AUDIO_OBJECT,
  referencedAudioKeys,
  rehomeHistoryAudio,
  removeRehomedAudio,
} from './legacy-audio.js';

export const MAX_LEGACY_IMPORT_USERS = 100;
const MAX_LEGACY_CLIENT_ID_LENGTH = 64;
/** Users copied at once. */
const IMPORT_CONCURRENCY = 5;
/**
 * R2 + Durable Object operations one import request may spend. Cloudflare
 * caps subrequests per Worker invocation (Workers Paid: 10,000 by default;
 * Workers Free: 50 — developers.cloudflare.com/workers/platform/limits, which
 * counts R2 and KV calls; Durable Object calls are counted here as well, to
 * be safe). 800 leaves a wide margin for the rest of the request. Users that
 * do not fit are reported `deferred`; re-running the import continues.
 */
export const LEGACY_IMPORT_OPERATION_BUDGET = 800;
/**
 * Durable Object calls per user: lease renewal, destination preflight, source
 * export, destination import.
 */
const DO_OPERATIONS_PER_USER = 4;
/** Operations a cleanup can take: the R2 delete and the lease renewal before it. */
const CLEANUP_OPERATIONS = 2;
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
  | 'audio_copy_failed'
  | 'import_outcome_unknown'
  | 'deferred'
  | 'failed';

export type LegacyImportResult = {
  userId: string;
  status: LegacyImportStatus;
  entries?: number;
  /** Audio objects the copied history references (see legacy-audio.ts). */
  audio?: AudioCopyCounts;
};

/**
 * The import only ever reads SHARED-KEY users. A partner key's users live
 * under `partner:<ns>:...` with client_id `partner:<ns>`; accepting either
 * form would let one partner's users be copied into another partner's
 * namespace, so both are refused outright.
 */
const PARTNER_SOURCE_ERROR = `legacyClientId and userIds must not name partner-key users (no '${PARTNER_PREFIX}' prefix or namespace)`;

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
    codePointLength(legacyClientId) > MAX_LEGACY_CLIENT_ID_LENGTH
  ) {
    return {
      ok: false,
      error: `legacyClientId must be a single-line string of 1-${MAX_LEGACY_CLIENT_ID_LENGTH} characters`,
    };
  }
  if (isReservedPartnerId(legacyClientId)) {
    return { ok: false, error: PARTNER_SOURCE_ERROR };
  }
  if (!areImportUserIds(userIds)) {
    return {
      ok: false,
      error: `userIds must be 1-${MAX_LEGACY_IMPORT_USERS} distinct user ids, each a valid partner user_id`,
    };
  }
  if (userIds.some((id) => id.includes(PARTNER_PREFIX))) {
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
  logger: RequestLogger;
  budget: OperationBudget;
  lease: ImportLease;
};

/**
 * The run's hold on its import lease (PartnerKeyStoreDO). `hold()` renews it
 * (a DO call) and is called before each user and before any cleanup delete,
 * so a live run never outlives the lease TTL. Once a renewal is refused (or
 * fails), the lease counts as lost for good: the run copies and deletes
 * nothing more, and every user not yet done is `deferred`.
 */
class ImportLease {
  private lost = false;
  constructor(
    private readonly renew: () => Promise<boolean>,
    private readonly logger: RequestLogger,
    private readonly keyId: string
  ) {}

  get isLost(): boolean {
    return this.lost;
  }

  async hold(): Promise<boolean> {
    if (this.lost) return false;
    let renewed = false;
    try {
      renewed = await this.renew();
    } catch (error) {
      this.logger.error('partner_key_legacy_import_lease_renew_failed', error, {
        key_id: this.keyId,
      });
    }
    if (!renewed && !this.lost) {
      this.lost = true;
      this.logger.warn('partner_key_legacy_import_lease_lost', { key_id: this.keyId });
    }
    return renewed;
  }
}

/**
 * The operations left for this request (LEGACY_IMPORT_OPERATION_BUDGET).
 * Once a user does not fit, every user not yet started is deferred too.
 */
class OperationBudget {
  private stopped = false;
  constructor(private remaining: number) {}

  /** Reserve operations for something NEW (a user, a batch); refused once stopped. */
  start(count: number): boolean {
    return !this.stopped && this.take(count);
  }

  /** Reserve more for a user already under way; refused only when it does not fit. */
  take(count: number): boolean {
    if (count > this.remaining) {
      this.stopped = true;
      return false;
    }
    this.remaining -= count;
    return true;
  }
}

function userDoFetch(
  ctx: ImportContext,
  name: string,
  init: RequestInit = {},
  path = '/admin/user-data'
) {
  const stub = ctx.env.USER_DO.get(ctx.env.USER_DO.idFromName(name));
  const headers = { ...(init.headers as Record<string, string>), 'X-Request-ID': ctx.requestId };
  return stub.fetch(`https://user-do${path}`, { ...init, headers });
}

/** The user's partner DO name. */
const destinationOf = (ctx: ImportContext, userId: string) =>
  `user:${ctx.key.org}:${scopePartnerSubject(ctx.key, userId)}`;

/** Read-only: would the destination accept an import now? Null when yes, else the refusal. */
async function destinationRefusal(
  ctx: ImportContext,
  userId: string
): Promise<'destination_not_empty' | 'destination_busy' | null> {
  const res = await userDoFetch(ctx, destinationOf(ctx, userId), {}, '/admin/user-data/importable');
  if (res.status === 200) return null;
  if (res.status !== 409) throw new Error(`destination preflight failed with ${res.status}`);
  return ((await res.json()) as { reason: 'destination_not_empty' | 'destination_busy' }).reason;
}

/** The source user's exported entries, or why it is not copied (busy, not found, someone else's). */
async function exportOwnedSource(
  ctx: ImportContext,
  userId: string
): Promise<
  | { ok: true; entries: [string, unknown][] }
  | { ok: false; status: 'source_busy' | 'not_found' | 'client_mismatch' }
> {
  const source = await userDoFetch(ctx, `user:${ctx.key.org}:${userId}`);
  if (source.status === 409) return { ok: false, status: 'source_busy' };
  if (!source.ok) throw new Error(`source export failed with ${source.status}`);
  const exported = (await source.json()) as UserDataExport;
  if (exported.identity === null) return { ok: false, status: 'not_found' };
  if (!ownedByLegacyClient(exported.identity, ctx.key.org, ctx.legacyClientId)) {
    return { ok: false, status: 'client_mismatch' };
  }
  return { ok: true, entries: exported.entries };
}

/**
 * One user, in this order: budget, destination preflight (read-only), source
 * export and ownership checks, budget for its audio, audio copy, then the
 * import write (which re-checks the destination inside its transaction).
 * Nothing touches R2 until the destination is known to be importable.
 */
async function copyOneUser(ctx: ImportContext, userId: string): Promise<LegacyImportResult> {
  if (!ctx.budget.start(DO_OPERATIONS_PER_USER)) return { userId, status: 'deferred' };
  if (!(await ctx.lease.hold())) return { userId, status: 'deferred' };
  const refused = await destinationRefusal(ctx, userId);
  if (refused) return { userId, status: refused };
  const exported = await exportOwnedSource(ctx, userId);
  if (!exported.ok) return { userId, status: exported.status };
  const audioKeys = referencedAudioKeys(exported.entries).length;
  const audioOperations =
    audioKeys * R2_OPERATIONS_PER_AUDIO_OBJECT + (audioKeys > 0 ? CLEANUP_OPERATIONS : 0);
  if (!ctx.budget.take(audioOperations)) return { userId, status: 'deferred' };
  // Another user of this run may have found the lease lost meanwhile: copy nothing.
  if (ctx.lease.isLost) return { userId, status: 'deferred' };
  return copyWithAudio(ctx, userId, exported.entries);
}

/** Copy the user's audio, then import; on any failure remove only what this run wrote. */
async function copyWithAudio(
  ctx: ImportContext,
  userId: string,
  entries: [string, unknown][]
): Promise<LegacyImportResult> {
  const { key, env, logger } = ctx;
  const target = { org: key.org, namespace: key.userNamespace, subject: userId };
  const audio = await rehomeHistoryAudio(env.AUDIO_BUCKET, entries, target, logger);
  if (!audio.ok) {
    await removeIfLeaseHeld(ctx, userId, audio.written);
    logger.warn('partner_key_legacy_import_audio_copy_failed_user', {
      key_id: key.id,
      user_id: userId,
    });
    return { userId, status: 'audio_copy_failed' };
  }
  const outcome = await importInto(ctx, userId, audio.entries);
  switch (outcome.kind) {
    case 'imported':
      return { userId, status: 'copied', entries: outcome.imported, audio: audio.counts };
    case 'refused':
      await removeIfLeaseHeld(ctx, userId, audio.written);
      return { userId, status: outcome.status };
    case 'unknown':
      logger.error('partner_key_legacy_import_outcome_unknown', outcome.error, {
        key_id: key.id,
        user_id: userId,
        audio_kept: audio.written.length,
      });
      return { userId, status: 'import_outcome_unknown', audio: audio.counts };
  }
}

/**
 * Remove this run's copies, but only while the run still holds its lease:
 * without it, another import may already be reusing them. Kept copies are
 * harmless (a later run reuses them) and are logged.
 */
async function removeIfLeaseHeld(
  ctx: ImportContext,
  userId: string,
  written: string[]
): Promise<void> {
  if (written.length === 0) return;
  if (await ctx.lease.hold()) {
    await removeRehomedAudio(ctx.env.AUDIO_BUCKET, written, ctx.logger);
    return;
  }
  ctx.logger.warn('partner_key_legacy_import_audio_kept_lease_lost', {
    key_id: ctx.key.id,
    user_id: userId,
    count: written.length,
  });
}

/** What the destination write did, as far as the answer shows. */
type ImportOutcome =
  | { kind: 'imported'; imported: number }
  /** Definitely not written. */
  | { kind: 'refused'; status: 'destination_not_empty' | 'destination_busy' | 'failed' }
  /** May or may not have been written. */
  | { kind: 'unknown'; error: unknown };

const REFUSAL_REASONS: ReadonlySet<unknown> = new Set([
  'destination_not_empty',
  'destination_busy',
]);

/** PUT `entries` into the user's partner DO. Never throws: the outcome says what is known. */
async function importInto(
  ctx: ImportContext,
  userId: string,
  entries: [string, unknown][]
): Promise<ImportOutcome> {
  let dest: Response;
  let body: unknown;
  try {
    dest = await userDoFetch(ctx, destinationOf(ctx, userId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    // A 400 is the DO refusing the body before its write transaction starts.
    if (dest.status === 400) {
      ctx.logger.warn('partner_key_legacy_import_body_refused', {
        key_id: ctx.key.id,
        user_id: userId,
      });
      return { kind: 'refused', status: 'failed' };
    }
    body = await dest.json();
  } catch (error) {
    return { kind: 'unknown', error };
  }
  return readImportOutcome(dest.status, body);
}

/** Only a well-formed 200 or 409 import result is definite; anything else is unknown. */
function readImportOutcome(status: number, body: unknown): ImportOutcome {
  type Fields = { ok?: unknown; imported?: unknown; reason?: unknown };
  const result: Fields = typeof body === 'object' && body !== null ? (body as Fields) : {};
  if (status === 200 && result.ok === true && typeof result.imported === 'number') {
    return { kind: 'imported', imported: result.imported };
  }
  if (status === 409 && result.ok === false && REFUSAL_REASONS.has(result.reason)) {
    return {
      kind: 'refused',
      status: result.reason as 'destination_not_empty' | 'destination_busy',
    };
  }
  return { kind: 'unknown', error: new Error(`unexpected import answer (status ${status})`) };
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
    /**
     * Renew the run's import lease; false when another holder owns it now.
     * Called before each user and before any cleanup delete. Default: always
     * held (callers that run without a lease, such as unit tests).
     */
    renewLease?: () => Promise<boolean>;
    /** Override LEGACY_IMPORT_OPERATION_BUDGET (tests). */
    operationBudget?: number;
  }
): Promise<LegacyImportResult[]> {
  const ctx = {
    env,
    key,
    legacyClientId: input.legacyClientId,
    requestId: opts.requestId,
    logger: opts.logger,
    budget: new OperationBudget(opts.operationBudget ?? LEGACY_IMPORT_OPERATION_BUDGET),
    lease: new ImportLease(opts.renewLease ?? (async () => true), opts.logger, key.id),
  };
  const results: LegacyImportResult[] = [];
  for (let i = 0; i < input.userIds.length; i += IMPORT_CONCURRENCY) {
    // A revoke (or the grace running out) during a long import stops it:
    // the users not yet copied are reported `key_revoked` / `key_expired`.
    // If the status cannot be read, stop too: `status_check_failed`.
    // The status read is a Durable Object call too: out of budget → deferred.
    // A lost lease stops the run: nothing more is copied or deleted.
    const stopped = ctx.lease.isLost
      ? 'deferred'
      : ctx.budget.start(1)
        ? await stopReason(key, opts)
        : 'deferred';
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
