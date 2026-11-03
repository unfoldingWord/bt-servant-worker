/**
 * Copy one user's conversation data between UserDO instances (admin-portal#354).
 *
 * Used ONLY by the super-admin legacy import (services/partner-keys/
 * legacy-import.ts): when a partner app that used to call with the shared key
 * and raw user ids moves to a partner API key, its users' DOs are copied from
 * `user:<org>:<id>` to the namespaced `user:<org>:partner:<ns>:<id>`, so they
 * keep their history. The source is never changed or deleted.
 *
 * What is copied: every storage key EXCEPT the per-instance and transient
 * ones below — so history, preferences, memory, prompt overrides, the
 * selected mode/language and the mode-welcome flags all come along, and a
 * durable key added later is copied without changing this file. The identity
 * record is excluded because it names the DO it lives in (`do_name`); the
 * destination writes its own on its first turn.
 *
 * Both routes are internal to the UserDO (a DO has no public address); the
 * worker reaches them only from the super-admin import route.
 */

import type { StoredIdentity } from '../types/engine.js';

/** Storage keys that belong to one DO instance or one in-flight turn. Keep in sync with user-do.ts. */
const NOT_COPIED = ['_processing_lock', 'identity', 'queue', 'queue_inflight', 'queue_processing'];
/** DO storage `put` accepts at most 128 keys per call. */
const PUT_BATCH = 128;

export type UserDataExport = {
  identity: StoredIdentity | null;
  entries: [string, unknown][];
};

/** The import result a destination UserDO answers with. */
export type UserDataImportResult =
  | { ok: true; imported: number }
  | { ok: false; reason: 'destination_not_empty' | 'destination_busy' };

/**
 * Key ranges covering every key EXCEPT the excluded ones, so their values
 * (the queue can be large) are never loaded. `start` is inclusive and `end`
 * exclusive; `k + '\0'` is the first key after `k`.
 */
function copiedRanges(): { start?: string; end?: string }[] {
  const excluded = [...NOT_COPIED].sort();
  const ranges: { start?: string; end?: string }[] = [];
  let start: string | undefined;
  for (const key of excluded) {
    ranges.push({ ...(start === undefined ? {} : { start }), end: key });
    start = `${key}\0`;
  }
  ranges.push({ ...(start === undefined ? {} : { start }) });
  return ranges;
}

/** Every copied entry, plus the identity record (for the caller's ownership check). */
export async function exportUserData(storage: DurableObjectStorage): Promise<UserDataExport> {
  const entries: [string, unknown][] = [];
  for (const range of copiedRanges()) {
    entries.push(...(await storage.list(range)));
  }
  const identity = (await storage.get<StoredIdentity>('identity')) ?? null;
  return { identity, entries };
}

/** True when the DO holds any copied kind of data (at most one value read per range). */
async function hasCopiedData(storage: DurableObjectStorage): Promise<boolean> {
  for (const range of copiedRanges()) {
    if ((await storage.list({ ...range, limit: 1 })).size > 0) return true;
  }
  return false;
}

/**
 * Write `entries` into an EMPTY destination, atomically. Refuses with
 * `destination_not_empty` when it already holds any copied kind of data —
 * the partner key has been used for this user already, and an import would
 * overwrite that conversation. The caller (UserDO) runs this while holding
 * the turn lock, so no turn can start in between.
 */
export async function importUserData(
  storage: DurableObjectStorage,
  entries: [string, unknown][]
): Promise<UserDataImportResult> {
  if (await hasCopiedData(storage)) return { ok: false, reason: 'destination_not_empty' };
  const copied = entries.filter(([key]) => !NOT_COPIED.includes(key));
  await storage.transaction(async (txn) => {
    for (let i = 0; i < copied.length; i += PUT_BATCH) {
      await txn.put(Object.fromEntries(copied.slice(i, i + PUT_BATCH)));
    }
  });
  return { ok: true, imported: copied.length };
}
