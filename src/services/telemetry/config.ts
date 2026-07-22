/**
 * OpenTelemetry configuration for the worker (M1: traces from the worker context).
 *
 * Telemetry is ADDITIVE and feature-flagged: it is a genuine no-op unless BOTH
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_COLLECTOR_TOKEN` are set. When either is
 * missing, `resolveTelemetryConfig` returns a valid config whose head sampler is
 * 0% — no spans are recorded and nothing egresses — so the existing console.log →
 * Workers Observability path keeps running alone during the parallel bake, and
 * rollback is simply unsetting the secret.
 *
 * No message content or precise location is ever placed on a span here; the span
 * tree is structural (request → outbound fetch hops). Source-level attribute
 * redaction arrives with the M2 logger facade swap.
 */
import type { ResolveConfigFn } from '@microlabs/otel-cf-workers';
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

/**
 * Resolved per invocation by instrument()/instrumentDO(). Returns a valid
 * TraceConfig in both states; when disabled the 0% head sampler drops every span
 * before export, so the placeholder exporter URL is never contacted.
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
      // Never contacted: the 0% head sampler below drops every span pre-export.
      exporter: { url: 'http://localhost:4318/v1/traces' },
      sampling: { headSampler: { ratio: 0 } },
    };
  }

  return {
    service,
    exporter: {
      url: tracesEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT as string),
      headers: { Authorization: `Bearer ${env.OTEL_COLLECTOR_TOKEN as string}` },
    },
  };
};
