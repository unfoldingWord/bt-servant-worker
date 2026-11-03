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
 */

import {
  type PartnerKeyCreateInput,
  type PartnerKeyRecord,
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
/** Bound on a rotation-chain walk (guards against a cycle in damaged data). */
const MAX_CHAIN_DEPTH = 50;
/** DO storage `get` / `put` / `delete` accept at most 128 keys per call. */
const GET_BATCH = 128;
/** Warning returned when a change is committed but auth (KV) does not have it yet. */
export const AUTH_UPDATE_PENDING = 'auth_update_pending';

/** A stored key: its record and the SHA-256 of its plaintext (its KV key). */
export type LedgerEntry = { record: PartnerKeyRecord; hash: string };

/** Value of a `proj:` marker: the request that owes the projection. */
type PendingMarker = { requestId: string };

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
};

type RevocationStamp = { revokedAt: string; revokedBy?: string | undefined };

export type RevokeOutcome = {
  record: PartnerKeyRecord;
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
      previous: PartnerKeyRecord;
      record: PartnerKeyRecord;
      plaintext: string;
      /** With grace 0: the rotated key and its in-grace predecessors. Otherwise []. */
      revokedIds: string[];
      warnings: string[];
    };

const recKey = (id: string) => `${REC_PREFIX}${id}`;
const orgKey = (record: PartnerKeyRecord) => `${ORG_PREFIX}${record.org}:${record.id}`;
const pendingKey = (id: string) => `${PENDING_PREFIX}${id}`;

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

  constructor(ctx: LedgerContext) {
    this.storage = ctx.storage;
    this.kv = ctx.kv;
    this.tagSecret = ctx.tagSecret;
    this.logger = ctx.logger;
    this.requestId = ctx.requestId;
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

  async create(
    input: PartnerKeyCreateInput
  ): Promise<{ record: PartnerKeyRecord; plaintext: string; warnings: string[] }> {
    const { entry, plaintext } = await this.issue(input, {});
    await this.commit([entry]);
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
      const owed = await this.owedAmong([entry, ...(await this.predecessorChain(entry.record))]);
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
    await this.commit(changed);
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
   * Alarm: write every still-owed projection to KV; re-arm while any remain.
   * Each key's outcome is logged under the request that owes it
   * (`loggerFor(requestId)`), so a retry correlates with the admin action.
   */
  async retryProjections(
    loggerFor: (requestId: string) => RequestLogger
  ): Promise<{ retried: number; remaining: number }> {
    const owed = await this.listOwed();
    const entries = new Map(
      (await this.getMany(owed.map((o) => o.id))).map((e) => [e.record.id, e] as const)
    );
    const results = await Promise.allSettled(
      owed.map((o) => {
        const entry = entries.get(o.id);
        return entry ? this.putProjection(entry) : Promise.resolve();
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
    await this.deleteMany(owed.filter((o) => !failed.includes(o)).map((o) => pendingKey(o.id)));
    if (failed.length > 0) await this.storage.setAlarm(Date.now() + PROJECTION_RETRY_MS);
    return { retried: owed.length, remaining: failed.length };
  }

  /** True while any projection is owed (the alarm must stay scheduled). */
  async hasOwedProjections(): Promise<boolean> {
    return (await this.storage.list({ prefix: PENDING_PREFIX, limit: 1 })).size > 0;
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
   * Predecessors of `key` still working in their grace window, walking
   * `rotatedFrom` (a link counts only if the predecessor's `rotatedTo` names
   * its successor). Stops at an already-revoked predecessor: its own revoke
   * (or grace-0 rotation) already killed everything behind it.
   */
  private async inGracePredecessors(key: PartnerKeyRecord, now: number): Promise<LedgerEntry[]> {
    const found: LedgerEntry[] = [];
    let successor = key;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH && successor.rotatedFrom; depth++) {
      const entry = await this.get(successor.rotatedFrom);
      if (!entry || entry.record.rotatedTo !== successor.id) break;
      if (entry.record.revokedAt !== undefined) break;
      if (partnerKeyStatus(entry.record, now) === 'active') found.push(entry);
      successor = entry.record;
    }
    return found;
  }

  /** Every linked predecessor of `key` (any status), nearest first. */
  private async predecessorChain(key: PartnerKeyRecord): Promise<LedgerEntry[]> {
    const chain: LedgerEntry[] = [];
    let successor = key;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH && successor.rotatedFrom; depth++) {
      const entry = await this.get(successor.rotatedFrom);
      if (!entry || entry.record.rotatedTo !== successor.id) break;
      chain.push(entry);
      successor = entry.record;
    }
    return chain;
  }

  /** The entries among `entries` whose KV projection is still owed. */
  private async owedAmong(entries: LedgerEntry[]): Promise<LedgerEntry[]> {
    const markers = await this.storage.get(entries.map((e) => pendingKey(e.record.id)));
    return entries.filter((e) => markers.has(pendingKey(e.record.id)));
  }

  /**
   * One atomic commit: every changed record, its org-index entry, a `proj:`
   * marker per key (its KV projection is owed from this instant) and the
   * retry alarm, all in one storage transaction — so no record change can be
   * committed without its owed projection and the alarm that will deliver it.
   * The alarm is only ever moved EARLIER: an alarm already due sooner (a
   * retry owed by an earlier failure) is kept, so steady admin traffic can
   * never keep pushing an owed retry out.
   */
  private async commit(changed: LedgerEntry[]): Promise<void> {
    const marker: PendingMarker = { requestId: this.requestId };
    const entries = changed.flatMap((entry) => [
      [recKey(entry.record.id), entry] as const,
      [orgKey(entry.record), entry.record.id] as const,
      [pendingKey(entry.record.id), marker] as const,
    ]);
    await this.storage.transaction(async (txn) => {
      for (let i = 0; i < entries.length; i += GET_BATCH) {
        await txn.put(Object.fromEntries(entries.slice(i, i + GET_BATCH)));
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
      const failed = await this.putProjections(changed);
      const succeeded = changed.map((e) => e.record.id).filter((id) => !failed.includes(id));
      await this.deleteMany(succeeded.map(pendingKey));
      if (failed.length > 0) return [AUTH_UPDATE_PENDING];
      await this.clearAlarmIfNothingOwed();
      return [];
    } catch (error) {
      this.logger.error('partner_key_projection_bookkeeping_failed', error, {
        key_ids: changed.map((e) => e.record.id),
      });
      return [AUTH_UPDATE_PENDING];
    }
  }

  /** Drop the retry alarm once no projection is owed (avoids a no-op wake-up). */
  private async clearAlarmIfNothingOwed(): Promise<void> {
    if (!(await this.hasOwedProjections())) await this.storage.deleteAlarm();
  }

  /** Put each record at `key:<hash>`; returns the ids whose put failed (logged). */
  private async putProjections(entries: LedgerEntry[]): Promise<string[]> {
    const results = await Promise.allSettled(entries.map((entry) => this.putProjection(entry)));
    const failed: string[] = [];
    for (const [i, result] of results.entries()) {
      const record = entries.at(i)?.record;
      if (result.status === 'rejected' && record) {
        failed.push(record.id);
        this.logger.error('partner_key_projection_failed', result.reason, { key_id: record.id });
      }
    }
    return failed;
  }

  /** The auth projection of one key: its public record at `key:<sha256>`. */
  private putProjection({ record, hash }: LedgerEntry): Promise<void> {
    return this.kv.put(`${PARTNER_KEY_KV_PREFIX}${hash}`, JSON.stringify(record));
  }

  private async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += GET_BATCH) {
      await this.storage.delete(keys.slice(i, i + GET_BATCH));
    }
  }

  private async getMany(ids: string[]): Promise<LedgerEntry[]> {
    const out: LedgerEntry[] = [];
    for (let i = 0; i < ids.length; i += GET_BATCH) {
      const batch = await this.storage.get<LedgerEntry>(ids.slice(i, i + GET_BATCH).map(recKey));
      out.push(...batch.values());
    }
    return out;
  }
}
