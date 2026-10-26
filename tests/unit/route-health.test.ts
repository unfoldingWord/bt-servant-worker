/**
 * Shared route breaker (#403).
 *
 * One Durable Object learning that a route is down should spare every other
 * conversation the same probe for a while. The state lives in KV under a
 * reserved key with a short TTL; TTL expiry IS the probe. The store must never
 * be able to take the service down: a KV failure degrades to "all routes closed"
 * with a warning, and a write failure is logged and otherwise ignored.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createKvRouteHealthStore,
  createMemoryRouteHealthStore,
  ROUTE_HEALTH_KEY_PREFIX,
  ROUTE_HEALTH_TTL_SECONDS,
  type RouteHealthStore,
} from '../../src/services/claude/route-health.js';
import { buildRouteChain } from '../../src/services/claude/routes.js';
import type { RequestLogger } from '../../src/utils/logger.js';

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

/** In-memory KV double recording `put` options so the TTL can be asserted. */
function fakeKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const puts: Array<{ key: string; value: string; options: unknown }> = [];
  const kv = {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, options?: unknown) => {
      data.set(key, value);
      puts.push({ key, value, options });
    }),
  } as unknown as KVNamespace;
  return { kv, data, puts };
}

const routes = () =>
  buildRouteChain({ ENVIRONMENT: 'staging', ANTHROPIC_API_KEY: 'k' }, createMockLogger()).routes;
const ids = () => routes().map((r) => r.id);
const warnEvents = (l: RequestLogger): string[] =>
  (l.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);

describe('KV route health store — open', () => {
  it('writes a reserved key with the 90s TTL and the failure facts', async () => {
    const { kv, puts } = fakeKv();
    const logger = createMockLogger();
    const store = createKvRouteHealthStore(kv, logger);

    await store.open(routes()[0]!, { outage: 'http_5xx', status: 529, attempts: 2 });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(`${ROUTE_HEALTH_KEY_PREFIX}primary`);
    expect(puts[0]!.options).toEqual({ expirationTtl: ROUTE_HEALTH_TTL_SECONDS });
    expect(JSON.parse(puts[0]!.value)).toMatchObject({
      outage: 'http_5xx',
      status: 529,
      attempts: 2,
    });
    expect(ROUTE_HEALTH_TTL_SECONDS).toBeGreaterThanOrEqual(60); // KV minimum
    expect(warnEvents(logger)).toContain('route_breaker_opened');
  });

  it('a failed write is logged and does not throw', async () => {
    const { kv } = fakeKv();
    (kv.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));
    const logger = createMockLogger();
    const store = createKvRouteHealthStore(kv, logger);

    await expect(
      store.open(routes()[0]!, { outage: 'network_error', status: undefined, attempts: 2 })
    ).resolves.toBeUndefined();
    expect(warnEvents(logger)).toContain('route_breaker_write_failed');
  });
});

describe('KV route health store — read', () => {
  it('reports the routes whose key exists as open', async () => {
    const { kv } = fakeKv({ [`${ROUTE_HEALTH_KEY_PREFIX}primary`]: '{"outage":"http_5xx"}' });
    const store = createKvRouteHealthStore(kv, createMockLogger());

    const open = await store.readOpen(ids());

    expect([...open]).toEqual(['primary']);
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it('a failed read degrades to "nothing open" with a warning', async () => {
    const { kv } = fakeKv();
    (kv.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));
    const logger = createMockLogger();
    const store = createKvRouteHealthStore(kv, logger);

    const open = await store.readOpen(ids());

    expect(open.size).toBe(0);
    expect(warnEvents(logger)).toContain('route_health_read_failed');
  });

  it('memoizes the read per store for a few seconds so the loop does not hit KV per iteration', async () => {
    const { kv } = fakeKv();
    let now = 1_000;
    const store = createKvRouteHealthStore(kv, createMockLogger(), () => now);

    await store.readOpen(ids());
    await store.readOpen(ids());
    expect(kv.get).toHaveBeenCalledTimes(2);

    now += 6_000;
    await store.readOpen(ids());
    expect(kv.get).toHaveBeenCalledTimes(4);
  });
});

describe('memory route health store', () => {
  it('remembers an opened route until it is cleared', async () => {
    const store: RouteHealthStore = createMemoryRouteHealthStore();
    expect((await store.readOpen(ids())).size).toBe(0);

    await store.open(routes()[1]!, { outage: 'http_5xx', status: 503, attempts: 1 });

    expect([...(await store.readOpen(ids()))]).toEqual(['anthropic-alt']);
  });
});
