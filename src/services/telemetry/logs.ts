/**
 * OTLP logs pipeline (M2): tee the existing structured `logger.*` call sites to
 * OpenTelemetry logs, trace-correlated, additive to the console.log path.
 *
 * Why this file exists at all: `@microlabs/otel-cf-workers` is traces-only, and
 * the stock `@opentelemetry/exporter-logs-otlp-http` cannot run in a Worker (its
 * transports use XHR/sendBeacon/node:http, none of which exist here). So we run
 * our own minimal logs stack:
 *   - a `LoggerProvider` (SDK) with a service resource matching the M1 spans,
 *   - a TIMER-FREE buffering processor (the Workers runtime has no reliable
 *     background timers, so we never rely on a scheduled flush — records buffer
 *     and drain once at the request/DO boundary via `waitUntil`, exactly how
 *     otel-cf-workers flushes spans),
 *   - a fetch-based exporter that serializes with `@opentelemetry/otlp-transformer`
 *     (`JsonLogsSerializer`) and POSTs via otel-cf-workers' `__unwrappedFetch`
 *     (the RAW global fetch, so our own log export is not itself re-traced).
 *
 * Governance (same posture as M1 traces): telemetry is a genuine no-op unless the
 * endpoint + token are both set. Redaction happens at SOURCE (attributes are built
 * from already-summarized log data and sensitive KEYS are masked here) and again in
 * the exporter (defense in depth); the collector applies a third pass. No message
 * content or precise location egresses. Identifiers (`request_id`, `user_id`) ARE
 * kept — they are the correlation keys the existing logs already carry and are what
 * makes a support report ("it broke for this user") debuggable; they are opaque ids,
 * not content or location.
 *
 * Trace correlation is automatic: the SDK `Logger.emit` reads `context.active()`,
 * and otel-cf-workers installs the global AsyncLocalStorage context manager, so a
 * record emitted inside a request inherits that request's trace_id/span_id.
 */
import { SeverityNumber, type Logger } from '@opentelemetry/api-logs';
import {
  LoggerProvider,
  type LogRecord,
  type LogRecordExporter,
  type LogRecordProcessor,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer';
import { __unwrappedFetch } from '@microlabs/otel-cf-workers';
import { Env } from '../../config/types.js';
import { APP_VERSION } from '../../generated/version.js';
import {
  summarizeArgs,
  SENSITIVE_KEY_PATTERN,
  setLogSink,
  type LogEntry,
  type LogLevel,
} from '../../utils/logger.js';
import { isTelemetryEnabled, TELEMETRY_SERVICE_NAME } from './config.js';

/** Instrumentation scope name reported for every emitted log record. */
const LOG_SCOPE_NAME = TELEMETRY_SERVICE_NAME;

/** Build the OTLP/HTTP logs URL from the collector's base endpoint. */
function logsEndpoint(base: string): string {
  return `${base.replace(/\/+$/, '')}/v1/logs`;
}

/** Map our three log levels onto OTLP severities. */
function severityFor(level: LogLevel): { number: SeverityNumber; text: string } {
  switch (level) {
    case 'warn':
      return { number: SeverityNumber.WARN, text: 'WARN' };
    case 'error':
      return { number: SeverityNumber.ERROR, text: 'ERROR' };
    case 'info':
    default:
      return { number: SeverityNumber.INFO, text: 'INFO' };
  }
}

/** An OTLP attribute value must be a primitive; nested data is JSON-encoded. */
type AttributeValue = string | number | boolean;

/**
 * Allow-list of string-valued attribute keys that may egress with their RAW
 * value. These are bounded structural identifiers / enums, never message content
 * or precise location. Anything NOT here is summarized to its length instead —
 * the policy fails CLOSED so a content-bearing field under a new/innocuous key
 * (e.g. `response`, `text_preview`, `user_message`) can never leak by default.
 *
 * `error`/`stack` are included as debugging-essential (truncated); they are the
 * one allow-listed pair that could conceivably echo user input, accepted as a
 * deliberate trade-off for error observability.
 */
const SAFE_STRING_ATTRIBUTE_KEYS = new Set<string>([
  'request_id',
  'user_id',
  'event',
  'org',
  'organization',
  'environment',
  'region',
  'transport',
  'chat_type',
  'chat_id',
  'thread_id',
  'client_id',
  'message_id',
  'message_type',
  'intent',
  'language',
  'source_language',
  'target_language',
  'response_language',
  'book',
  'chapter',
  'verse',
  'reference',
  'model',
  'tool',
  'tool_name',
  'server',
  'server_id',
  'server_name',
  'job_id',
  'bucket',
  'mode',
  'mode_name',
  'status',
  'status_code',
  'state',
  'phase',
  'step',
  'stage',
  'reason',
  'error',
  'error_type',
  'stack',
  'type',
  'action',
  'operation',
  'method',
  'format',
  'audio_format',
  'original_format',
  'direction',
  'kind',
  'level',
  'name',
  'version',
  'code',
]);

/** Key suffixes whose string values are structural ids/enums/paths, not content. */
const SAFE_STRING_KEY_SUFFIXES = [
  '_id',
  '_ids',
  '_type',
  '_status',
  '_code',
  '_format',
  '_reason',
  '_mode',
  '_language',
  '_phase',
  '_state',
  '_key',
  '_name',
  '_kind',
];

/** Cap allow-listed string values so an unexpectedly large one cannot bloat egress. */
const MAX_ATTRIBUTE_STRING_LENGTH = 512;

function isSafeStringKey(key: string): boolean {
  if (SAFE_STRING_ATTRIBUTE_KEYS.has(key)) return true;
  return SAFE_STRING_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/** Reduce an http(s) URL to `scheme://host`; undefined if the value is not such a URL. */
function urlToOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function truncateAttribute(value: string): string {
  return value.length <= MAX_ATTRIBUTE_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH)} [truncated, ${value.length} chars]`;
}

/**
 * Classify a single log value into a safe OTLP attribute under the FAIL-CLOSED
 * policy (see `buildLogAttributes`).
 * - sensitive-named key → `[REDACTED]`.
 * - number / boolean → raw (never content).
 * - http(s) URL string → origin only (drops path + signed query creds), any key.
 * - other string → raw (truncated) only if the key is allow-listed, else `string(<len>)`.
 * - object / array → keys+types summary, never nested raw values.
 */
function attributeValueFor(key: string, value: unknown): AttributeValue {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const origin = urlToOrigin(value);
    if (origin !== undefined) return origin;
    if (isSafeStringKey(key)) return truncateAttribute(value);
    // Unknown string key ⇒ potential message content ⇒ never egress the value.
    return `string(${value.length})`;
  }
  // Objects/arrays: keys+types only, never nested raw values.
  return JSON.stringify(summarizeArgs(value));
}

/**
 * Turn a `LogEntry` into flat OTLP log attributes under a FAIL-CLOSED policy, so
 * no message content or precise location egresses even though call sites log rich
 * data. `event`/`timestamp` are lifted onto the record elsewhere and skipped here;
 * null/undefined are dropped. Each remaining value is classified by
 * `attributeValueFor`.
 */
export function buildLogAttributes(entry: LogEntry): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'event' || key === 'timestamp') continue;
    if (value === undefined || value === null) continue;
    attributes[key] = attributeValueFor(key, value);
  }
  return attributes;
}

/** A readable log record with a mutable attribute bag (SDK LogRecord at runtime). */
type MutableLogRecord = { attributes: Record<string, unknown> };

/**
 * Exporter-side defense in depth: mask any sensitive-keyed attribute that slipped
 * through source redaction, in place, before serialization. Mirrors `redactSpan`
 * in config.ts. Source redaction (`buildLogAttributes`) is the primary guarantee.
 */
export function redactLogRecord(record: ReadableLogRecord): void {
  const attrs = (record as MutableLogRecord).attributes;
  if (!attrs) return;
  for (const key of Object.keys(attrs)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) attrs[key] = '[REDACTED]';
  }
}

/**
 * Serializes finished log records with the standard OTLP JSON transformer and
 * POSTs them to the collector over the RAW (un-instrumented) global fetch, so the
 * log export itself is never turned into a trace span. Redacts each record first.
 *
 * Export failures are reported to `console.warn` and never re-enter the logging
 * facade: routing them back through `logger.*` would recurse (a failed log export
 * emitting another log to export). This is the rare, documented case where the
 * structured logger cannot be used — the analogous span path in otel-cf-workers
 * logs its export failures to `console` for the same reason.
 */
export class FetchLogExporter implements LogRecordExporter {
  // `fetchFn` defaults to otel-cf-workers' RAW fetch (a reference captured at its
  // module load, so it cannot be stubbed via globalThis); it is injectable purely
  // so tests can supply a mock. Production always uses the default.
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = __unwrappedFetch
  ) {}

  export(
    records: ReadableLogRecord[],
    resultCallback: (result: { code: number; error?: Error }) => void
  ): void {
    let body: Uint8Array;
    try {
      for (const record of records) redactLogRecord(record);
      const serialized = JsonLogsSerializer.serializeRequest(records);
      if (!serialized) throw new Error('JsonLogsSerializer produced no payload');
      body = serialized;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      console.warn(`otlp_logs_serialize_failed: ${error.message}`);
      resultCallback({ code: 1, error }); // ExportResultCode.FAILED
      return;
    }

    this.fetchFn(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body,
    })
      .then((response) => {
        if (response.ok) {
          resultCallback({ code: 0 }); // ExportResultCode.SUCCESS
        } else {
          console.warn(`otlp_logs_export_failed: HTTP ${response.status}`);
          resultCallback({ code: 1, error: new Error(`OTLP logs export HTTP ${response.status}`) });
        }
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));

        console.warn(`otlp_logs_export_error: ${error.message}`);
        resultCallback({ code: 1, error });
      });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Timer-free log processor: buffers records and only exports on `forceFlush`.
 * The Workers runtime cannot be trusted to run a scheduled batch timer between
 * requests (and a timer firing outside a request context could not fetch), so
 * we drain exactly once per invocation at the request/DO boundary — the same
 * model otel-cf-workers uses for spans.
 */
export class BufferingLogRecordProcessor implements LogRecordProcessor {
  private buffer: ReadableLogRecord[] = [];

  constructor(private readonly exporter: LogRecordExporter) {}

  onEmit(logRecord: LogRecord): void {
    // The SDK's mutable LogRecord is a ReadableLogRecord at read time; the cast
    // bridges exactOptionalPropertyTypes' stricter optional handling.
    this.buffer.push(logRecord as unknown as ReadableLogRecord);
  }

  forceFlush(): Promise<void> {
    if (this.buffer.length === 0) return Promise.resolve();
    const batch = this.buffer;
    this.buffer = [];
    return new Promise<void>((resolve) => {
      this.exporter.export(batch, () => resolve());
    });
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    await this.exporter.shutdown();
  }
}

// ── Module singletons (one logs stack per isolate) ───────────────────────────
let moduleLogger: Logger | null = null;
let moduleProcessor: BufferingLogRecordProcessor | null = null;

/**
 * The sink registered into logger.ts. Builds a trace-correlated OTLP log record
 * from each structured log entry. Never throws — a telemetry failure must not
 * break the console.log path.
 */
function emitLog(level: LogLevel, entry: LogEntry): void {
  const logger = moduleLogger;
  if (!logger) return;
  try {
    const severity = severityFor(level);
    logger.emit({
      severityNumber: severity.number,
      severityText: severity.text,
      body: entry.event,
      attributes: buildLogAttributes(entry),
      timestamp: entry.timestamp,
    });
  } catch (err) {
    console.warn(`otlp_log_emit_failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Idempotently stand up the logs stack for this isolate and register the sink.
 * A genuine no-op (and the sink stays unregistered) when telemetry is disabled,
 * so the console.log path runs alone during the parallel bake.
 */
export function initLogTelemetry(env: Env, options?: { fetchFn?: typeof fetch }): void {
  if (moduleLogger || !isTelemetryEnabled(env)) return;

  const exporter = new FetchLogExporter(
    logsEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT as string),
    env.OTEL_COLLECTOR_TOKEN as string,
    options?.fetchFn
  );
  const processor = new BufferingLogRecordProcessor(exporter);
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': TELEMETRY_SERVICE_NAME,
      'service.namespace': env.ENVIRONMENT,
      'service.version': APP_VERSION,
    }),
  });
  provider.addLogRecordProcessor(processor);

  moduleProcessor = processor;
  moduleLogger = provider.getLogger(LOG_SCOPE_NAME, APP_VERSION);
  setLogSink(emitLog);
}

/**
 * Flush this isolate's buffered log records at a request/DO boundary. Pass the
 * ambient `waitUntil` (Hono `c.executionCtx.waitUntil` or `DurableObjectState.
 * waitUntil`) so the export runs without blocking the response. No-op when
 * telemetry is disabled.
 */
export function flushLogTelemetry(waitUntil: (promise: Promise<unknown>) => void): void {
  const processor = moduleProcessor;
  if (!processor) return;
  waitUntil(processor.forceFlush());
}

/** Test-only: reset module singletons and clear the sink between cases. */
export function resetLogTelemetryForTests(): void {
  moduleLogger = null;
  moduleProcessor = null;
  setLogSink(null);
}
