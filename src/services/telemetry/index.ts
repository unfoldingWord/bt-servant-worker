/**
 * Telemetry module (onion layer): may import types/ and utils/; imported by the
 * composition root (src/index.ts) to wrap the worker handler and Durable Object.
 */
export { isTelemetryEnabled, resolveTelemetryConfig, TELEMETRY_SERVICE_NAME } from './config.js';
export { initLogTelemetry, flushLogTelemetry } from './logs.js';
export {
  initMetricTelemetry,
  flushMetricTelemetry,
  countMetric,
  recordMetric,
  type MetricLabels,
} from './metrics.js';
export { withSpan, withSpanSync, recordSpanError } from './span.js';
export type { Span } from '@opentelemetry/api';
