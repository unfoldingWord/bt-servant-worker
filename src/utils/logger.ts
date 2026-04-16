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

export function log(entry: LogEntry): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

export function logInfo(entry: LogEntry): void {
  // eslint-disable-next-line no-console
  console.info(JSON.stringify(entry));
}

export function logWarn(entry: LogEntry): void {
  console.warn(JSON.stringify(entry));
}

export function logError(entry: LogEntry & { error: string; stack?: string | undefined }): void {
  console.error(JSON.stringify(entry));
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
      if (err instanceof Error && err.stack) {
        errorEntry.stack = err.stack;
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
//   - Start/success logs: summarized (keys + value types/lengths)
//   - Error logs: raw values with sensitive-key masking + string truncation

const SENSITIVE_KEY_PATTERN =
  /^(token|authorization|apikey|api_key|secret|password|cookie|session|credential|auth)$/i;
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

/** Redact a single key-value pair: mask sensitive keys, truncate strings, recurse objects. */
function redactEntry(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
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
