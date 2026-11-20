/**
 * Partner key ledger (admin-portal#354): every key-administration operation
 * (create, rotate, revoke, get, list), run by the ONE PartnerKeyStoreDO
 * instance against its own transactional storage. That Durable Object is the
 * single writer and the source of truth; the DO runs these operations one at
 * a time, so each is plain straight-line code: no compare-and-swap, no
 * re-reads to detect a concurrent writer, no compensation.
 *
 * DO storage layout:
 *   rec:<key id>          → { record, hash }   (authoritative)
 *   org:<org>:<key id>    → <key id>           (org index for list ?org=)
 *   proj:<key id>         → { requestId }      (KV projection still owed, and
 *                                                the request that owes it, so
 *                                                alarm retries log under it)
 *   settle:<key id>       → { at, step, requestId } (a KV put for the key timed
 *                                                out at `at` and may still land
 *                                                late; see "Settling" below)
 *   used:<key id>         → <ms since epoch>     (when the key last authenticated,
 *                                                recorded throttled; see
 *                                                last-used.ts. Kept out of the
 *                                                record so recording use never
 *                                                commits, projects or touches auth)
 *
 * Auth projection: chat-time auth must stay one fast KV read, so after each
 * committed change the ledger writes the record to API_KEYS `key:<sha256>` —
 * one put per changed key, never a read-modify-write.
 *
 * The projection is owed from the moment of the commit, never after it: the
 * same atomic commit that changes the records also writes a `proj:` marker
 * for each changed key and sets the alarm. A marker is deleted only after its
 * KV put succeeded. So if the DO dies after the commit, or a put fails (KV
 * error, or KV's one-write-per-second-per-key limit), the alarm still
 * projects the change (retryProjections) — a revocation can never be
 * committed without its KV update recorded as owed. After the commit nothing
 * can turn the operation into an error: projection problems only add
 * `warnings: ['auth_update_pending']`. Auth sees the change within KV's
 * propagation window (~60s, misses cached too), as before.
 *
 * Settling: a KV put that times out (KV_OP_TIMEOUT_MS) is not cancelled — it
 * may still land later and overwrite a newer projection (an "active" record
 * landing after the revocation's put). So a timeout also records a `settle:`
 * obligation for that key. The alarm re-puts the key's CURRENT ledger record
 * SETTLE_DELAYS_MS after the last timeout (~60s, then ~5min) and only then
 * clears it; a later successful projection does not clear it. Residual
 * window: a stale put that lands is visible to auth until the next settle
 * re-put (plus KV propagation), and one that lands more than ~5min after its
 * timeout is not corrected until the key's next change.
 */

import { DO_STORAGE_MAX_KEYS_PER_CALL } from '../../types/do-storage.js';
import {
  type PartnerKeyCreateInput,
  type PartnerKeyRecord,
  type PartnerKeyWithUsage,
  PARTNER_KEY_ID_PATTERN,
  partnerKeyStatus,
} from '../../types/partner-keys.js';
import type { RequestLogger } from '../../utils/logger.js';
import { generatePartnerKeyMaterial, PARTNER_KEY_KV_PREFIX } from './key-material.js';

const REC_PREFIX = 'rec:';
const ORG_PREFIX = 'org:';
const PENDING_PREFIX = 'proj:';
/** Delay before the alarm retries KV projections that failed. */
export const PROJECTION_RETRY_MS = 30_000;
/**
 * Bound on each KV operation. The DO runs one operation at a time (its
 * `serialize` chain), so a KV call that never settles would hold every later
 * admin action and the alarm behind it; a timeout settles it as a projection
 * failure instead (the key stays owed and the alarm retries it).
 */
export const KV_OP_TIMEOUT_MS = 10_000;
/** When the alarm re-puts a key after its last KV timeout (see "Settling"). */
export const SETTLE_DELAYS_MS: readonly number[] = [60_000, 300_000];
const SETTLE_PREFIX = 'settle:';
const USED_PREFIX = 'used:';
/** How many settle re-puts the alarm runs at once. */
const SETTLE_CONCURRENCY = 10;
/** Warning returned when a change is committed but auth (KV) does not have it yet. */
export const AUTH_UPDATE_PENDING = 'auth_update_pending';

/** A stored key: its record and the SHA-256 of its plaintext (its KV key). */
export type LedgerEntry = { record: PartnerKeyRecord; hash: string };

/** Value of a `proj:` marker: the request that owes the projection. */
type PendingMarker = { requestId: string };

/** Value of a `settle:` marker: last KV timeout, re-puts done, owing request. */
type SettleMarker = { at: number; step: number; requestId: string };

/** A KV operation that did not settle within the timeout (it may still land). */
export class KvTimeoutError extends Error {
  override name = 'KvTimeoutError';
}

/** One owed projection, with the request id its retries are logged under. */
type Owed = { id: string; requestId: string };

/** What the ledger needs from the PartnerKeyStoreDO for one operation. */
export type LedgerContext = {
  storage: DurableObjectStorage;
  kv: KVNamespace;
  /** Needed only to issue keys (create, rotate); the alarm retry runs without it. */
  tagSecret: string | undefined;
  logger: RequestLogger;
  /** The request this operation serves; stored on the `proj:` markers it writes. */
  requestId: string;
  /** Per-KV-operation timeout; defaults to KV_OP_TIMEOUT_MS (tests shorten it). */
  kvTimeoutMs?: number;
  /**
   * Keeps work that outlives the operation alive and flushed: the DO passes
   * its `waitUntil` + telemetry flush, so a late-settle log line (written
   * after the response) still reaches the exporter. Optional (tests).
   */
  afterResponse?: (work: Promise<unknown>) => void;
};

type RevocationStamp = { revokedAt: string; revokedBy?: string | undefined };

export type RevokeOutcome = {
  /** The DO joins in `lastUsedAt` before answering (see PartnerKeyStoreDO). */
  record: PartnerKeyWithUsage;
  alreadyRevoked: boolean;
  /** Every key this call revoked: this key first, then in-grace predecessors. */
  revokedIds: string[];
  warnings: string[];
};

export type RotateOutcome =
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'already_rotated'; rotatedTo: string }
  | {
      status: 'ok';
      /** The DO joins in the old key's `lastUsedAt`; `record` (the new key) has none. */
      previous: PartnerKeyWithUsage;
      record: PartnerKeyRecord;
      plaintext: string;
      /** With grace 0: the rotated key and its in-grace predecessors. Otherwise []. */
      revokedIds: string[];
      warnings: string[];
    };

const recKey = (id: string) => `${REC_PREFIX}${id}`;
const orgKey = (record: PartnerKeyRecord) => `${ORG_PREFIX}${record.org}:${record.id}`;
const pendingKey = (id: string) => `${PENDING_PREFIX}${id}`;
const settleKey = (id: string) => `${SETTLE_PREFIX}${id}`;
const usedKey = (id: string) => `${USED_PREFIX}${id}`;

/** When a settle marker's next re-put is due. */
const settleDueAt = (marker: SettleMarker) => marker.at + (SETTLE_DELAYS_MS.at(marker.step) ?? 0);

/** When to wake for a settle marker; an overdue one (a re-put failed) retries after PROJECTION_RETRY_MS. */
function settleWake(marker: SettleMarker, now: number): number {
  const due = settleDueAt(marker);
  return due > now ? due : now + PROJECTION_RETRY_MS;
}

function withRevocation(entry: LedgerEntry, stamp: RevocationStamp): LedgerEntry {
  const record: PartnerKeyRecord = {
    ...entry.record,
    revokedAt: stamp.revokedAt,
    ...(stamp.revokedBy !== undefined ? { revokedBy: stamp.revokedBy } : {}),
  };
  return { record, hash: entry.hash };
}

/**
 * The old key's record after rotation: linked to its replacement and either
 * expiring after the grace window or revoked now (grace 0).
 */
function retiredRecord(
  old: PartnerKeyRecord,
  replacement: PartnerKeyRecord,
  opts: { createdBy?: string | undefined; graceSeconds: number }
): PartnerKeyRecord {
  if (opts.graceSeconds === 0) {
    return {
      ...old,
      rotatedTo: replacement.id,
      revokedAt: replacement.createdAt,
      ...(opts.createdBy !== undefined ? { revokedBy: opts.createdBy } : {}),
    };
  }
  const expires = Date.parse(replacement.createdAt) + opts.graceSeconds * 1000;
  return { ...old, rotatedTo: replacement.id, expiresAt: new Date(expires).toISOString() };
}

/** Why `record` cannot be rotated at `now`, or null when it can. */
function rotationRefusal(record: PartnerKeyRecord, now: number): RotateOutcome | null {
  if (record.rotatedTo !== undefined) {
    return { status: 'already_rotated', rotatedTo: record.rotatedTo };
  }
  return partnerKeyStatus(record, now) === 'active' ? null : { status: 'revoked' };
}

/** The create input a rotation reuses: the old key's labels and terms. */
function replacementInput(old: PartnerKeyRecord, createdBy?: string): PartnerKeyCreateInput {
  return {
    org: old.org,
    name: old.name,
    app: old.app,
    createdBy: createdBy ?? old.createdBy,
    ...(old.termsVersion !== undefined ? { termsVersion: old.termsVersion } : {}),
    ...(old.termsAcceptedAt !== undefined ? { termsAcceptedAt: old.termsAcceptedAt } : {}),
  };
}

export class PartnerKeyLedger {
  private readonly storage: DurableObjectStorage;
  private readonly kv: KVNamespace;
  private readonly tagSecret: string | undefined;
  private readonly logger: RequestLogger;
  private readonly requestId: string;
  private readonly kvTimeoutMs: number;
  private readonly afterResponse: (work: Promise<unknown>) => void;

  constructor(ctx: LedgerContext) {
    this.storage = ctx.storage;
    this.kv = ctx.kv;
    this.tagSecret = ctx.tagSecret;
    this.logger = ctx.logger;
    this.requestId = ctx.requestId;
    this.kvTimeoutMs = ctx.kvTimeoutMs ?? KV_OP_TIMEOUT_MS;
    this.afterResponse = ctx.afterResponse ?? (() => undefined);
  }

  async get(id: string): Promise<LedgerEntry | null> {
    if (!PARTNER_KEY_ID_PATTERN.test(id)) return null;
    return (await this.storage.get<LedgerEntry>(recKey(id))) ?? null;
  }

  /** Every key, or one org's, newest first. Complete: DO storage lists everything. */
  async list(org?: string): Promise<PartnerKeyRecord[]> {
    const entries =
      org === undefined
        ? [...(await this.storage.list<LedgerEntry>({ prefix: REC_PREFIX })).values()]
        : await this.getMany([
            ...(await this.storage.list<string>({ prefix: `${ORG_PREFIX}${org}:` })).values(),
          ]);
    return entries.map((e) => e.record).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Record that key `id` authenticated at `at` (ms). Only ever moves the time
   * forward (a late or out-of-order report is ignored), and an unknown id
   * writes nothing, so no orphan `used:` row can appear. Returns whether a
   * time was stored. Touches no record, no projection and no alarm.
   */
  async recordUse(id: string, at: number): Promise<{ recorded: boolean }> {
    if (!PARTNER_KEY_ID_PATTERN.test(id) || !Number.isFinite(at)) return { recorded: false };
    const [entry, previous] = await Promise.all([
      this.storage.get<LedgerEntry>(recKey(id)),
      this.storage.get<number>(usedKey(id)),
    ]);
    if (!entry || (previous !== undefined && previous >= at)) return { recorded: false };
    await this.storage.put(usedKey(id), at);
    return { recorded: true };
  }

  /**
   * `records` with `lastUsedAt` (ISO-8601) joined in from their `used:` rows;
   * a key with no recorded use gets no field. Batched reads.
   */
  async withLastUsed(records: PartnerKeyRecord[]): Promise<PartnerKeyWithUsage[]> {
    const used = new Map<string, number>();
    for (let i = 0; i < records.length; i += DO_STORAGE_MAX_KEYS_PER_CALL) {
      const keys = records.slice(i, i + DO_STORAGE_MAX_KEYS_PER_CALL).map((r) => usedKey(r.id));
      for (const [key, at] of await this.storage.get<number>(keys)) used.set(key, at);
    }
    return records.map((record) => {
      const at = used.get(usedKey(record.id));
      return at === undefined ? record : { ...record, lastUsedAt: new Date(at).toISOString() };
    });
  }

  async create(
    input: PartnerKeyCreateInput
  ): Promise<{ record: PartnerKeyRecord; plaintext: string; warnings: string[] }> {
    const { entry, plaintext } = await this.issue(input, {});
    await this.commit([entry], [entry]);
    return { record: entry.record, plaintext, warnings: await this.project([entry]) };
  }

  /**
   * Revoke by id, and every predecessor still working in its rotation grace
   * window, so revoking the current key really cuts the partner off.
   * Idempotent: an already-revoked key is returned with `alreadyRevoked: true`
   * and nothing new is committed (its chain was killed when it was revoked).
   * Any KV projection still owed for the key OR its predecessors (the chain
   * that revocation killed) is re-attempted, so the caller learns whether
   * auth has the whole revocation yet.
   */
  async revoke(id: string, revokedBy?: string): Promise<RevokeOutcome | null> {
    const entry = await this.get(id);
    if (!entry) return null;
    if (entry.record.revokedAt !== undefined) {
      const chain = await this.walkPredecessors(entry.record, () => 'take');
      const owed = await this.owedAmong([entry, ...chain]);
      const warnings = owed.length > 0 ? await this.project(owed) : [];
      return { record: entry.record, alreadyRevoked: true, revokedIds: [], warnings };
    }
    const now = Date.now();
    const stamp = { revokedAt: new Date(now).toISOString(), revokedBy };
    const predecessors = await this.inGracePredecessors(entry.record, now);
    const changed = [entry, ...predecessors].map((e) => withRevocation(e, stamp));
    await this.commit(changed);
    const revokedIds = changed.map((e) => e.record.id);
    const [self] = changed as [LedgerEntry, ...LedgerEntry[]];
    const warnings = await this.project(changed);
    return { record: self.record, alreadyRevoked: false, revokedIds, warnings };
  }

  /**
   * Rotate: issue a replacement with the same labels and user namespace, and
   * retire the old key — expiring after `graceSeconds`, or revoked now when
   * it is 0 (together with its in-grace predecessors). A key already rotated,
   * revoked or expired is refused. One atomic storage write for all of it.
   */
  async rotate(
    id: string,
    opts: { createdBy?: string | undefined; graceSeconds: number }
  ): Promise<RotateOutcome> {
    const entry = await this.get(id);
    if (!entry) return { status: 'not_found' };
    const now = Date.now();
    const refusal = rotationRefusal(entry.record, now);
    if (refusal) return refusal;

    const carry = { userNamespace: entry.record.userNamespace, rotatedFrom: id };
    const issued = await this.issue(replacementInput(entry.record, opts.createdBy), carry);
    const previous = {
      record: retiredRecord(entry.record, issued.entry.record, opts),
      hash: entry.hash,
    };
    const chain =
      opts.graceSeconds === 0
        ? (await this.inGracePredecessors(entry.record, now)).map((e) =>
            withRevocation(e, {
              revokedAt: issued.entry.record.createdAt,
              revokedBy: opts.createdBy,
            })
          )
        : [];
    const changed = [issued.entry, previous, ...chain];
    await this.commit(changed, [issued.entry]);
    const revokedIds = opts.graceSeconds === 0 ? [id, ...chain.map((e) => e.record.id)] : [];
    return {
      status: 'ok',
      previous: previous.record,
      record: issued.entry.record,
      plaintext: issued.plaintext,
      revokedIds,
      warnings: await this.project(changed),
    };
  }

  /**
   * Alarm: write every still-owed projection to KV, then run the settle
   * re-puts that are due; re-arm for whatever remains. Each key's outcome is
   * logged under the request that owes it (`loggerFor(requestId)`), so a
   * retry correlates with the admin action. `now` is injectable for tests.
   */
  async retryProjections(
    loggerFor: (requestId: string) => RequestLogger,
    now = Date.now()
  ): Promise<{ retried: number; remaining: number }> {
    const owed = await this.listOwed();
    const entries = new Map(
      (await this.getMany(owed.map((o) => o.id))).map((e) => [e.record.id, e] as const)
    );
    const results = await Promise.allSettled(
      owed.map((o) => {
        const entry = entries.get(o.id);
        return entry ? this.putProjection(entry, o.requestId) : Promise.resolve();
      })
    );
    const failed = owed.filter((o, i) => {
      const result = results.at(i);
      const logger = loggerFor(o.requestId);
      if (result?.status === 'rejected') {
        logger.error('partner_key_projection_retry_failed', result.reason, { key_id: o.id });
        return true;
      }
      logger.log('partner_key_projection_retried', { key_id: o.id, found: entries.has(o.id) });
      return false;
    });
    // A settle created here keeps the owing `proj:` marker's request id.
    await this.recordSettles(
      owed.filter((_o, i) => isTimeout(results.at(i))),
      now
    );
    const failedSet = new Set(failed);
    await this.deleteMany(owed.filter((o) => !failedSet.has(o)).map((o) => pendingKey(o.id)));
    await this.runDueSettles(loggerFor, now);
    await this.armAlarm(now);
    return { retried: owed.length, remaining: failed.length };
  }

  /**
   * Re-put the CURRENT record of every key whose settle re-put is due,
   * SETTLE_CONCURRENCY at a time. A success advances the marker (cleared
   * after the last delay); a timeout restarts it; any other failure leaves
   * it for the next alarm.
   */
  private async runDueSettles(
    loggerFor: (requestId: string) => RequestLogger,
    now: number
  ): Promise<void> {
    const due = [...(await this.listSettles())].filter(([, m]) => settleDueAt(m) <= now);
    for (let i = 0; i < due.length; i += SETTLE_CONCURRENCY) {
      const batch = due.slice(i, i + SETTLE_CONCURRENCY);
      await Promise.allSettled(
        batch.map(([id, marker]) => this.settleOne(id, marker, loggerFor(marker.requestId), now))
      );
    }
  }

  /** One settle re-put; never throws (its outcome is logged and recorded). */
  private async settleOne(
    id: string,
    marker: SettleMarker,
    logger: RequestLogger,
    now: number
  ): Promise<void> {
    try {
      const entry = await this.get(id);
      if (entry) await this.putProjection(entry, marker.requestId);
      const step = marker.step + 1;
      if (step < SETTLE_DELAYS_MS.length) {
        await this.storage.put(settleKey(id), { ...marker, step });
      } else {
        await this.storage.delete(settleKey(id));
      }
      logger.log('partner_key_projection_settled', { key_id: id, step });
    } catch (error) {
      logger.error('partner_key_projection_settle_failed', error, { key_id: id });
      if (error instanceof KvTimeoutError) {
        await this.recordSettles([{ id, requestId: marker.requestId }], now);
      }
    }
  }

  /**
   * Record (or restart) the settle obligation of each key whose KV put timed
   * out, under the request that owes it.
   */
  private async recordSettles(owed: Owed[], now: number): Promise<void> {
    const fresh = owed.map(
      ({ id, requestId }) =>
        [settleKey(id), { at: now, step: 0, requestId } satisfies SettleMarker] as const
    );
    for (let i = 0; i < fresh.length; i += DO_STORAGE_MAX_KEYS_PER_CALL) {
      await this.storage.put(Object.fromEntries(fresh.slice(i, i + DO_STORAGE_MAX_KEYS_PER_CALL)));
    }
  }

  /** Every settle marker, by key id. */
  private async listSettles(): Promise<Map<string, SettleMarker>> {
    const markers = await this.storage.list<SettleMarker>({ prefix: SETTLE_PREFIX });
    return new Map([...markers].map(([key, m]) => [key.slice(SETTLE_PREFIX.length), m]));
  }

  /**
   * Schedule the alarm for the earliest owed work: a retry
   * (PROJECTION_RETRY_MS) while any `proj:` marker remains, and each settle
   * re-put's due time. Only ever moves an existing alarm EARLIER; with nothing
   * owed at all, the alarm is dropped. Returns whether anything is owed (the
   * one place that question is answered; the DO's failed-alarm path calls
   * this too).
   */
  async armAlarm(now = Date.now()): Promise<boolean> {
    const dues = [...(await this.listSettles()).values()].map((m) => settleWake(m, now));
    const owed = await this.storage.list({ prefix: PENDING_PREFIX, limit: 1 });
    if (owed.size > 0) dues.push(now + PROJECTION_RETRY_MS);
    if (dues.length === 0) {
      await this.storage.deleteAlarm();
      return false;
    }
    const due = Math.min(...dues);
    const existing = await this.storage.getAlarm();
    if (existing === null || existing > due) await this.storage.setAlarm(due);
    return true;
  }

  /** Every `proj:` marker, with the request id to log its retry under. */
  private async listOwed(): Promise<Owed[]> {
    const markers = await this.storage.list<PendingMarker>({ prefix: PENDING_PREFIX });
    return [...markers].map(([key, marker]) => ({
      id: key.slice(PENDING_PREFIX.length),
      requestId: marker.requestId,
    }));
  }

  /** New key material and record. `carry` links a rotation's replacement. */
  private async issue(
    input: PartnerKeyCreateInput,
    carry: { userNamespace?: string; rotatedFrom?: string }
  ): Promise<{ entry: LedgerEntry; plaintext: string }> {
    if (!this.tagSecret) throw new Error('PARTNER_KEY_TAG_SECRET is not configured');
    const { id, prefix, plaintext, hash } = await generatePartnerKeyMaterial(this.tagSecret);
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
    return { entry: { record, hash }, plaintext };
  }

  /**
   * Walk `key`'s predecessors along `rotatedFrom`, nearest first (a link
   * counts only if the predecessor's `rotatedTo` names its successor).
   * `visit` decides per predecessor: 'take' it, 'skip' it and keep walking,
   * or 'stop'. The walk is complete — no depth cap, because revocation must
   * reach every predecessor still in grace however long the chain is. Only a
   * cycle (damaged data: a valid chain cannot revisit a key) ends it early,
   * and that is logged.
   */
  private async walkPredecessors(
    key: PartnerKeyRecord,
    visit: (entry: LedgerEntry) => 'take' | 'skip' | 'stop'
  ): Promise<LedgerEntry[]> {
    const taken: LedgerEntry[] = [];
    const seen = new Set<string>([key.id]);
    let successor = key;
    while (successor.rotatedFrom) {
      if (seen.has(successor.rotatedFrom)) {
        this.logger.error('partner_key_chain_cycle', new Error('rotation chain revisits a key'), {
          key_id: key.id,
          revisited_id: successor.rotatedFrom,
          request_id: this.requestId,
        });
        break;
      }
      seen.add(successor.rotatedFrom);
      const entry = await this.get(successor.rotatedFrom);
      if (!entry || entry.record.rotatedTo !== successor.id) break;
      const verdict = visit(entry);
      if (verdict === 'stop') break;
      if (verdict === 'take') taken.push(entry);
      successor = entry.record;
    }
    return taken;
  }

  /**
   * Predecessors still working in their grace window. Stops at an
   * already-revoked one: its own revoke (or grace-0 rotation) already killed
   * everything behind it.
   */
  private inGracePredecessors(key: PartnerKeyRecord, now: number): Promise<LedgerEntry[]> {
    return this.walkPredecessors(key, ({ record }) => {
      if (record.revokedAt !== undefined) return 'stop';
      return partnerKeyStatus(record, now) === 'active' ? 'take' : 'skip';
    });
  }

  /** The entries among `entries` whose KV projection is still owed. */
  private async owedAmong(entries: LedgerEntry[]): Promise<LedgerEntry[]> {
    // Read just these entries' `proj:` markers (a batched get, at most
    // DO_STORAGE_MAX_KEYS_PER_CALL keys per call), not every marker in storage.
    const owed = new Set<string>();
    for (let i = 0; i < entries.length; i += DO_STORAGE_MAX_KEYS_PER_CALL) {
      const keys = entries
        .slice(i, i + DO_STORAGE_MAX_KEYS_PER_CALL)
        .map((e) => pendingKey(e.record.id));
      for (const key of (await this.storage.get(keys)).keys()) owed.add(key);
    }
    return entries.filter((e) => owed.has(pendingKey(e.record.id)));
  }

  /**
   * One atomic commit: every changed record, the org-index row of each newly issued key, a `proj:`
   * marker per key (its KV projection is owed from this instant) and the
   * retry alarm, all in one storage transaction — so no record change can be
   * committed without its owed projection and the alarm that will deliver it.
   * The alarm is only ever moved EARLIER: an alarm already due sooner (a
   * retry owed by an earlier failure) is kept, so steady admin traffic can
   * never keep pushing an owed retry out.
   */
  private async commit(changed: LedgerEntry[], issued: LedgerEntry[] = []): Promise<void> {
    const marker: PendingMarker = { requestId: this.requestId };
    const entries = [
      ...changed.flatMap((entry) => [
        [recKey(entry.record.id), entry] as const,
        [pendingKey(entry.record.id), marker] as const,
      ]),
      // A key's org never changes, so its index row is written once, at issue.
      ...issued.map((entry) => [orgKey(entry.record), entry.record.id] as const),
    ];
    await this.storage.transaction(async (txn) => {
      for (let i = 0; i < entries.length; i += DO_STORAGE_MAX_KEYS_PER_CALL) {
        await txn.put(Object.fromEntries(entries.slice(i, i + DO_STORAGE_MAX_KEYS_PER_CALL)));
      }
      const due = Date.now() + PROJECTION_RETRY_MS;
      const existing = await txn.getAlarm();
      if (existing === null || existing > due) await txn.setAlarm(due);
    });
  }

  /**
   * After the commit: put each changed record to KV and settle its marker.
   * NEVER throws — the change is committed and, for create/rotate, the
   * plaintext must still reach the caller. Anything that goes wrong here
   * leaves the markers in place for the alarm and returns the warning.
   */
  private async project(changed: LedgerEntry[]): Promise<string[]> {
    try {
      const { failed, timedOut } = await this.putProjections(changed);
      const now = Date.now();
      await this.recordSettles(
        timedOut.map((id) => ({ id, requestId: this.requestId })),
        now
      );
      const failedSet = new Set(failed);
      const succeeded = changed.map((e) => e.record.id).filter((id) => !failedSet.has(id));
      await this.deleteMany(succeeded.map(pendingKey));
      await this.armAlarm(now);
      return failed.length > 0 ? [AUTH_UPDATE_PENDING] : [];
    } catch (error) {
      this.logger.error('partner_key_projection_bookkeeping_failed', error, {
        key_ids: changed.map((e) => e.record.id),
      });
      return [AUTH_UPDATE_PENDING];
    }
  }

  /**
   * Put each record at `key:<hash>`; returns the ids whose put failed
   * (logged), and among them those that timed out (they may still land).
   */
  private async putProjections(
    entries: LedgerEntry[]
  ): Promise<{ failed: string[]; timedOut: string[] }> {
    const results = await Promise.allSettled(
      entries.map((entry) => this.putProjection(entry, this.requestId))
    );
    const failed: string[] = [];
    const timedOut: string[] = [];
    for (const [i, result] of results.entries()) {
      const record = entries.at(i)?.record;
      if (result.status === 'rejected' && record) {
        failed.push(record.id);
        if (isTimeout(result)) timedOut.push(record.id);
        this.logger.error('partner_key_projection_failed', result.reason, { key_id: record.id });
      }
    }
    return { failed, timedOut };
  }

  /**
   * The auth projection of one key: its public record at `key:<sha256>`.
   * Rejects after `kvTimeoutMs` if KV has not answered (a projection failure).
   * A put that timed out is still watched: when it finally settles or
   * rejects, that is logged (`partner_key_projection_late_settle`) under the
   * owing request id, so a late overwrite can be traced.
   */
  private putProjection({ record, hash }: LedgerEntry, requestId: string): Promise<void> {
    const put = this.kv.put(`${PARTNER_KEY_KV_PREFIX}${hash}`, JSON.stringify(record));
    const fields = { key_id: record.id, request_id: requestId };
    const onLate = (error?: unknown) => {
      if (error === undefined) {
        this.logger.warn('partner_key_projection_late_settle', { ...fields, outcome: 'stored' });
      } else {
        this.logger.error('partner_key_projection_late_settle', error, {
          ...fields,
          outcome: 'rejected',
        });
      }
    };
    return withTimeout(put, this.kvTimeoutMs, 'KV put', (late) =>
      this.afterResponse(late.then(onLate, onLate))
    );
  }

  private async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DO_STORAGE_MAX_KEYS_PER_CALL) {
      await this.storage.delete(keys.slice(i, i + DO_STORAGE_MAX_KEYS_PER_CALL));
    }
  }

  private async getMany(ids: string[]): Promise<LedgerEntry[]> {
    const out: LedgerEntry[] = [];
    for (let i = 0; i < ids.length; i += DO_STORAGE_MAX_KEYS_PER_CALL) {
      const batch = await this.storage.get<LedgerEntry>(
        ids.slice(i, i + DO_STORAGE_MAX_KEYS_PER_CALL).map(recKey)
      );
      out.push(...batch.values());
    }
    return out;
  }
}

/** True for a rejection caused by a KV timeout. */
function isTimeout(result: PromiseSettledResult<unknown> | undefined): boolean {
  return result?.status === 'rejected' && result.reason instanceof KvTimeoutError;
}

/**
 * `op`, or a KvTimeoutError once `ms` pass without it settling (the timer is
 * always cleared). On a timeout `onTimeout` receives `op` itself — still
 * running — so the caller can watch it settle late.
 */
function withTimeout<T>(
  op: Promise<T>,
  ms: number,
  what: string,
  onTimeout: (late: Promise<T>) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout(op);
      reject(new KvTimeoutError(`${what} timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([op, timeout]).finally(() => clearTimeout(timer));
}
