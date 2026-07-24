/* eslint-disable max-lines-per-function */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AggregationTemporality } from '@opentelemetry/sdk-metrics';
import {
  sanitizeMetricLabels,
  ALLOWED_LABEL_KEYS,
  FetchMetricExporter,
  countMetric,
  recordMetric,
  runWithMetricsSuppressed,
  initMetricTelemetry,
  flushMetricTelemetry,
  resetMetricTelemetryForTests,
} from '../../../src/services/telemetry/metrics.js';
import { Env } from '../../../src/config/types.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ENVIRONMENT: 'test', ...overrides } as Env;
}

const ENABLED = makeEnv({
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
  OTEL_COLLECTOR_TOKEN: 'secret-token',
});

const DISABLED = makeEnv();

/** A fetch mock that records calls and returns a 200. */
function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
}

/** Decode a serialized OTLP/JSON metrics payload to a plain object. */
function decodeBody(body: unknown): unknown {
  return JSON.parse(new TextDecoder().decode(body as Uint8Array));
}

/** Recursively collect every string in a decoded payload (for whole-scan leak checks). */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/** Drive a flush and await the promise it hands to `waitUntil`. */
async function flushAndWait(): Promise<void> {
  const promises: Promise<unknown>[] = [];
  flushMetricTelemetry((p) => promises.push(p));
  await Promise.all(promises);
}

afterEach(() => {
  resetMetricTelemetryForTests();
  vi.restoreAllMocks();
});

describe('sanitizeMetricLabels', () => {
  it('keeps allow-listed bounded labels', () => {
    const safe = sanitizeMetricLabels({
      transport: 'whatsapp',
      status: 'success',
      status_code: 200,
      tool_name: 'read_memory',
    });
    expect(safe).toEqual({
      transport: 'whatsapp',
      status: 'success',
      status_code: 200,
      tool_name: 'read_memory',
    });
  });

  it('drops unbounded / content-bearing keys (fail closed)', () => {
    // These are NOT in the typed MetricLabels, but a dynamically-built object or an
    // `as` cast could carry them — the runtime allow-list must still strip them.
    const dirty = {
      user_id: 'u-123',
      request_id: 'r-456',
      chat_id: 'c-789',
      message_id: 'm-1',
      job_id: 'j-1',
      url: 'https://collector.example/secret?token=abc',
      error_message: 'boom for user Alice',
      status: 'error',
    } as unknown as Parameters<typeof sanitizeMetricLabels>[0];
    const safe = sanitizeMetricLabels(dirty);
    expect(safe).toEqual({ status: 'error' });
    for (const key of Object.keys(safe)) {
      expect(ALLOWED_LABEL_KEYS.has(key)).toBe(true);
    }
  });

  it('drops null/undefined values and non-primitive values', () => {
    const safe = sanitizeMetricLabels({
      transport: undefined,
      status: 'ok',
      // @ts-expect-error deliberately wrong runtime type
      reason: { nested: 'object' },
    });
    expect(safe).toEqual({ status: 'ok' });
  });

  it('truncates an over-long allow-listed string value', () => {
    const long = 'x'.repeat(200);
    const safe = sanitizeMetricLabels({ reason: long });
    expect((safe.reason as string).length).toBe(64);
  });

  it('clamps runtime-sourced label values outside their allow-list to "other"', () => {
    // error_name/chat_type/format are bounded VALUE sets; anything else collapses so a
    // dynamic value (a novel error class, a spoofed chat_type) cannot spawn a new series.
    // `format` values are canonicalized at their source; the guard here is defense in depth.
    const safe = sanitizeMetricLabels({
      error_name: 'SomeLibrarySpecificError',
      chat_type: 'not-a-real-type',
      format: 'exotic-codec',
      status: 'error',
    });
    expect(safe).toEqual({
      error_name: 'other',
      chat_type: 'other',
      format: 'other',
      status: 'error',
    });
  });

  it('keeps runtime-sourced label values that ARE in their allow-list', () => {
    const safe = sanitizeMetricLabels({
      error_name: 'MCPResponseTooLargeError',
      chat_type: 'supergroup',
      format: 'ogg',
    });
    expect(safe).toEqual({
      error_name: 'MCPResponseTooLargeError',
      chat_type: 'supergroup',
      format: 'ogg',
    });
  });
});

describe('FetchMetricExporter', () => {
  it('selects DELTA temporality (ephemeral isolates drain per-invocation)', () => {
    const exporter = new FetchMetricExporter('https://c/v1/metrics', 't', okFetch());
    expect(exporter.selectAggregationTemporality()).toBe(AggregationTemporality.DELTA);
  });

  it('reports success without POSTing an empty payload from the reader', async () => {
    // Covered end-to-end below; here we assert shutdown/forceFlush resolve cleanly.
    const exporter = new FetchMetricExporter('https://c/v1/metrics', 't', okFetch());
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });
});

describe('metrics stack (init → emit → flush)', () => {
  it('is a genuine no-op when telemetry is disabled', async () => {
    const fetchFn = okFetch();
    initMetricTelemetry(DISABLED, { fetchFn });
    countMetric('requests_total', { transport: 'whatsapp', status: 'ok' });
    recordMetric('claude_fetch_duration_ms', 42, { status: 'success' });
    await flushAndWait();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POSTs a counter to <endpoint>/v1/metrics with a bearer token', async () => {
    const fetchFn = okFetch();
    initMetricTelemetry(ENABLED, { fetchFn });
    countMetric('requests_total', { transport: 'whatsapp', status_code: 200 });
    await flushAndWait();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://collector.example/v1/metrics');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const decoded = decodeBody(init.body);
    const strings = collectStrings(decoded);
    expect(strings).toContain('requests_total');
    expect(strings).toContain('whatsapp');
  });

  it('does not POST when nothing was recorded since the last flush', async () => {
    const fetchFn = okFetch();
    initMetricTelemetry(ENABLED, { fetchFn });
    await flushAndWait();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('invokes the fetcher detached from `this` (Workers illegal-invocation guard)', async () => {
    // Regression: calling the raw fetch as `this.fetchFn(...)` sets the receiver to the
    // exporter instance, which the Workers runtime rejects with `TypeError: Illegal
    // invocation` — so every metrics flush threw and nothing reached the collector. The
    // fetcher must be called detached (bare call → `this === undefined`).
    const capturingFetch = okFetch();
    initMetricTelemetry(ENABLED, { fetchFn: capturingFetch });
    countMetric('requests_total', { transport: 'whatsapp', status_code: 200 });
    await flushAndWait();

    // `mock.contexts` records the `this` receiver of each call. With the bug it is the
    // exporter instance; called detached it is `undefined`.
    const mock = capturingFetch as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.contexts[0]).toBeUndefined();
  });

  it('catches a synchronous fetch throw so the flush resolves (does not escape)', async () => {
    // The illegal-invocation TypeError is thrown synchronously, before the promise chain,
    // so the `.catch` cannot see it. Without an explicit try/catch it escapes export() and
    // rejects the flush; assert it is caught and reported instead.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwingFetch = vi.fn(() => {
      throw new TypeError('Illegal invocation');
    }) as unknown as typeof fetch;
    initMetricTelemetry(ENABLED, { fetchFn: throwingFetch });
    countMetric('requests_total', { transport: 'whatsapp', status_code: 200 });

    await expect(flushAndWait()).resolves.toBeUndefined();
    expect(throwingFetch).toHaveBeenCalledTimes(1);
  });

  it('records a histogram observation', async () => {
    const fetchFn = okFetch();
    initMetricTelemetry(ENABLED, { fetchFn });
    recordMetric('claude_fetch_duration_ms', 123, { status: 'success' });
    await flushAndWait();

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const strings = collectStrings(decodeBody(init.body));
    expect(strings).toContain('claude_fetch_duration_ms');
  });

  it('never egresses an unbounded label even if a call site passes one', async () => {
    const fetchFn = okFetch();
    initMetricTelemetry(ENABLED, { fetchFn });
    // Simulate a buggy call site smuggling ids through an `as` cast.
    countMetric('requests_total', {
      transport: 'whatsapp',
      status: 'ok',
      user_id: 'user:acme:alice',
      request_id: 'req-deadbeef',
    } as unknown as Parameters<typeof countMetric>[1]);
    await flushAndWait();

    const strings = collectStrings(
      decodeBody((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    );
    const joined = strings.join('\n');
    expect(joined).not.toContain('user:acme:alice');
    expect(joined).not.toContain('req-deadbeef');
    expect(joined).not.toContain('user_id');
    expect(joined).not.toContain('request_id');
  });

  it('clamps a runtime-value flood to one series through the whole export path', async () => {
    const fetchFn = okFetch();
    initMetricTelemetry(ENABLED, { fetchFn });
    // error_name values are bounded at the SOURCE, so 1500 distinct novel classes all
    // collapse to `other` — one series, no per-window overflow, and no raw value egresses.
    for (let i = 0; i < 1500; i++) {
      countMetric('requests_total', { status: 'error', error_name: `Err${i}` });
    }
    await flushAndWait();

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const decoded = decodeBody(init.body) as {
      resourceMetrics: Array<{
        scopeMetrics: Array<{ metrics: Array<{ name: string; sum?: { dataPoints: unknown[] } }> }>;
      }>;
    };
    const metric = decoded.resourceMetrics
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.name === 'requests_total');
    // Only {status:error, error_name:other} — a single series, never 1500.
    expect(metric?.sum?.dataPoints.length).toBe(1);
    const joined = collectStrings(decoded).join('\n');
    expect(joined).not.toContain('Err0');
    expect(joined).not.toContain('Err1499');
  });

  it('backstops a pass-through identifier flood with the per-metric overflow cap', async () => {
    const fetchFn = okFetch();
    initMetricTelemetry(ENABLED, { fetchFn });
    // tool_name is an operator-scoped identifier we intentionally pass through (not value-
    // clamped). A within-window blow-up is caught by the SDK series cap: excess distinct
    // values fold into one `otel.metric.overflow` series rather than 1500 distinct ones.
    for (let i = 0; i < 1500; i++) {
      countMetric('tool_calls_total', { status: 'success', tool_name: `tool_${i}` });
    }
    await flushAndWait();

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const decoded = decodeBody(init.body) as {
      resourceMetrics: Array<{
        scopeMetrics: Array<{ metrics: Array<{ name: string; sum?: { dataPoints: unknown[] } }> }>;
      }>;
    };
    const metric = decoded.resourceMetrics
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.name === 'tool_calls_total');
    // 1000 distinct + 1 overflow, never 1500.
    expect(metric?.sum?.dataPoints.length).toBeLessThanOrEqual(1001);
    expect(collectStrings(decoded)).toContain('otel.metric.overflow');
  });

  it('suppresses recording inside runWithMetricsSuppressed but not outside it', async () => {
    const fetchFn = okFetch();
    initMetricTelemetry(ENABLED, { fetchFn });
    // Emitted inside the suppressed async context (the alarm path) — must be dropped even
    // though the meter is live, since an alarm cannot export and has no metric backstop.
    await runWithMetricsSuppressed(async () => {
      countMetric('requests_total', { status: 'error', reason: 'alarm_work' });
      recordMetric('claude_fetch_duration_ms', 99, { status: 'error' });
      await Promise.resolve(); // suppression must survive an await in the call tree
      countMetric('tool_calls_total', { tool_name: 'read_memory', status: 'error' });
    });
    // Emitted outside — a concurrent/subsequent fetch's work must still record.
    countMetric('requests_total', { transport: 'stream', status_code: 200 });
    await flushAndWait();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const strings = collectStrings(
      decodeBody((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    ).join('\n');
    expect(strings).toContain('requests_total'); // the outside emit
    expect(strings).toContain('stream');
    expect(strings).not.toContain('alarm_work'); // suppressed emits absent
    expect(strings).not.toContain('claude_fetch_duration_ms');
    expect(strings).not.toContain('tool_calls_total');
  });

  it('does not throw when the export fetch rejects', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    initMetricTelemetry(ENABLED, { fetchFn });
    countMetric('requests_total', { status: 'ok' });
    await expect(flushAndWait()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
