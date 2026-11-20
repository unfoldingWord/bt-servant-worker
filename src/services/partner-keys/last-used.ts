/**
 * "Last used" for partner API keys (admin-portal#354): partners clean up old
 * keys by seeing which ones are still in use.
 *
 * Recording is throttled and off the request path. After a partner key
 * authenticates and passes the route allowlist, the worker asks the
 * PartnerKeyStoreDO to stamp the key's `used:` row — in the background
 * (`waitUntil`), and at most once per key per LAST_USED_THROTTLE_MS per
 * worker isolate. So:
 *
 * - chat latency is unchanged (no synchronous DO call on the hot path);
 * - the one global DO sees at most one write per key per window per isolate;
 * - `lastUsedAt` is coarse: it can lag the true last request by up to the
 *   window (a request inside the window after a recorded one is not sent),
 *   and never leads it. The DO stamps its own clock and only moves forward.
 *
 * The throttle mark is set BEFORE the write and kept when the write fails:
 * a failing DO is then retried once per window, not on every request. Each
 * failure is logged under the request that triggered it.
 */

import type { RequestLogger } from '../../utils/logger.js';

/** Granularity of `lastUsedAt`: at most one recording per key per isolate per 10 minutes. */
export const LAST_USED_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Bound on the per-isolate throttle map. Keys are few (tens), so this is only
 * a guard against unbounded growth; when it is reached the map is cleared,
 * which can only cause extra (still correct) recordings.
 */
const MAX_TRACKED_KEYS = 1000;

/** Per-isolate: key id → when this isolate last sent a recording (ms). */
const lastSent = new Map<string, number>();

/**
 * Whether this isolate should record a use of `keyId` at `now`, and if so
 * mark it as sent. Exported for tests.
 */
export function claimLastUsedSlot(keyId: string, now: number): boolean {
  const previous = lastSent.get(keyId);
  if (previous !== undefined && now - previous < LAST_USED_THROTTLE_MS) return false;
  if (previous === undefined && lastSent.size >= MAX_TRACKED_KEYS) lastSent.clear();
  lastSent.set(keyId, now);
  return true;
}

/** Test hook: forget every throttle mark in this isolate. */
export function resetLastUsedThrottle(): void {
  lastSent.clear();
}

export type RecordUseDeps = {
  keyId: string;
  /** Sends the recording to the PartnerKeyStoreDO (partnerKeyStore(...).recordUse). */
  recordUse: (keyId: string) => Promise<boolean>;
  /** Keeps the background write alive after the response (ctx.waitUntil). */
  waitUntil: (work: Promise<unknown>) => void;
  logger: RequestLogger;
  now?: number;
};

/**
 * Record a use of `keyId` in the background, unless this isolate recorded it
 * within LAST_USED_THROTTLE_MS. Never throws and never delays the caller; a
 * failed write is logged (`partner_key_last_used_write_failed`).
 */
export function recordPartnerKeyUse(deps: RecordUseDeps): void {
  if (!claimLastUsedSlot(deps.keyId, deps.now ?? Date.now())) return;
  deps.waitUntil(writeLastUsed(deps));
}

/** The background write. Resolves either way: success and failure are both logged. */
async function writeLastUsed({ keyId, recordUse, logger }: RecordUseDeps): Promise<void> {
  try {
    const recorded = await recordUse(keyId);
    logger.log('partner_key_last_used_recorded', { key_id: keyId, recorded });
  } catch (error) {
    logger.error('partner_key_last_used_write_failed', error, { key_id: keyId });
  }
}
