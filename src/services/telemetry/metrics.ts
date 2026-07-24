/**
 * OTLP metrics pipeline (M4): a bounded-label counter/histogram set over the same
 * seams M1/M2/M3 already instrument (orchestration, MCP tool calls, code execution,
 * binding I/O, auth/rate-limit/queue gates, TTS/STT, ptxprint, progress webhooks).
 *
 * Why this file exists (same wall as the M2 logs stack): `@microlabs/otel-cf-workers`
 * is traces-only, and the stock OTLP metrics exporter + `PeriodicExportingMetricReader`
 * cannot run in a Worker — the reader relies on a background `setInterval` timer that
 * does not fire reliably between requests, and even if it did, an export firing outside
 * a request context cannot `fetch`. So we run our own minimal metrics stack:
 *   - a `MeterProvider` (SDK) with a service resource matching the M1 spans / M2 logs,
 *   - a TIMER-FREE reader (`PerInvocationMetricReader`) that collects + exports exactly
 *     once per invocation when drained at the request/DO boundary via `waitUntil`,
 *     exactly how otel-cf-workers flushes spans and our logs stack flushes records,
 *   - a fetch-based exporter (`FetchMetricExporter`) that serializes with
 *     `@opentelemetry/otlp-transformer` (`JsonMetricsSerializer`) and POSTs via
 *     otel-cf-workers' `__unwrappedFetch` (the RAW global fetch, so our own metric
 *     export is not itself re-traced).
 *
 * DELTA temporality (not cumulative): Worker isolates are ephemeral and each drains
 * its accumulated measurements once per invocation. A cumulative counter would report
 * each short-lived isolate's running total-since-start, and with isolates constantly
 * spawning and dying the backend would see a sawtooth of resets rather than a monotonic
 * series. DELTA reports the increment since the previous flush and the backend sums
 * them — the correct model for a stateless/serverless producer.
 *
 * CARDINALITY is the governing constraint here, the metrics analogue of the logs/span
 * FAIL-CLOSED redaction, enforced in THREE layers (`sanitizeMetricLabels` + the reader):
 *   1. KEY allow-list — drops any key not in `ALLOWED_LABEL_KEYS`, so an unbounded/
 *      content-bearing label (user_id, request_id, chat_id, a raw error message, a URL,
 *      an R2 key) can never become a dimension. (Also strips the PII the trace/log paths
 *      strip.)
 *   2. VALUE allow-list — for the labels whose values come from runtime/untrusted input
 *      (`error_name`, `chat_type`, `format`), a value outside its `BOUNDED_LABEL_VALUES`
 *      set collapses to `other`. This is the PRIMARY value-cardinality guarantee: the SDK
 *      series cap (layer 3) only bounds a single collection window, and DELTA collection
 *      resets it every flush, so a per-window cap alone can't stop a value that varies
 *      across flushes from accumulating unbounded BACKEND series over time — bounding the
 *      value SET at the source can.
 *   3. Per-metric series cap (`MAX_SERIES_PER_METRIC`) — the reader's within-window
 *      backstop for the operator-scoped identifier labels we intentionally pass through
 *      (`tool_name`/`server`, bounded by configuration, not request traffic): a blow-up
 *      folds into one `otel.metric.overflow` series.
 *
 * Governance (same posture as M1/M2): telemetry is a genuine no-op unless the endpoint
 * + token are both set; nothing egresses and no instrument is created.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Counter, type Histogram, type Meter } from '@opentelemetry/api';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { JsonMetricsSerializer } from '@opentelemetry/otlp-transformer';
import { __unwrappedFetch } from '@microlabs/otel-cf-workers';
import { Env } from '../../config/types.js';
import { APP_VERSION } from '../../generated/version.js';
import { isTelemetryEnabled, TELEMETRY_SERVICE_NAME } from './config.js';

/** Instrumentation scope name reported for every emitted metric. */
const METRIC_SCOPE_NAME = TELEMETRY_SERVICE_NAME;

/** Build the OTLP/HTTP metrics URL from the collector's base endpoint. */
function metricsEndpoint(base: string): string {
  return `${base.replace(/\/+$/, '')}/v1/metrics`;
}

// ── Label discipline (the cardinality guard) ─────────────────────────────────

/**
 * The ONLY label keys allowed on a metric. Every one is a bounded enum / structural
 * dimension whose value set is small and known at code-review time. This is the
 * metrics analogue of `redact.ts`'s allow-list: `sanitizeMetricLabels` DROPS any key
 * not in this set, so an unbounded or content-bearing label (user_id, request_id,
 * chat_id, thread_id, message_id, job_id, a raw error message, a URL, an R2 key) can
 * never become a time-series dimension — that would both blow up backend cardinality
 * and re-introduce the PII the trace/log paths strip.
 *
 * Deliberately NOT here: any id (user/request/chat/thread/message/job), free text,
 * URLs, file/R2 keys, raw error messages. Use `error_name` (the bounded error class),
 * never the message.
 */
export const ALLOWED_LABEL_KEYS = new Set<string>([
  'transport',
  'chat_type',
  'intent',
  'language',
  'source_language',
  'target_language',
  'model',
  'server',
  'tool',
  'tool_name',
  'status',
  'status_code',
  'error_name',
  'environment',
  'reason',
  'op',
  'type',
  'format',
]);

/**
 * Cap a label value's length so an unexpectedly large value under an allow-listed key
 * cannot bloat a single series. Bounded values (enums, short codes) are far under this;
 * the cap is a backstop for value SIZE, not for cardinality — series COUNT is bounded
 * separately by `MAX_SERIES_PER_METRIC` (truncation alone does not reduce cardinality:
 * two distinct long values truncate to two distinct series).
 */
const MAX_LABEL_VALUE_LENGTH = 64;

/**
 * Per-metric distinct-series cap enforced by the SDK at aggregation time: once a metric
 * reaches the limit within a collection window, every further distinct attribute-set
 * folds into one overflow series (`otel.metric.overflow`).
 *
 * IMPORTANT — this is a BACKSTOP, not the primary cardinality guarantee. Because we use
 * DELTA temporality and drain once per invocation, each flush is a fresh collection
 * window and the cap resets, so a value that varies across windows would still create
 * unbounded BACKEND series over time despite never exceeding the cap in any single
 * window. The real guarantee is bounding the VALUE SET at the source (`BOUNDED_LABEL_
 * VALUES`); this cap only backstops the operator-scoped identifier labels we pass through
 * (`tool_name`/`server`) against a within-window blow-up. Set well under the SDK's 2000
 * default.
 */
const MAX_SERIES_PER_METRIC = 1000;

/**
 * The typed label bag callers pass. Every key is optional and MUST be one of the
 * bounded dimensions in `ALLOWED_LABEL_KEYS`; the type keeps call sites honest and
 * `sanitizeMetricLabels` enforces the same set at runtime (defense in depth against
 * `as` casts / dynamically built objects).
 */
export interface MetricLabels {
  transport?: string;
  chat_type?: string;
  intent?: string;
  language?: string;
  source_language?: string;
  target_language?: string;
  model?: string;
  server?: string;
  tool?: string;
  tool_name?: string;
  status?: string;
  status_code?: string | number;
  error_name?: string;
  environment?: string;
  reason?: string;
  op?: string;
  type?: string;
  format?: string;
}

/** An OTLP metric attribute (label) value must be a bounded primitive. */
type LabelValue = string | number | boolean;

/** Sentinel a runtime-sourced label value collapses to when it is outside its allow-list. */
const OTHER_LABEL_VALUE = 'other';

/**
 * Per-key allow-lists of bounded VALUES for the labels whose values come from RUNTIME or
 * UNTRUSTED input — a thrown error's class name, a user-supplied `chat_type`.
 * Unlike code-literal labels (`status`/`op`/`reason`/`transport`/`type`, whose values are
 * string literals in our own source and thus inherently bounded), these could otherwise
 * carry unbounded distinct values. And because DELTA collection resets the SDK's
 * per-window cardinality cap on every flush, an unbounded value would accumulate unbounded
 * BACKEND series over time — the cap alone does NOT stop it. So any value outside its
 * allow-list collapses to `OTHER_LABEL_VALUE` here, at the source, before it can egress.
 *
 * `format` is canonicalized at its SOURCE (`normalizeAudioFormat` maps MIME/mixed-case to
 * a bare `AudioFormat` or `other`) — the domain logic that belongs with the audio module —
 * so the values that reach this guard are already bare extensions. Keeping it in the set
 * here is safe (no legitimate value is wrongly collapsed) and adds fail-closed defense in
 * depth for any future call site that forgets to canonicalize first.
 *
 * Deliberately NOT bounded here: `tool_name`/`server`/`model`/`language*`/`intent` are
 * operator-/catalog-scoped identifiers — they are the intended breakdown dimensions and
 * are bounded by CONFIGURATION (registered tools, configured servers), not by request
 * traffic. Clamping them to `other` would destroy the metric's purpose; the per-metric
 * series cap (`MAX_SERIES_PER_METRIC`) backstops them against a within-window blow-up.
 *
 * `error_name` is kept in sync with `src/utils/errors.ts` (+ common JS built-ins and the
 * Anthropic SDK error classes). A new error class not listed here degrades to `other`
 * rather than leaking cardinality — a safe, self-correcting default.
 */
const BOUNDED_LABEL_VALUES: Record<string, ReadonlySet<string>> = {
  chat_type: new Set(['private', 'group', 'supergroup']),
  format: new Set(['ogg', 'mp3', 'wav', 'webm', 'flac', 'm4a']),
  error_name: new Set([
    // AppError hierarchy (src/utils/errors.ts)
    'AppError',
    'AuthenticationError',
    'AuthorizationError',
    'ValidationError',
    'MCPError',
    'CodeExecutionError',
    'ClaudeAPIError',
    'TimeoutError',
    'MCPCallLimitError',
    'MCPRequestCallLimitError',
    'AudioTranscriptionError',
    'AudioSynthesisError',
    'MCPResponseTooLargeError',
    // JS built-ins
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'EvalError',
    'URIError',
    'AbortError',
    // Anthropic SDK error classes
    'APIError',
    'APIConnectionError',
    'APIConnectionTimeoutError',
    'APIUserAbortError',
    'BadRequestError',
    'RateLimitError',
    'InternalServerError',
    'NotFoundError',
    'PermissionDeniedError',
    'UnprocessableEntityError',
    'ConflictError',
  ]),
};

/** Clamp a runtime-sourced label value to its allow-list, else the `other` sentinel. */
function boundLabelValue(key: string, value: string): string {
  const allowed = BOUNDED_LABEL_VALUES[key];
  if (!allowed) return value;
  return allowed.has(value) ? value : OTHER_LABEL_VALUE;
}

/**
 * Reduce an arbitrary label bag to safe, bounded metric dimensions. FAILS CLOSED:
 * - a key not in `ALLOWED_LABEL_KEYS` is DROPPED entirely (never becomes a dimension);
 * - null/undefined values are dropped;
 * - a runtime-sourced string value outside its `BOUNDED_LABEL_VALUES` allow-list collapses
 *   to the `other` sentinel (bounds VALUE cardinality — the SDK series cap can't, under
 *   DELTA); other string values are truncated to `MAX_LABEL_VALUE_LENGTH`;
 * - number/boolean pass through; any other type is dropped (cannot be a bounded label).
 */
export function sanitizeMetricLabels(labels: MetricLabels): Record<string, LabelValue> {
  const safe: Record<string, LabelValue> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!ALLOWED_LABEL_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const truncated =
        value.length > MAX_LABEL_VALUE_LENGTH ? value.slice(0, MAX_LABEL_VALUE_LENGTH) : value;
      safe[key] = boundLabelValue(key, truncated);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
    // any other type (object/array/function) is intentionally dropped — not a bounded label
  }
  return safe;
}

// ── Fetch-based OTLP metrics exporter ────────────────────────────────────────

/**
 * Serializes collected metrics with the standard OTLP JSON transformer and POSTs them
 * to the collector over the RAW (un-instrumented) global fetch, so the metric export
 * itself is never turned into a trace span.
 *
 * Export failures are reported to `console.warn` and never re-enter the logging facade:
 * routing them back through `logger.*` could recurse and (post-cutover) itself emit a
 * metric to export. This mirrors the M2 logs exporter and otel-cf-workers' own span
 * exporter, both of which log export failures to `console` for the same reason.
 *
 * Reports DELTA temporality for every instrument (see the file header): each collect
 * carries only the increment since the previous flush.
 */
export class FetchMetricExporter implements PushMetricExporter {
  // `fetchFn` defaults to otel-cf-workers' RAW fetch (captured at its module load, so it
  // cannot be stubbed via globalThis); injectable purely so tests can supply a mock.
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = __unwrappedFetch
  ) {}

  export(
    resourceMetrics: ResourceMetrics,
    resultCallback: (result: { code: number; error?: Error }) => void
  ): void {
    let body: Uint8Array;
    try {
      const serialized = JsonMetricsSerializer.serializeRequest(resourceMetrics);
      if (!serialized) throw new Error('JsonMetricsSerializer produced no payload');
      body = serialized;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      console.warn(`otlp_metrics_serialize_failed: ${error.message}`);
      resultCallback({ code: 1, error }); // ExportResultCode.FAILED
      return;
    }

    // Detach the fetcher from `this` before calling. Invoking it as `this.fetchFn(...)`
    // sets the receiver to this exporter instance, which the Workers runtime rejects with
    // `TypeError: Illegal invocation` — native fetch must be called with a global/undefined
    // `this`. A bare call in strict ESM passes `this === undefined`, which fetch accepts.
    // The throw is synchronous (before the promise chain), so it must be caught here or it
    // escapes as a raw platform error, bypassing the `.catch` below and this handler's logs.
    const fetchFn = this.fetchFn;
    let responsePromise: Promise<Response>;
    try {
      responsePromise = fetchFn(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      console.warn(`otlp_metrics_export_error: ${error.message}`);
      resultCallback({ code: 1, error });
      return;
    }

    responsePromise
      .then((response) => {
        if (response.ok) {
          resultCallback({ code: 0 }); // ExportResultCode.SUCCESS
        } else {
          console.warn(`otlp_metrics_export_failed: HTTP ${response.status}`);
          resultCallback({
            code: 1,
            error: new Error(`OTLP metrics export HTTP ${response.status}`),
          });
        }
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));

        console.warn(`otlp_metrics_export_error: ${error.message}`);
        resultCallback({ code: 1, error });
      });
  }

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA;
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Timer-free reader ────────────────────────────────────────────────────────

/**
 * A `MetricReader` that never runs a background timer. The MeterProvider aggregates
 * measurements in memory; this reader drains them exactly once per invocation, when
 * `forceFlush()` is called at the request/DO boundary via `waitUntil` — the same
 * "drain once per invocation" model otel-cf-workers uses for spans and our logs stack
 * uses for records. Configured for DELTA temporality so each drain reports only the
 * increment since the previous one.
 */
export class PerInvocationMetricReader extends MetricReader {
  constructor(private readonly exporter: PushMetricExporter) {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.DELTA,
      // Hard cardinality cap per metric — see MAX_SERIES_PER_METRIC. Makes unbounded
      // time series structurally impossible: overflow folds into one overflow series.
      cardinalitySelector: () => MAX_SERIES_PER_METRIC,
    });
  }

  /**
   * Collect the aggregated metrics and hand them to the exporter. No-op (no POST) when
   * nothing was recorded since the last flush, so an idle request does not emit an empty
   * payload. Never throws — a telemetry failure must not break the request.
   */
  protected async onForceFlush(): Promise<void> {
    const { resourceMetrics, errors } = await this.collect();
    if (errors.length > 0) {
      console.warn(`otlp_metrics_collect_failed: ${errors.length} collection error(s)`);
    }
    const hasData = resourceMetrics.scopeMetrics.some((scope) =>
      scope.metrics.some((metric) => metric.dataPoints.length > 0)
    );
    if (!hasData) return;
    await new Promise<void>((resolve) => {
      this.exporter.export(resourceMetrics, () => resolve());
    });
  }

  protected async onShutdown(): Promise<void> {
    await this.exporter.shutdown();
  }
}

// ── Module singletons (one metrics stack per isolate) ────────────────────────
let moduleMeter: Meter | null = null;
let moduleProvider: MeterProvider | null = null;
const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

/**
 * When a truthy value is present in this async context, `countMetric`/`recordMetric` are
 * no-ops. Used to disable metric recording inside the DO `alarm()` handler: the module
 * meter may already be live (stood up by a PRIOR fetch on a warm/shared isolate), but an
 * alarm context cannot export (Cloudflare 1003) and there is NO backstop for custom
 * metrics — so recording there would only strand unexportable DELTAs that are lost on a
 * quiet eviction. Scoping via AsyncLocalStorage (not a module flag) is essential: an alarm
 * can run while a prior fetch's background work is still emitting on the same isolate, and
 * only the alarm's own async call tree must be suppressed — never the concurrent fetch.
 */
const metricSuppression = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` (and its entire async call tree) with metric recording suppressed. Logs are
 * unaffected — they have the tail worker's console-forwarding backstop; metrics do not.
 */
export function runWithMetricsSuppressed<T>(fn: () => T): T {
  return metricSuppression.run(true, fn);
}

/** Lazily create + cache a counter by name (idempotent within an isolate). */
function getCounter(name: string): Counter | null {
  const meter = moduleMeter;
  if (!meter) return null;
  let counter = counters.get(name);
  if (!counter) {
    counter = meter.createCounter(name);
    counters.set(name, counter);
  }
  return counter;
}

/** Lazily create + cache a histogram by name (idempotent within an isolate). */
function getHistogram(name: string): Histogram | null {
  const meter = moduleMeter;
  if (!meter) return null;
  let histogram = histograms.get(name);
  if (!histogram) {
    histogram = meter.createHistogram(name);
    histograms.set(name, histogram);
  }
  return histogram;
}

/**
 * Increment a counter by 1 (or `value`) with bounded labels. No-op when telemetry is
 * disabled. Labels are sanitized FAIL-CLOSED (see `sanitizeMetricLabels`) so no
 * unbounded/content-bearing dimension can leak. Never throws — a metrics failure must
 * not break the request path.
 */
export function countMetric(name: string, labels: MetricLabels = {}, value = 1): void {
  if (metricSuppression.getStore()) return;
  const counter = getCounter(name);
  if (!counter) return;
  try {
    counter.add(value, sanitizeMetricLabels(labels));
  } catch (err) {
    console.warn(`otlp_metric_count_failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Record a histogram observation (e.g. a duration in ms) with bounded labels. No-op
 * when telemetry is disabled. Same fail-closed label sanitization and non-throwing
 * contract as {@link countMetric}.
 */
export function recordMetric(name: string, value: number, labels: MetricLabels = {}): void {
  if (metricSuppression.getStore()) return;
  const histogram = getHistogram(name);
  if (!histogram) return;
  try {
    histogram.record(value, sanitizeMetricLabels(labels));
  } catch (err) {
    console.warn(`otlp_metric_record_failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Idempotently stand up the metrics stack for this isolate. A genuine no-op when
 * telemetry is disabled (no provider, no meter, all emit helpers short-circuit), so
 * the console.log path runs alone during the parallel bake.
 */
export function initMetricTelemetry(env: Env, options?: { fetchFn?: typeof fetch }): void {
  if (moduleMeter || !isTelemetryEnabled(env)) return;

  const exporter = new FetchMetricExporter(
    metricsEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT as string),
    env.OTEL_COLLECTOR_TOKEN as string,
    options?.fetchFn
  );
  const reader = new PerInvocationMetricReader(exporter);
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': TELEMETRY_SERVICE_NAME,
      'service.namespace': env.ENVIRONMENT,
      'service.version': APP_VERSION,
    }),
    readers: [reader],
  });

  moduleProvider = provider;
  moduleMeter = provider.getMeter(METRIC_SCOPE_NAME, APP_VERSION);
}

/**
 * Flush this isolate's aggregated metrics at a request/DO boundary. Pass the ambient
 * `waitUntil` (Hono `c.executionCtx.waitUntil` or `DurableObjectState.waitUntil`) so
 * the collect+export runs without blocking the response. No-op when disabled.
 */
export function flushMetricTelemetry(waitUntil: (promise: Promise<unknown>) => void): void {
  const provider = moduleProvider;
  if (!provider) return;
  waitUntil(provider.forceFlush());
}

/** Test-only: reset module singletons and instrument caches between cases. */
export function resetMetricTelemetryForTests(): void {
  moduleMeter = null;
  moduleProvider = null;
  counters.clear();
  histograms.clear();
}
