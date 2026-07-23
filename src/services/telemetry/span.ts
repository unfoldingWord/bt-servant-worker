/**
 * Manual spans over the NON-fetch seams (M3).
 *
 * otel-cf-workers `instrument()`/`instrumentDO()` already auto-span every outbound
 * `fetch` and the request/DO root. `withSpan` covers what is NOT a fetch — the
 * orchestration loop, code-execution phases, DO lifecycle, and binding I/O
 * (KV/R2/Workers AI/DO storage/memory) — so a request produces a full span TREE
 * instead of a root with a few fetch children and a black box in between.
 *
 * Redaction posture (identical to the M2 logs path, by construction):
 * - Attribute VALUES go through the shared FAIL-CLOSED classifier
 *   (`buildSafeAttributes` in `redact.ts`) — the same policy that guards log egress,
 *   so spans cannot leak content a log wouldn't.
 * - Span NAMES are the caller's responsibility and MUST be static/bounded — never
 *   interpolate a user id, tool result, file key, or message into a name.
 * - On throw we record ONLY `error_name` (the bounded error class) and `status=error`
 *   with NO message. We deliberately do NOT call `span.recordException`, which would
 *   write `exception.message`/`exception.stacktrace` — untrusted upstream text (e.g.
 *   an MCPError's remote message), the exact leak M2 fought. (`redactSpan` also strips
 *   those attributes at export as defense in depth.)
 *
 * No-op when telemetry is disabled: `instrument()` still registers a tracer provider
 * but with a 0% head sampler + no-op exporter, so `startActiveSpan` yields a
 * non-recording span — `setAttribute`/`setStatus` do nothing and nothing egresses.
 * Spans auto-nest under the active request/DO root and auto-flush at the boundary via
 * the library's processor; there is no separate flush wiring here.
 */
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { APP_VERSION } from '../../generated/version.js';
import { TELEMETRY_SERVICE_NAME } from './config.js';
import { buildSafeAttributes } from './redact.js';

/**
 * Record an error on a span without leaking content: only the bounded error class
 * (`error_name`) and an unmessaged error status. Never the raw message/stack.
 *
 * `withSpan`/`withSpanSync` call this automatically when `fn` throws. Call it
 * directly at a seam that CATCHES and handles an error (so nothing is thrown) but
 * the span should still reflect the failure — e.g. a tool dispatch that turns a tool
 * error into an error result for the model rather than propagating it.
 */
export function recordSpanError(span: Span, err: unknown): void {
  span.setAttribute('error_name', err instanceof Error ? err.name : 'Error');
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Fetch the tracer per call, NOT at module load: the global tracer provider is
 * registered by `instrument()`/`instrumentDO()` per invocation, so a module-scope
 * `getTracer()` would capture the no-op default that exists before the first
 * request. `getTracer` is cheap.
 */
function tracer() {
  return trace.getTracer(TELEMETRY_SERVICE_NAME, APP_VERSION);
}

/**
 * Wrap an async seam in a child span. The span auto-nests under the active
 * request/DO span, records exceptions as `status=error` + `error_name` (re-throwing,
 * never swallowing), and always ends. `name` MUST be a static string.
 */
export function withSpan<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    span.setAttributes(buildSafeAttributes(attrs));
    try {
      return await fn(span);
    } catch (err) {
      recordSpanError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Synchronous twin of {@link withSpan} for pure-compute seams (e.g. rate-limit
 * checks) so wrapping them in a span does not force the call site to become async.
 */
export function withSpanSync<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: (span: Span) => T
): T {
  return tracer().startActiveSpan(name, (span) => {
    span.setAttributes(buildSafeAttributes(attrs));
    try {
      return fn(span);
    } catch (err) {
      recordSpanError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}
