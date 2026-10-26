/**
 * Shared route breaker (#403).
 *
 * Every conversation runs in its own Durable Object, so without shared state
 * each one would re-discover a dead route by paying its outage budget. This
 * store lets the first DO that sees an outage mark the route OPEN for a short
 * while; later turns skip straight past it.
 *
 * Design choices, all in the name of "the breaker can never make things worse":
 * - KV, not a new Durable Object: no new binding, no migration. Keys live in
 *   `ORG_CONFIG` under a reserved `__` prefix (the `__global__` convention from
 *   `MCP_SERVERS`); the admin org-config routes refuse that prefix.
 * - TTL expiry IS the probe. There is no half-open state to get wrong: after
 *   `ROUTE_HEALTH_TTL_SECONDS` the next turn simply tries the route again, and
 *   re-opens it if it is still down.
 * - KV is eventually consistent, so a few turns may still probe during the
 *   first minute of an incident. Accepted.
 * - A read failure means "nothing is open"; a write failure is logged and
 *   ignored. Both are warnings, never silent.
 */

import type { RequestLogger } from '../../utils/logger.js';
import { countMetric } from '../telemetry/index.js';
import { ROUTE_ORDER, type ModelRoute, type RouteId } from './routes.js';

/** Reserved key prefix in the `ORG_CONFIG` namespace. Never a valid org id. */
export const ROUTE_HEALTH_KEY_PREFIX = '__route_health__:';

/** How long an opened route stays skipped. KV's minimum `expirationTtl` is 60. */
export const ROUTE_HEALTH_TTL_SECONDS = 90;

/** How long one isolate trusts its last read, so the loop does not hit KV per iteration. */
const READ_MEMO_MS = 5_000;

/** What the route did to earn the open state — the tagged outage the chain saw. */
export interface RouteFailureFacts {
  outage: string;
  status: number | undefined;
  attempts: number;
}

export interface RouteHealthStore {
  /**
   * The subset of `ids` currently marked open (to be skipped). Never throws.
   * Implementations must answer for ANY subset consistently: a read for the
   * chain's suffix (a sticky iteration) and a read for the whole chain (a new
   * turn) in the same window must agree about every route.
   */
  readOpen(ids: readonly RouteId[]): Promise<Set<RouteId>>;
  /** Mark `route` open for the TTL. Never throws. */
  open(route: ModelRoute, facts: RouteFailureFacts): Promise<void>;
}

/** The value stored under a route's key: diagnostics for whoever reads it during an incident. */
interface RouteHealthRecord extends RouteFailureFacts {
  opened_at: number;
}

export function routeHealthKey(id: RouteId): string {
  return `${ROUTE_HEALTH_KEY_PREFIX}${id}`;
}

/**
 * Last read per KV namespace, shared by every store instance in the isolate so
 * the many DOs on one isolate do not each pay a read per turn. Always holds the
 * state of EVERY route (`ROUTE_ORDER`), whatever subset the caller asked for —
 * otherwise a suffix read by a sticky iteration would leave a memo that hides an
 * open primary from the next new turn (Codex review on #464).
 */
const memos = new WeakMap<KVNamespace, { at: number; open: Set<RouteId> }>();

async function writeOpenRecord(
  kv: KVNamespace,
  logger: RequestLogger,
  route: ModelRoute,
  record: RouteHealthRecord
): Promise<void> {
  logger.warn('route_breaker_opened', {
    route: route.id,
    model: route.model,
    outage: record.outage,
    status: record.status,
    attempts: record.attempts,
    ttl_seconds: ROUTE_HEALTH_TTL_SECONDS,
  });
  countMetric('route_breaker_total', { route: route.id, reason: 'opened' });
  try {
    await kv.put(routeHealthKey(route.id), JSON.stringify(record), {
      expirationTtl: ROUTE_HEALTH_TTL_SECONDS,
    });
  } catch (error) {
    // The chain already moved on; losing the shared flag only costs other
    // conversations their own probe. Logged, never fatal.
    logger.warn('route_breaker_write_failed', {
      route: route.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** KV-backed store. `now` is injectable for the memo test. */
export function createKvRouteHealthStore(
  kv: KVNamespace,
  logger: RequestLogger,
  now: () => number = () => Date.now()
): RouteHealthStore {
  /** Reads ALL routes, never just the requested subset — see `memos`. */
  async function readUncached(): Promise<Set<RouteId>> {
    try {
      const found = await Promise.all(
        ROUTE_ORDER.map(async (id) => ((await kv.get(routeHealthKey(id))) === null ? null : id))
      );
      return new Set(found.filter((id): id is RouteId => id !== null));
    } catch (error) {
      // Degrade to "nothing open": the chain still probes every route in order.
      logger.warn('route_health_read_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Set();
    }
  }

  return {
    async readOpen(ids) {
      const at = now();
      const memo = memos.get(kv);
      const open = memo && at - memo.at < READ_MEMO_MS ? memo.open : await readUncached();
      if (open !== memo?.open) memos.set(kv, { at, open });
      return new Set(ids.filter((id) => open.has(id)));
    },
    async open(route, facts) {
      await writeOpenRecord(kv, logger, route, { ...facts, opened_at: now() });
      memos.delete(kv);
    },
  };
}

/** Process-local store for tests and for callers without a KV binding. */
export function createMemoryRouteHealthStore(): RouteHealthStore {
  const open = new Set<RouteId>();
  return {
    async readOpen(ids) {
      return new Set(ids.filter((id) => open.has(id)));
    },
    async open(route) {
      open.add(route.id);
    },
  };
}
