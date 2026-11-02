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
 *   proj:<key id>         → true               (KV projection still owed)
 *
 * Auth projection: chat-time auth must stay one fast KV read, so after each
 * committed change the ledger writes the record to API_KEYS `key:<sha256>` —
 * one put per changed key, never a read-modify-write. If a put fails (KV
 * error, or KV's one-write-per-second-per-key limit), the key is marked
 * `proj:` and the DO alarm retries (retryProjections) until KV has it. The DO
 * state stays authoritative meanwhile; the response says so in `warnings`
 * (`auth_update_pending`). Auth then sees the change within KV's propagation
 * window (~60s, misses cached too), as before.
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
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly kv: KVNamespace,
    /** Needed only to issue keys (create, rotate); the alarm retry runs without it. */
    private readonly tagSecret: string | undefined,
    private readonly logger: RequestLogger
  ) {}

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
   * and nothing is written (its chain was killed when it was revoked).
   */
  async revoke(id: string, revokedBy?: string): Promise<RevokeOutcome | null> {
    const entry = await this.get(id);
    if (!entry) return null;
    if (entry.record.revokedAt !== undefined) {
      return { record: entry.record, alreadyRevoked: true, revokedIds: [], warnings: [] };
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

  /** Alarm: write every still-owed projection to KV; re-arm while any remain. */
  async retryProjections(): Promise<{ retried: number; remaining: number }> {
    const ids = [...(await this.storage.list({ prefix: PENDING_PREFIX })).keys()].map((k) =>
      k.slice(PENDING_PREFIX.length)
    );
    const entries = await this.getMany(ids);
    const failed = await this.putProjections(entries);
    const done = ids.filter((id) => !failed.includes(id));
    await this.deleteMany(done.map(pendingKey));
    if (failed.length > 0) await this.storage.setAlarm(Date.now() + PROJECTION_RETRY_MS);
    this.logger.log('partner_key_projection_retried', {
      retried: ids.length,
      remaining: failed.length,
    });
    return { retried: ids.length, remaining: failed.length };
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

  /** One atomic write of every changed record and its org-index entry. */
  private async commit(changed: LedgerEntry[]): Promise<void> {
    const entries: Record<string, unknown> = {};
    for (const entry of changed) {
      entries[recKey(entry.record.id)] = entry;
      entries[orgKey(entry.record)] = entry.record.id;
    }
    await this.storage.put(entries);
  }

  /**
   * Project changed records to KV for auth. Failures are owed (`proj:`) and
   * retried by the alarm; returns the warnings for the response.
   */
  private async project(changed: LedgerEntry[]): Promise<string[]> {
    const failed = await this.putProjections(changed);
    const succeeded = changed.map((e) => e.record.id).filter((id) => !failed.includes(id));
    // A key owed from an earlier failure is settled by this newer write.
    await this.deleteMany(succeeded.map(pendingKey));
    if (failed.length === 0) return [];
    await this.storage.put(Object.fromEntries(failed.map((id) => [pendingKey(id), true])));
    if ((await this.storage.getAlarm()) === null) {
      await this.storage.setAlarm(Date.now() + PROJECTION_RETRY_MS);
    }
    return [AUTH_UPDATE_PENDING];
  }

  /** Put each record at `key:<hash>`; returns the ids whose put failed (logged). */
  private async putProjections(entries: LedgerEntry[]): Promise<string[]> {
    const failed: string[] = [];
    for (const { record, hash } of entries) {
      try {
        await this.kv.put(`${PARTNER_KEY_KV_PREFIX}${hash}`, JSON.stringify(record));
      } catch (error) {
        failed.push(record.id);
        this.logger.error('partner_key_projection_failed', error, { key_id: record.id });
      }
    }
    return failed;
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
