/**
 * Tests for Anthropic API retry/backoff (issue #248).
 *
 * The worker calls the Anthropic Messages API via raw `globalThis.fetch` (the SDK's
 * HTTP layer 1003s from inside our nested Durable Object chain — see PR #104), which
 * means we also lost the SDK's built-in retry/backoff. `fetchAnthropicWithRetry`
 * restores it: jittered exponential backoff on 429/5xx/529 and transient network
 * errors, honoring `Retry-After`, bounded by an overall wall-clock window, with a
 * fresh per-attempt 90s hang-guard. Retries happen strictly BEFORE any response body
 * is consumed, so the streaming path can only retry pre-first-byte.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchAnthropicWithRetry,
  computeBackoffDelay,
  parseRetryAfter,
  isRetryableStatus,
  type RetryClock,
} from '../../src/services/claude/orchestrator.js';
import { RequestLogger } from '../../src/utils/logger.js';

type RetryCtx = Parameters<typeof fetchAnthropicWithRetry>[0];

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

function makeCtx(logger: RequestLogger): RetryCtx {
  return { logger, apiKey: 'test-key' } as unknown as RetryCtx;
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

function eventsFor(fn: unknown): string[] {
  return (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
}
const warnEvents = (l: RequestLogger): string[] => eventsFor(l.warn);
const errorEvents = (l: RequestLogger): string[] => eventsFor(l.error);

afterEach(() => vi.restoreAllMocks());

describe('Anthropic retry/backoff — pure helpers', () => {
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

describe('fetchAnthropicWithRetry — retries then succeeds', () => {
  it('retries on 429 twice then succeeds (logs claude_api_retry each time)', async () => {
    const logger = createMockLogger();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200, '{"ok":true}'));
    const clock = makeClock();

    const result = await fetchAnthropicWithRetry(makeCtx(logger), '{}', false, clock);

    expect(result.response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(warnEvents(logger).filter((e) => e === 'claude_api_retry')).toHaveLength(2);
    expect(errorEvents(logger)).not.toContain('claude_api_retry_exhausted');
    result.cleanup();
  });

  it('honors Retry-After when larger than computed backoff', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(429, '{}', { 'retry-after': '5' }))
      .mockResolvedValueOnce(jsonResponse(200));
    const clock = makeClock({ random: 0 }); // computed backoff = 0 → Retry-After wins

    const result = await fetchAnthropicWithRetry(makeCtx(logger), '{}', false, clock);

    expect(result.response.status).toBe(200);
    expect(clock.sleep).toHaveBeenCalledWith(5_000);
    result.cleanup();
  });
});

describe('fetchAnthropicWithRetry — streaming and network retries', () => {
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

    const result = await fetchAnthropicWithRetry(makeCtx(logger), '{}', true, clock);

    expect(result.response.status).toBe(200);
    expect(result.response.body).toBeTruthy();
    expect(warnEvents(logger).filter((e) => e === 'claude_api_retry')).toHaveLength(1);
    result.cleanup();
  });

  it('retries a transient network error then succeeds', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => {
        throw new TypeError('network failure');
      })
      .mockResolvedValueOnce(jsonResponse(200));
    const clock = makeClock();

    const result = await fetchAnthropicWithRetry(makeCtx(logger), '{}', false, clock);

    expect(result.response.status).toBe(200);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(warnEvents(logger).filter((e) => e === 'claude_api_retry')).toHaveLength(1);
    result.cleanup();
  });
});

describe('fetchAnthropicWithRetry — terminal failures', () => {
  it('exhausts retries on persistent 429 (logs exhausted + http_error, throws)', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(429));
    const clock = makeClock();

    await expect(fetchAnthropicWithRetry(makeCtx(logger), '{}', false, clock)).rejects.toThrow();

    expect(globalThis.fetch).toHaveBeenCalledTimes(4); // 1 + 3 retries
    expect(clock.sleep).toHaveBeenCalledTimes(3);
    expect(errorEvents(logger)).toContain('claude_api_retry_exhausted');
    expect(errorEvents(logger)).toContain('claude_fetch_http_error');
  });

  it('does NOT retry deterministic 4xx (400) — fails fast', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(400, '{"error":"x"}')
    );
    const clock = makeClock();

    await expect(fetchAnthropicWithRetry(makeCtx(logger), '{}', false, clock)).rejects.toThrow();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(warnEvents(logger)).not.toContain('claude_api_retry');
    expect(errorEvents(logger)).not.toContain('claude_api_retry_exhausted');
    expect(errorEvents(logger)).toContain('claude_fetch_http_error');
  });
});

describe('fetchAnthropicWithRetry — window and abort terminals', () => {
  it('stops early when the next backoff would exceed the overall window', async () => {
    const logger = createMockLogger();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(429));
    // overallStart=0, then the elapsed check returns 200s (> 180s window).
    const clock = makeClock({ nowValues: [0, 200_000] });

    await expect(fetchAnthropicWithRetry(makeCtx(logger), '{}', false, clock)).rejects.toThrow();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no further attempts
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(errorEvents(logger)).toContain('claude_api_retry_exhausted');
  });

  it('does NOT retry our own timeout AbortError (logs claude_fetch_aborted)', async () => {
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
      await fetchAnthropicWithRetry(makeCtx(logger), '{}', false, clock);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).name).toBe('AbortError');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(errorEvents(logger)).toContain('claude_fetch_aborted');
  });
});

describe('fetchAnthropicWithRetry — terminal abort-guard lifecycle', () => {
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

    await expect(
      fetchAnthropicWithRetry(makeCtx(logger), '{}', false, makeClock())
    ).rejects.toThrow();

    expect(bodyReadWhileGuardLive).toBe(true);
  });
});
