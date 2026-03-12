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
  handler: () => Promise<Response>
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
      throw err;
    }
  );
}
