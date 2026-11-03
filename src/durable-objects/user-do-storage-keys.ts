/**
 * UserDO storage keys that belong to ONE DO instance or ONE in-flight turn,
 * shared by user-do.ts (which uses them) and user-data-transfer.ts (which
 * must never copy them between DOs, admin-portal#354).
 */

/**
 * The conversation history (an array of ChatHistoryEntry). Copied by the
 * legacy import, which also rehomes the audio it references (legacy-audio.ts).
 */
export const HISTORY_KEY = 'history';
/** The DO's own identity record; its `do_name` names THIS DO. */
export const IDENTITY_KEY = 'identity';
/** Held while a turn runs (see tryAcquireLock / LOCK_STALE_THRESHOLD_MS). */
export const PROCESSING_LOCK_KEY = '_processing_lock';
/** A lock (or in-flight reservation) older than this is from a dead turn. */
export const LOCK_STALE_THRESHOLD_MS = 90_000; // 90 seconds
/** Queued turns waiting for the lock. */
export const QUEUE_KEY = 'queue';
/**
 * True from the moment an entry is enqueued until the alarm finds the queue
 * empty, so `true` covers every non-empty queue (read without loading it).
 */
export const QUEUE_PROCESSING_KEY = 'queue_processing';
/**
 * Reservation for the entry currently being processed off the queue. The
 * queue is one storage value with a byte budget (`MAX_QUEUE_BYTES`); a
 * dequeued entry leaves that value but may come BACK via `reEnqueue` on a
 * transient failure, so its bytes stay counted against the budget until the
 * turn ends. Expires like the processing lock (`LOCK_STALE_THRESHOLD_MS`) so
 * an eviction mid-turn can never shrink the budget for good.
 */
export const QUEUE_INFLIGHT_KEY = 'queue_inflight';

/** Every per-instance / transient key: never copied to another DO. */
export const TRANSIENT_USER_DO_KEYS: readonly string[] = [
  IDENTITY_KEY,
  PROCESSING_LOCK_KEY,
  QUEUE_KEY,
  QUEUE_PROCESSING_KEY,
  QUEUE_INFLIGHT_KEY,
];
