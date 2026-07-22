/**
 * Telemetry module (onion layer): may import types/ and utils/; imported by the
 * composition root (src/index.ts) to wrap the worker handler and Durable Object.
 */
export { isTelemetryEnabled, resolveTelemetryConfig, TELEMETRY_SERVICE_NAME } from './config.js';
