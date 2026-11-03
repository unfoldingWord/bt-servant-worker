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
 *
 * The copy travels as JSON (export response, import request body), so every
 * copied value must survive a JSON round-trip. Today every UserDO value is
 * JSON data: strings, booleans, finite numbers, and plain objects/arrays of
 * those (history, preferences, memory, prompt overrides, mode/language
 * selections, welcome flags — all built from JSON request bodies or
 * primitives). A value that is not (a Date, a Map, binary data, undefined,
 * NaN...) would arrive changed, so the export refuses it instead: the copy
 * fails for that user (`failed`, logged with the key name) and nothing is
 * written.
 */

import type { StoredIdentity } from '../types/engine.js';
import {
  IDENTITY_KEY,
  LOCK_STALE_THRESHOLD_MS,
  PROCESSING_LOCK_KEY,
  QUEUE_PROCESSING_KEY,
  TRANSIENT_USER_DO_KEYS,
} from './user-do-storage-keys.js';

/** Storage keys that belong to one DO instance or one in-flight turn (shared with user-do.ts). */
const NOT_COPIED = TRANSIENT_USER_DO_KEYS;
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

/** Storage reads the transfer needs: a DO's storage or one of its transactions. */
type StorageReader = Pick<DurableObjectTransaction, 'get' | 'list'>;

/**
 * True while a turn may be running or waiting: the processing lock is live
 * (not older than LOCK_STALE_THRESHOLD_MS, exactly as tryAcquireLock judges
 * it) or `queue_processing` is set (anything queued). Reads two small
 * values; the queue itself is never loaded.
 */
export async function turnInFlight(storage: StorageReader, now = Date.now()): Promise<boolean> {
  const flags = await storage.get<unknown>([PROCESSING_LOCK_KEY, QUEUE_PROCESSING_KEY]);
  const lock = flags.get(PROCESSING_LOCK_KEY);
  const lockLive = typeof lock === 'number' && now - lock < LOCK_STALE_THRESHOLD_MS;
  return lockLive || flags.get(QUEUE_PROCESSING_KEY) === true;
}

/**
 * Every copied entry, plus the identity record (for the caller's ownership
 * check), read in one transaction; 'busy' (nothing read) while a turn is in
 * flight or queued.
 */
export async function exportUserData(
  storage: DurableObjectStorage
): Promise<UserDataExport | 'busy'> {
  return storage.transaction(async (txn) => {
    if (await turnInFlight(txn)) return 'busy';
    const entries: [string, unknown][] = [];
    for (const range of copiedRanges()) {
      entries.push(...(await txn.list(range)));
    }
    const normalized: [string, unknown][] = [];
    for (const [key, value] of entries) {
      const safe = toJsonSafe(value);
      if (!safe.ok) {
        throw new Error(`storage value '${key}' does not survive a JSON round-trip; not copied`);
      }
      normalized.push([key, safe.value]);
    }
    const identity = (await txn.get<StoredIdentity>(IDENTITY_KEY)) ?? null;
    return { identity, entries: normalized };
  });
}

/** True when the DO holds any copied kind of data (at most one value read per range). */
async function hasCopiedData(storage: StorageReader): Promise<boolean> {
  for (const range of copiedRanges()) {
    if ((await storage.list({ ...range, limit: 1 })).size > 0) return true;
  }
  return false;
}

/**
 * Write `entries` into an EMPTY, idle destination: the busy check, the
 * emptiness check and the write are one transaction. `destination_busy`
 * while a turn is in flight or queued; `destination_not_empty` when it
 * already holds any copied kind of data — the partner key has been used for
 * this user already, and an import would overwrite that conversation.
 */
export async function importUserData(
  storage: DurableObjectStorage,
  entries: [string, unknown][]
): Promise<UserDataImportResult> {
  const copied = entries.filter(([key]) => !NOT_COPIED.includes(key));
  return storage.transaction(async (txn): Promise<UserDataImportResult> => {
    const refusal = await importRefusal(txn);
    if (refusal) return refusal;
    for (let i = 0; i < copied.length; i += PUT_BATCH) {
      await txn.put(Object.fromEntries(copied.slice(i, i + PUT_BATCH)));
    }
    return { ok: true, imported: copied.length };
  });
}

export type JsonSafe = { ok: true; value: unknown } | { ok: false };
const NOT_JSON_SAFE: JsonSafe = { ok: false };

/**
 * `value` as JSON data that a JSON round-trip returns unchanged, or not ok.
 * Allowed: null, a string, a boolean, a finite number, and arrays / plain
 * objects of those. An object member that is `undefined` is dropped: JSON
 * drops it and structured clone keeps it, so either way it carries nothing.
 * Refused: NaN and ±Infinity, functions, symbols, bigints, any other
 * prototype (Date, Map, Set, ArrayBuffer, ...), and `undefined` as a value
 * or an array element (JSON would turn the element into null).
 */
export function toJsonSafe(value: unknown): JsonSafe {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (typeof value === 'number')
    return Number.isFinite(value) ? { ok: true, value } : NOT_JSON_SAFE;
  if (Array.isArray(value)) return jsonSafeArray(value);
  if (typeof value !== 'object') return NOT_JSON_SAFE;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return NOT_JSON_SAFE;
  return jsonSafeObject(value);
}

function jsonSafeArray(value: unknown[]): JsonSafe {
  const out: unknown[] = [];
  // Array.from turns holes into undefined, which is refused like JSON's null.
  for (const element of Array.from(value)) {
    const safe = toJsonSafe(element);
    if (!safe.ok) return NOT_JSON_SAFE;
    out.push(safe.value);
  }
  return { ok: true, value: out };
}

function jsonSafeObject(value: object): JsonSafe {
  const members: [string, unknown][] = [];
  for (const [name, member] of Object.entries(value)) {
    if (member === undefined) continue;
    const safe = toJsonSafe(member);
    if (!safe.ok) return NOT_JSON_SAFE;
    members.push([name, safe.value]);
  }
  return { ok: true, value: Object.fromEntries(members) };
}

/**
 * The import body's entries, or null when its shape is wrong: it must be
 * `{ entries: [[key, value], ...] }` with a non-empty string key in every
 * pair (the handler answers 400).
 */
export function readImportEntries(body: unknown): [string, unknown][] | null {
  if (typeof body !== 'object' || body === null) return null;
  const entries: unknown = Reflect.get(body, 'entries');
  if (!Array.isArray(entries)) return null;
  const isPair = (pair: unknown): pair is [string, unknown] =>
    Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && pair[0] !== '';
  return entries.every(isPair) ? entries : null;
}

/** Why an import into this DO would be refused right now, or null (the import's own rules). */
async function importRefusal(
  storage: StorageReader
): Promise<Extract<UserDataImportResult, { ok: false }> | null> {
  if (await turnInFlight(storage)) return { ok: false, reason: 'destination_busy' };
  if (await hasCopiedData(storage)) return { ok: false, reason: 'destination_not_empty' };
  return null;
}

/**
 * Read-only preflight for the legacy import: would `importUserData` accept a
 * write now (idle and empty)? Lets the caller skip a user BEFORE copying
 * any audio; the import itself re-checks inside its write transaction.
 */
export async function checkImportable(
  storage: DurableObjectStorage
): Promise<{ ok: true } | Extract<UserDataImportResult, { ok: false }>> {
  return (await importRefusal(storage)) ?? { ok: true };
}
