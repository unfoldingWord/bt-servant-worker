/**
 * OpenTelemetry configuration for the worker (M1: traces from the worker context).
 *
 * Telemetry is ADDITIVE and feature-flagged: it is a genuine no-op unless BOTH
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_COLLECTOR_TOKEN` are set. When either is
 * missing, `resolveTelemetryConfig` returns a config whose exporter is a no-op that
 * makes no network call at all (see NOOP_EXPORTER) — so the existing console.log →
 * Workers Observability path keeps running alone during the parallel bake, and
 * rollback is simply unsetting the secret.
 *
 * Governance: no message content, precise location, or identifier egresses. The
 * auto fetch/request instrumentation records URL attributes that can carry
 * user/chat/thread ids and signed webhook/MCP query credentials, so `redactSpans`
 * reduces every URL attribute to scheme://host and drops path/query at source,
 * before export (defense-in-depth on top of the collector's redaction).
 */
import type { ExporterConfig, PostProcessorFn, ResolveConfigFn } from '@microlabs/otel-cf-workers';
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

/**
 * Strip identifiers/credentials from span attributes before export. The auto
 * fetch + request instrumentation records `url.full`/`url.path`/`url.query` (and
 * `http.url` on cache spans), any of which can leak user/chat/thread ids or signed
 * webhook/MCP query tokens. Reduce URL attributes to scheme://host and drop
 * path/query outright. Span names are already host-only (`fetch <METHOD> <host>`),
 * so no name scrubbing is required.
 */
const redactSpans: PostProcessorFn = (spans) => {
  for (const span of spans) {
    const attrs = span.attributes as Record<string, unknown>;
    const full = toOrigin(attrs['url.full']);
    if (full !== undefined) attrs['url.full'] = full;
    const httpUrl = toOrigin(attrs['http.url']);
    if (httpUrl !== undefined) attrs['http.url'] = httpUrl;
    delete attrs['url.path'];
    delete attrs['url.query'];
    delete attrs['http.target'];
  }
  return spans;
};

/**
 * A SpanExporter that drops every span without any network call. Used on the
 * disabled path so telemetry is a guaranteed no-op: a 0% head sampler alone is
 * NOT enough because otel-cf-workers' default tail sampler still exports
 * root-error spans, and a sampled remote parent still samples — either of which
 * would otherwise POST to the collector endpoint. A no-op exporter cannot emit.
 */
const NOOP_EXPORTER = {
  export(_spans: unknown, resultCallback: (result: { code: number }) => void): void {
    resultCallback({ code: 0 }); // ExportResultCode.SUCCESS — report success, export nothing
  },
  shutdown(): Promise<void> {
    return Promise.resolve();
  },
  forceFlush(): Promise<void> {
    return Promise.resolve();
  },
} as unknown as ExporterConfig;

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
      postProcessor: redactSpans,
    };
  }

  return {
    service,
    exporter: {
      url: tracesEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT as string),
      headers: { Authorization: `Bearer ${env.OTEL_COLLECTOR_TOKEN as string}` },
    },
    postProcessor: redactSpans,
  };
};
