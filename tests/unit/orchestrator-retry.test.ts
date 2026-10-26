/**
 * Tests for per-route retry/backoff (issue #248) and outage classification (#403).
 *
 * The worker calls the Messages API via raw `globalThis.fetch` (the SDK's HTTP
 * layer 1003s from inside our nested Durable Object chain — see PR #104), which
 * means we also lost the SDK's built-in retry/backoff. `fetchRouteWithRetry`
 * restores it per route: jittered exponential backoff on 429, honoring
 * `Retry-After`, bounded by an overall wall-clock window, with a fresh
 * per-attempt 90s hang-guard. Retries happen strictly BEFORE any response body
 * is consumed, so the streaming path can only retry pre-first-byte.
 *
 * #403 adds OUTAGE classification: connection errors, 5xx/529 and (streaming
 * only) a missing first byte are "outage-class". Those get `route.outageAttempts`
 * tries, then the function RETURNS a tagged outage so the caller can move to the
 * next route, instead of throwing. 429 is deliberately NOT outage-class: failing
 * over on a rate limit just migrates the throttling to the next provider.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchRouteWithRetry,
  computeBackoffDelay,
  parseRetryAfter,
  isRetryableStatus,
  type RetryClock,
} from '../../src/services/claude/orchestrator.js';
import { buildRouteChain, type ModelRoute } from '../../src/services/claude/routes.js';
import { RequestLogger } from '../../src/utils/logger.js';

type RetryCtx = Parameters<typeof fetchRouteWithRetry>[0];

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

function makeCtx(logger: RequestLogger): RetryCtx {
  return { logger } as unknown as RetryCtx;
}

/** `primary` (2 outage attempts) and `anthropic-alt` (1 outage attempt). */
function routes(): { primary: ModelRoute; alt: ModelRoute } {
  const chain = buildRouteChain(
    { ENVIRONMENT: 'staging', ANTHROPIC_API_KEY: 'k' },
    createMockLogger()
  ).routes;
  return { primary: chain[0]!, alt: chain[1]! };
}

/**
 * Deterministic clock for tests. `random` defaults to 1 (max jitter → delay equals
 * the full computed bound, so assertions are predictable). `now` walks `nowValues`,
 * staying on the last value once exhausted (so elapsed checks are controllable).
 */
function makeClock(opts: { random?: number; nowValues?: number[] } = {}): RetryClock & {
  sleep: ReturnType<typeof vi.fn>;
} {
  const sleep = vi.fn(async () => {});
  const nowValues = opts.nowValues ?? [0];
  let i = 0;
  const now = (): number => nowValues[Math.min(i++, nowValues.length - 1)]!;
  const random = opts.random ?? 1;
  return { sleep, now, random: () => random };
}

function jsonResponse(status: number, body = '{}', headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch that never answers and only rejects (as an AbortError) when its signal aborts. */
function hangingFetch(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      );
    })) as unknown as typeof fetch;
}

/** A body that yields `first` at once and `second` a few ms later, then closes. */
function twoChunkStream(first: string, second: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
      setTimeout(() => {
        controller.enqueue(encoder.encode(second));
        controller.close();
      }, 5);
    },
  });
}

function eventsFor(fn: unknown): string[] {
  return (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
}
const warnEvents = (l: RequestLogger): string[] => eventsFor(l.warn);
const errorEvents = (l: RequestLogger): string[] => eventsFor(l.error);

async function run(
  logger: RequestLogger,
  route: ModelRoute,
  streaming: boolean,
  clock: RetryClock
): ReturnType<typeof fetchRouteWithRetry> {
  return fetchRouteWithRetry(makeCtx(logger), route, '{}', {
    streaming,
    overallStart: clock.now(),
    clock,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('retry/backoff — pure helpers', () => {
  it('isRetryableStatus: retries 429/500/502/503/504/529, not 4xx-deterministic', () => {
    for (const s of [429, 500, 502, 503, 504, 529]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 403, 404, 422]) expect(isRetryableStatus(s)).toBe(false);
  });

  it('computeBackoffDelay: full jitter, exponential, capped', () => {
    // random = 1 → delay equals the full bound: base * 2^(attempt-1), capped at 30s.
    expect(computeBackoffDelay(1, () => 1)).toBe(1_000);
    expect(computeBackoffDelay(2, () => 1)).toBe(2_000);
    expect(computeBackoffDelay(3, () => 1)).toBe(4_000);
    expect(computeBackoffDelay(20, () => 1)).toBe(30_000); // cap
    expect(computeBackoffDelay(3, () => 0)).toBe(0); // lower bound of full jitter
    expect(computeBackoffDelay(2, () => 0.5)).toBe(1_000);
  });

  it('parseRetryAfter: delta-seconds and HTTP-date, clamped to >= 0', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '5' }), () => 0)).toBe(5_000);
    const future = new Headers({ 'retry-after': new Date(10_000).toUTCString() });
    expect(parseRetryAfter(future, () => 0)).toBe(10_000);
    const past = new Headers({ 'retry-after': new Date(0).toUTCString() });
    expect(parseRetryAfter(past, () => 5_000)).toBe(0);
    expect(parseRetryAfter(new Headers(), () => 0)).toBeNull();
  });
});

describe('fetchRouteWithRetry — 429 retries then succeeds (not an outage)', () => {
  it('retries on 429 twice then succeeds (logs claude_api_retry each time)', async () => {
    const logger = createMockLogger();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200, '{"ok":true}'));
    const clock = makeClock();

    const outcome = await run(logger, routes().primary, false, clock);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.result.response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(warnEvents(logger).filter((e) => e === 'claude_api_retry')).toHaveLength(2);
    expect(errorEvents(logger)).not.toContain('claude_api_retry_exhausted');
    outcome.result.cleanup();
  });

  it('honors Retry-After when larger than computed backoff', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(429, '{}', { 'retry-after': '5' }))
      .mockResolvedValueOnce(jsonResponse(200));
    const clock = makeClock({ random: 0 }); // computed backoff = 0 → Retry-After wins

    const outcome = await run(logger, routes().primary, false, clock);

    expect(outcome.ok).toBe(true);
    expect(clock.sleep).toHaveBeenCalledWith(5_000);
    if (outcome.ok) outcome.result.cleanup();
  });

  it('streaming path retries a pre-first-byte 429 then returns the stream response', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(
        new Response('data: {}\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    const clock = makeClock();

    const outcome = await run(logger, routes().primary, true, clock);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.result.response.body).toBeTruthy();
    expect(warnEvents(logger).filter((e) => e === 'claude_api_retry')).toHaveLength(1);
    outcome.result.cleanup();
  });
});

describe('fetchRouteWithRetry — outage-class failures use the route budget', () => {
  it('primary: one transient network error is retried and then succeeds', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => {
        throw new TypeError('network failure');
      })
      .mockResolvedValueOnce(jsonResponse(200));
    const clock = makeClock();

    const outcome = await run(logger, routes().primary, false, clock);

    expect(outcome.ok).toBe(true);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(warnEvents(logger).filter((e) => e === 'claude_api_retry')).toHaveLength(1);
    if (outcome.ok) outcome.result.cleanup();
  });

  it('primary: two network errors return a tagged outage instead of throwing', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new TypeError('network failure');
    });
    const clock = makeClock();

    const outcome = await run(logger, routes().primary, false, clock);

    expect(outcome).toMatchObject({ ok: false, outage: 'network_error', attempts: 2 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(warnEvents(logger)).toContain('claude_route_outage');
    expect(errorEvents(logger)).not.toContain('claude_api_retry_exhausted');
  });
});

describe('fetchRouteWithRetry — outage budget per route', () => {
  it('primary: 503 twice returns an http_5xx outage carrying the status', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(503));
    const clock = makeClock();

    const outcome = await run(logger, routes().primary, false, clock);

    expect(outcome).toMatchObject({ ok: false, outage: 'http_5xx', status: 503, attempts: 2 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('a fallback route gets a single attempt before reporting an outage (no backoff sleep)', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(529));
    const clock = makeClock();

    const outcome = await run(logger, routes().alt, false, clock);

    expect(outcome).toMatchObject({ ok: false, outage: 'http_5xx', status: 529, attempts: 1 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('a 429 after a 5xx keeps retrying on the route: the rate limit is not an outage', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200));
    const clock = makeClock();

    const outcome = await run(logger, routes().primary, false, clock);

    expect(outcome.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    if (outcome.ok) outcome.result.cleanup();
  });
});

describe('fetchRouteWithRetry — terminal failures still throw', () => {
  it('exhausts retries on persistent 429 (logs exhausted + http_error, throws)', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(429));
    const clock = makeClock();

    await expect(run(logger, routes().primary, false, clock)).rejects.toThrow();

    expect(globalThis.fetch).toHaveBeenCalledTimes(4); // 1 + 3 retries
    expect(clock.sleep).toHaveBeenCalledTimes(3);
    expect(errorEvents(logger)).toContain('claude_api_retry_exhausted');
    expect(errorEvents(logger)).toContain('claude_fetch_http_error');
  });

  it('does NOT retry deterministic 4xx (400) — fails fast, no outage', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(400, '{"error":"x"}')
    );
    const clock = makeClock();

    await expect(run(logger, routes().primary, false, clock)).rejects.toThrow();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(warnEvents(logger)).not.toContain('claude_api_retry');
    expect(warnEvents(logger)).not.toContain('claude_route_outage');
    expect(errorEvents(logger)).toContain('claude_fetch_http_error');
  });
});

describe('fetchRouteWithRetry — window and hang-guard terminals', () => {
  it('stops early when the next backoff would exceed the overall window', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(429));
    // overallStart=0, then the elapsed check returns 200s (> 180s window).
    const clock = makeClock({ nowValues: [0, 200_000] });

    await expect(run(logger, routes().primary, false, clock)).rejects.toThrow();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no further attempts
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(errorEvents(logger)).toContain('claude_api_retry_exhausted');
  });

  it('does NOT retry our own body hang-guard AbortError (logs claude_fetch_aborted)', async () => {
    const logger = createMockLogger();
    // A timeout abort surfaces as an error whose `name` is 'AbortError' (what
    // isOurTimeoutAbort keys on); a plain Error exercises that branch.
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw abort;
    });
    const clock = makeClock();

    let caught: unknown;
    try {
      await run(logger, routes().primary, false, clock);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).name).toBe('AbortError');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(errorEvents(logger)).toContain('claude_fetch_aborted');
  });
});

describe('fetchRouteWithRetry — first-byte deadline (streaming only)', () => {
  it('streaming: no headers within 20s is an outage, classified first_byte_timeout', async () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(hangingFetch());
    const clock = makeClock();

    const pending = run(logger, routes().alt, true, clock);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({ ok: false, outage: 'first_byte_timeout', attempts: 1 });
    expect(errorEvents(logger)).not.toContain('claude_fetch_aborted');
  });

  it('non-streaming: a slow response is NOT cut at 20s; the 90s hang-guard still applies', async () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(hangingFetch());
    const clock = makeClock();

    let settled = false;
    const pending = run(logger, routes().alt, false, clock).then(
      () => (settled = true),
      () => (settled = true)
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(70_000);
    await pending;
    expect(settled).toBe(true);
    expect(errorEvents(logger)).toContain('claude_fetch_aborted');
    expect(warnEvents(logger)).not.toContain('claude_route_outage');
  });

  it('streaming: 200 headers with a body that never yields is still a first_byte_timeout outage', async () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    );
    const clock = makeClock();

    const pending = run(logger, routes().alt, true, clock);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({ ok: false, outage: 'first_byte_timeout', attempts: 1 });
    expect(warnEvents(logger)).toContain('claude_route_outage');
  });
});

describe('fetchRouteWithRetry — first chunk replay and timer release', () => {
  it('streaming: the first chunk is replayed, so the caller still reads the whole body', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(twoChunkStream('data: {"a":1}\n', 'data: {"b":2}\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    );

    const outcome = await run(logger, routes().alt, true, makeClock());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');

    expect(await outcome.result.response.text()).toBe('data: {"a":1}\ndata: {"b":2}\n');
    outcome.result.cleanup();
  });

  it('streaming: once the first chunk arrives the first-byte timer is cleared (long bodies survive)', async () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('data: {}\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    );
    const clock = makeClock();

    const outcome = await run(logger, routes().alt, true, clock);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');

    await vi.advanceTimersByTimeAsync(25_000);
    expect(outcome.result.signal.aborted).toBe(false);
    outcome.result.cleanup();
  });
});

describe('fetchRouteWithRetry — terminal abort-guard lifecycle', () => {
  // Regression: the terminal HTTP-error path reads response.text(); the per-attempt
  // abort guard must stay live until that read completes, so a stalled error body is
  // bounded by the 90s timeout instead of hanging after cleanup.
  it('reads the terminal error body before clearing the abort guard', async () => {
    const logger = createMockLogger();
    let guardCleared = false;
    let bodyReadWhileGuardLive: boolean | null = null;
    const realClearTimeout = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      id?: Parameters<typeof clearTimeout>[0]
    ) => {
      guardCleared = true;
      return realClearTimeout(id);
    }) as typeof clearTimeout);
    const realText = Response.prototype.text;
    vi.spyOn(Response.prototype, 'text').mockImplementation(async function (this: Response) {
      bodyReadWhileGuardLive = !guardCleared;
      return realText.call(this);
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(400, '{"e":1}'));

    await expect(run(logger, routes().primary, false, makeClock())).rejects.toThrow();

    expect(bodyReadWhileGuardLive).toBe(true);
  });
});
