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
const NOT_COPIED: ReadonlySet<string> = new Set([
  'identity',
  '_processing_lock',
  'queue',
  'queue_processing',
  'queue_inflight',
]);
/** DO storage `put` accepts at most 128 keys per call. */
const PUT_BATCH = 128;

export type UserDataExport = {
  identity: StoredIdentity | null;
  entries: [string, unknown][];
};

/** Everything a copy carries, plus the identity record (for the caller's ownership check). */
export async function exportUserData(storage: DurableObjectStorage): Promise<UserDataExport> {
  const all = await storage.list();
  const identity = (all.get('identity') as StoredIdentity | undefined) ?? null;
  const entries = [...all].filter(([key]) => !NOT_COPIED.has(key));
  return { identity, entries };
}

/**
 * Write `entries` into an EMPTY destination, atomically. Refuses (returns
 * `destination_not_empty`) when the destination already holds any copied
 * kind of data — the partner key has been used for this user already, and
 * an import would overwrite that conversation.
 */
export async function importUserData(
  storage: DurableObjectStorage,
  entries: [string, unknown][]
): Promise<{ ok: true; imported: number } | { ok: false; reason: 'destination_not_empty' }> {
  const existing = [...(await storage.list()).keys()].filter((key) => !NOT_COPIED.has(key));
  if (existing.length > 0) return { ok: false, reason: 'destination_not_empty' };
  const copied = entries.filter(([key]) => !NOT_COPIED.has(key));
  await storage.transaction(async (txn) => {
    for (let i = 0; i < copied.length; i += PUT_BATCH) {
      await txn.put(Object.fromEntries(copied.slice(i, i + PUT_BATCH)));
    }
  });
  return { ok: true, imported: copied.length };
}
