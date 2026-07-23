/**
 * OpenTelemetry configuration for the worker (M1: traces from the worker context).
 *
 * Telemetry is ADDITIVE and feature-flagged: it is a genuine no-op unless BOTH
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_COLLECTOR_TOKEN` are set. When either is
 * missing, `resolveTelemetryConfig` returns a config whose exporter is a no-op that
 * makes no network call at all, and that neither accepts nor propagates trace
 * context — so the console.log → Workers Observability path keeps running alone
 * during the parallel bake, and rollback is simply unsetting the secret.
 *
 * Governance: no message content, precise location, or identifier egresses.
 * Redaction runs inside the exporter (`RedactingSpanExporter`) because rc.52 never
 * invokes the `postProcessor` config hook — it must run at real export time.
 */
import { OTLPExporter } from '@microlabs/otel-cf-workers';
import type {
  ExporterConfig,
  OTLPExporterConfig,
  ResolveConfigFn,
} from '@microlabs/otel-cf-workers';
import { Env } from '../../config/types.js';
import { APP_VERSION } from '../../generated/version.js';

/** Stable service.name reported to the collector for every signal. */
export const TELEMETRY_SERVICE_NAME = 'bt-servant-worker';

/**
 * Telemetry egresses only when an OTLP endpoint AND a collector token are both
 * configured. Either one unset ⇒ disabled (no-op).
 */
export function isTelemetryEnabled(env: Env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT && env.OTEL_COLLECTOR_TOKEN);
}

/** Build the OTLP/HTTP traces URL from the collector's base endpoint. */
function tracesEndpoint(base: string): string {
  return `${base.replace(/\/+$/, '')}/v1/traces`;
}

/** Reduce a URL-valued attribute to its origin (scheme://host); undefined if not a URL. */
function toOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/** A span carries a mutable name + attributes at runtime (otel-cf-workers SpanImpl). */
type MutableSpan = { name: string; attributes: Record<string, unknown> };

/**
 * Redact identifiers/credentials from a span in place, at export time.
 *
 * - URL attributes (`url.full`/`http.url`) → scheme://host; `url.path`/`url.query`/
 *   `http.target` dropped. These can carry user/chat/thread ids and signed
 *   webhook/MCP query credentials.
 * - Durable Object ids are derived from the user identifier
 *   (`idFromName("user:<org>:<user_id>")`), which rc.52 puts into the DO span NAME
 *   (`Durable Object Fetch <name>` / `... Alarm <name>`) and the `do.id`/`do.name`/
 *   `do.id.name` attributes. Drop those attributes and strip the name suffix.
 * - KV operations are keyed by the org/tenant identifier (e.g. `ORG_CONFIG.get(org)`),
 *   which rc.52 records in `db.statement` ("get <org>") and `db.cf.kv.key`. Drop both;
 *   `db.name` (binding) and `db.operation` remain for tracing. (R2 and Workers AI are
 *   NOT instrumented by the library, so message content / audio keys never egress.)
 * - `exception.message`/`exception.stacktrace` (written by `span.recordException`)
 *   embed untrusted upstream text (e.g. an MCPError's remote message) — the same leak
 *   the log path guards by exporting only `error_name`. Our `withSpan` records only the
 *   bounded `error_name`, never `recordException`; dropping these here is defense in
 *   depth against any manual/library `recordException`. `exception.type` (the error
 *   class) is bounded and kept.
 *
 * Span names for the request root (`fetchHandler <METHOD>`), outbound fetch
 * (`fetch <METHOD> <host>`), and KV (`KV <binding> <op>`) are already identifier-free.
 */
export function redactSpan(span: MutableSpan): void {
  const attrs = span.attributes;
  const full = toOrigin(attrs['url.full']);
  if (full !== undefined) attrs['url.full'] = full;
  const httpUrl = toOrigin(attrs['http.url']);
  if (httpUrl !== undefined) attrs['http.url'] = httpUrl;
  delete attrs['url.path'];
  delete attrs['url.query'];
  delete attrs['http.target'];
  delete attrs['do.id'];
  delete attrs['do.name'];
  delete attrs['do.id.name'];
  delete attrs['db.statement'];
  delete attrs['db.cf.kv.key'];
  delete attrs['exception.message'];
  delete attrs['exception.stacktrace'];
  if (span.name.startsWith('Durable Object Fetch ')) {
    span.name = 'Durable Object Fetch';
  } else if (span.name.startsWith('Durable Object Alarm ')) {
    span.name = 'Durable Object Alarm';
  }
}

/** OTLP exporter config (collector URL + bearer header). Exported for testing. */
export function otlpExporterConfig(env: Env): OTLPExporterConfig {
  return {
    url: tracesEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT as string),
    headers: { Authorization: `Bearer ${env.OTEL_COLLECTOR_TOKEN as string}` },
  };
}

/**
 * Wraps the library's OTLPExporter and redacts every span at export time. This is
 * the only place redaction reliably runs in rc.52: the `postProcessor` config hook
 * is accepted but never invoked, so redacting there would be dead code.
 */
class RedactingSpanExporter {
  private readonly inner: OTLPExporter;
  constructor(config: OTLPExporterConfig) {
    this.inner = new OTLPExporter(config);
  }
  export(spans: unknown[], resultCallback: (result: { code: number }) => void): void {
    for (const span of spans) {
      redactSpan(span as MutableSpan);
    }
    this.inner.export(spans, resultCallback);
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/**
 * A SpanExporter that drops every span without any network call. Used on the
 * disabled path so telemetry is a guaranteed no-op: a 0% head sampler alone is NOT
 * enough because otel-cf-workers' default tail sampler still exports root-error
 * spans and a sampled remote parent still samples. A no-op exporter cannot emit.
 */
const NOOP_EXPORTER = {
  export(_spans: unknown, resultCallback: (result: { code: number }) => void): void {
    resultCallback({ code: 0 }); // ExportResultCode.SUCCESS — report success, export nothing
  },
  shutdown(): Promise<void> {
    return Promise.resolve();
  },
} as unknown as ExporterConfig;

/**
 * Never accept trace context from callers, and never inject `traceparent` into
 * outbound requests. Each invocation is a fresh local root (no external trace
 * injection), and our trace ids never propagate to third-party services
 * (Anthropic / MCP / OpenAI). Applied in BOTH states, so the disabled path also
 * stops accepting/propagating context, not just exporting.
 */
const NO_TRACE_CONTEXT_PROPAGATION = {
  fetch: { includeTraceContext: false },
  handlers: { fetch: { acceptTraceContext: false } },
};

/**
 * Resolved per invocation by instrument()/instrumentDO(). Returns a valid
 * TraceConfig in both states; when disabled the no-op exporter guarantees nothing
 * egresses regardless of head/tail sampling or a sampled remote parent.
 */
export const resolveTelemetryConfig: ResolveConfigFn<Env> = (env) => {
  const service = {
    name: TELEMETRY_SERVICE_NAME,
    namespace: env.ENVIRONMENT,
    version: APP_VERSION,
  };

  if (!isTelemetryEnabled(env)) {
    return {
      service,
      exporter: NOOP_EXPORTER,
      // Skip recording where possible; the no-op exporter is the real guarantee.
      sampling: { headSampler: { ratio: 0 } },
      ...NO_TRACE_CONTEXT_PROPAGATION,
    };
  }

  return {
    service,
    exporter: new RedactingSpanExporter(otlpExporterConfig(env)) as unknown as ExporterConfig,
    ...NO_TRACE_CONTEXT_PROPAGATION,
  };
};
