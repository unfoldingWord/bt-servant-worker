/**
 * Structured logging utilities for Cloudflare Workers
 * Uses console.log with JSON for Workers Logs integration
 */

export interface LogEntry {
  event: string;
  request_id: string;
  timestamp: number;
  user_id?: string | undefined;
  [key: string]: unknown;
}

function buildLogEntry(
  requestId: string,
  userId: string | undefined,
  event: string,
  data: Record<string, unknown>
): LogEntry {
  const entry: LogEntry = {
    event,
    request_id: requestId,
    timestamp: Date.now(),
    ...data,
  };
  if (userId !== undefined) {
    entry.user_id = userId;
  }
  return entry;
}

// ── Optional log sink (dependency-injected by the telemetry layer) ───────────
// M2 tees every structured log to OTLP logs. To keep this util a pure, zero-
// service-dependency module (and to categorically avoid a logger↔telemetry
// import cycle), telemetry registers its emitter here via `setLogSink` instead
// of logger importing telemetry. When no sink is registered (endpoint unset, or
// in tests) logging is exactly the prior console-only behavior.
export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, entry: LogEntry) => void;

let logSink: LogSink | null = null;

/**
 * Register (or clear, with `null`) the OTLP log sink. The sink MUST NOT throw —
 * it is invoked on the hot logging path and any failure must stay inside the
 * telemetry layer, never break console logging.
 */
export function setLogSink(sink: LogSink | null): void {
  logSink = sink;
}

export function log(entry: LogEntry): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
  logSink?.('info', entry);
}

export function logInfo(entry: LogEntry): void {
  // eslint-disable-next-line no-console
  console.info(JSON.stringify(entry));
  logSink?.('info', entry);
}

export function logWarn(entry: LogEntry): void {
  console.warn(JSON.stringify(entry));
  logSink?.('warn', entry);
}

export function logError(entry: LogEntry & { error: string; stack?: string | undefined }): void {
  console.error(JSON.stringify(entry));
  logSink?.('error', entry);
}

/**
 * Create a logger scoped to a request
 */
export function createRequestLogger(requestId: string, userId?: string) {
  return {
    log: (event: string, data: Record<string, unknown> = {}) =>
      log(buildLogEntry(requestId, userId, event, data)),

    info: (event: string, data: Record<string, unknown> = {}) =>
      logInfo(buildLogEntry(requestId, userId, event, data)),

    warn: (event: string, data: Record<string, unknown> = {}) =>
      logWarn(buildLogEntry(requestId, userId, event, data)),

    error: (event: string, err: unknown, data: Record<string, unknown> = {}) => {
      const entry = buildLogEntry(requestId, userId, event, data);
      const errorEntry = entry as LogEntry & {
        error: string;
        stack?: string | undefined;
      };
      errorEntry.error = err instanceof Error ? err.message : String(err);
      if (err instanceof Error) {
        // The error CLASS name is a bounded, vetted signal (e.g. 'MCPError',
        // 'TypeError') safe to export to OTLP, unlike the raw message/stack which
        // may embed untrusted upstream text. See telemetry/logs.ts redaction policy.
        errorEntry.error_name = err.name;
        if (err.stack) {
          errorEntry.stack = err.stack;
        }
      }
      logError(errorEntry);
    },
  };
}

export type RequestLogger = ReturnType<typeof createRequestLogger>;

// ── Argument redaction utilities for safe logging ───────────────────────────
// Used by MCP discovery, orchestrator, and code execution to log tool inputs
// without exposing sensitive values on the happy path.
//
// Policy:
//   - MCP tool call start/success logs: allow-listed diagnostic keys (language,
//     reference, book, ...) shown verbatim, all other strings summarized, sensitive
//     keys masked (`sanitizeArgsForLog`)
//   - Other start/success logs: summarized (keys + value types/lengths)
//   - Error logs: raw values with sensitive-key masking + string truncation

export const SENSITIVE_KEY_PATTERN =
  /token|secret|password|cookie|session|credential|auth|api.?key|private.?key/i;
const MAX_ERROR_STRING_LENGTH = 1000;
const ERROR_STRING_HEAD = 500;
const ERROR_STRING_TAIL = 200;

/** Summarize a value as type + size, without exposing content. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return `object(${Object.keys(value as Record<string, unknown>).length} keys)`;
}

/**
 * Summarize args for start/success logs: keys + value types/lengths.
 * Example: { book: "string(8)", language: "string(2)", chapters: "array(3)" }
 */
export function summarizeArgs(args: unknown): unknown {
  if (args === null || args === undefined) return args;
  if (typeof args !== 'object') return { type: typeof args };
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    summary[key] = describeValue(value);
  }
  return summary;
}

/** Truncate a string for error logging, keeping head + tail for context. */
function truncateString(value: string): string {
  if (value.length <= MAX_ERROR_STRING_LENGTH) return value;
  return (
    value.slice(0, ERROR_STRING_HEAD) +
    ` [truncated, ${value.length} chars] ` +
    value.slice(-ERROR_STRING_TAIL)
  );
}

/**
 * Console-log key mask: the shared credential pattern plus phone numbers (WhatsApp /
 * Signal ids). Kept separate from `SENSITIVE_KEY_PATTERN`, which also drives OTLP
 * attribute redaction.
 */
const PHONE_KEY_PATTERN = /phone|msisdn/i;

function isRedactedLogKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || PHONE_KEY_PATTERN.test(key);
}

/** Redact a single key-value pair: mask sensitive keys, truncate strings, recurse objects. */
function redactEntry(key: string, value: unknown): unknown {
  if (isRedactedLogKey(key)) return '[REDACTED]';
  return redactArgsForError(value);
}

/**
 * Redact args for error logs: raw values visible except sensitive keys
 * are masked and long strings are truncated.
 */
export function redactArgsForError(args: unknown): unknown {
  if (args === null || args === undefined) return args;
  if (typeof args === 'string') return truncateString(args);
  if (typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map((item) => redactArgsForError(item));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    result[key] = redactEntry(key, value);
  }
  return result;
}

/**
 * Diagnostic MCP argument keys whose string values are safe to log verbatim.
 * Compared after lowercasing and stripping `_`/`-`, so `startChapter`, `start_chapter`
 * and `start-chapter` all match `startchapter`. Anything not listed here is
 * summarized, because MCP schemas are dynamic and an ordinary-looking key (`query`,
 * `text`, `payload`, `url`) can carry user content, PII, or a signed URL.
 */
const LOG_ARG_VALUE_ALLOWLIST = new Set([
  'reference',
  'references',
  'language',
  'languages',
  'lang',
  'languagecode',
  'book',
  'books',
  'chapter',
  'verse',
  'startchapter',
  'endchapter',
  'startverse',
  'endverse',
  'testament',
  'resource',
  'resources',
  'resourcetype',
  'format',
  'translation',
  'version',
  'org',
  'organization',
  'owner',
]);
const MAX_LOG_ARG_STRING_LENGTH = 100;
const MAX_LOG_ARG_DEPTH = 6;

function isAllowListedLogKey(key: string): boolean {
  return LOG_ARG_VALUE_ALLOWLIST.has(key.toLowerCase().replace(/[_-]/g, ''));
}

function truncateLogArgString(value: string): string {
  if (value.length <= MAX_LOG_ARG_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_LOG_ARG_STRING_LENGTH)} [truncated, ${value.length} chars]`;
}

function sanitizeLogArgPrimitive(value: unknown, allowed: boolean): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string')
    return allowed ? truncateLogArgString(value) : `string(${value.length})`;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return allowed ? value.toString() : '[bigint]';
  return `[${typeof value}]`;
}

function sanitizeLogArgValue(value: unknown, depth: number, allowed: boolean): unknown {
  if (typeof value !== 'object' || value === null) return sanitizeLogArgPrimitive(value, allowed);
  if (depth >= MAX_LOG_ARG_DEPTH) return '[max depth]';
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogArgValue(item, depth + 1, allowed));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isRedactedLogKey(key)
        ? '[REDACTED]'
        : sanitizeLogArgValue(entry, depth + 1, isAllowListedLogKey(key)),
    ])
  );
}

/**
 * JSON-safe copy of MCP tool arguments for start/success logs. Fails closed: only
 * string values under allow-listed diagnostic keys (`language`, `reference`, `book`,
 * ...) are shown, truncated to 100 chars. Every other string is summarized as
 * `string(N)`; numbers and booleans pass through as `summarizeArgs` already does;
 * credential/phone keys are masked. Nested objects are walked key by key.
 */
export function sanitizeArgsForLog(args: unknown): unknown {
  return sanitizeLogArgValue(args, 0, false);
}

/**
 * Redact orchestrator tool input for logging.
 * execute_code: summary on start/success, full code on error (truncated).
 * update_memory: section names on start/success, full content on error (truncated).
 * Other tools: summarize on start/success, redacted raw on error.
 */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): unknown {
  if (toolName === 'execute_code') {
    return { code_length: typeof input.code === 'string' ? input.code.length : 0 };
  }
  if (toolName === 'update_memory') {
    const sections = input.sections;
    if (typeof sections === 'object' && sections !== null) {
      const keys = Object.keys(sections as Record<string, unknown>);
      const actions = keys.map((k) => ({
        section: k,
        action: (sections as Record<string, unknown>)[k] === null ? 'delete' : 'upsert',
      }));
      return { sections: actions, pin: input.pin, unpin: input.unpin };
    }
    return { sections: '[unknown]' };
  }
  return summarizeArgs(input);
}

/**
 * Redact orchestrator tool input for error logging.
 * Shows raw values with sensitive-key masking and string truncation.
 */
export function redactToolInputForError(input: Record<string, unknown>): unknown {
  return redactArgsForError(input);
}

/**
 * Safely run an async function without fire-and-forget `void` pattern.
 * Catches and logs any error instead of letting it become an unhandled rejection.
 */
export function safeAsync(logger: RequestLogger, event: string, fn: () => Promise<unknown>): void {
  fn().catch((err: unknown) => {
    logger.error(event, err);
  });
}

/**
 * Wrap an endpoint handler with entry/exit/error logging.
 * Logs start, completion (with status + duration), and errors.
 */
export function withEndpointLogging(
  logger: RequestLogger,
  endpoint: string,
  handler: () => Promise<Response>,
  onError?: (err: unknown) => Response
): Promise<Response> {
  const start = Date.now();
  logger.log(`${endpoint}_start`, {});
  return handler().then(
    (res) => {
      logger.log(`${endpoint}_complete`, { status: res.status, duration_ms: Date.now() - start });
      return res;
    },
    (err) => {
      logger.error(`${endpoint}_error`, err, { duration_ms: Date.now() - start });
      if (onError) return onError(err);
      throw err;
    }
  );
}
