/**
 * Decoding half of the admin DO-snapshot endpoint, split out so the
 * failure-propagation rule is unit-testable without standing up a Durable
 * Object.
 *
 * The rule: `fetch()` RESOLVES for non-2xx responses, so a snapshot must check
 * both subrequests' status before decoding. Skipping that check would decode a
 * DO error payload as a result and return an outer 200 whose `identity` is
 * `undefined` and whose `history` is error-shaped — an incomplete snapshot
 * indistinguishable from a complete one. Any enumeration built on this endpoint
 * would then silently record "no identity / no history" for DOs that actually
 * have both.
 */
import { ChatHistoryResponse, StoredIdentity } from '../../types/engine.js';

export type DoSnapshotResult =
  | { ok: true; identity: StoredIdentity | null; history: ChatHistoryResponse }
  | { ok: false; identityStatus: number; historyStatus: number };

/**
 * Validate both DO subrequest responses, then decode them. Returns a failure
 * result carrying both statuses when either subrequest was not 2xx.
 */
export async function readDoSnapshot(
  identityRes: Response,
  historyRes: Response
): Promise<DoSnapshotResult> {
  if (!identityRes.ok || !historyRes.ok) {
    return { ok: false, identityStatus: identityRes.status, historyStatus: historyRes.status };
  }
  const { identity } = (await identityRes.json()) as { identity: StoredIdentity | null };
  const history = (await historyRes.json()) as ChatHistoryResponse;
  return { ok: true, identity: identity ?? null, history };
}
