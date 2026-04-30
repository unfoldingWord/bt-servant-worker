/**
 * bt-servant-tail
 *
 * Tail consumer for bt-servant-worker. Cloudflare delivers a TraceItem
 * for every invocation of the producer worker — including invocations
 * the runtime killed mid-flight (CPU/memory/wall-time exhaustion,
 * uncaught exceptions, isolate eviction). Those failures never run any
 * JS catch/finally in the producer, so the producer cannot log them.
 *
 * This worker re-emits non-ok outcomes (and ok outcomes that contained
 * an exception) as structured `worker_death` log events that flow into
 * Workers Observability under this worker's own service name. Query in
 * the cloudflare-logs skill via:
 *   $metadata.service eq "bt-servant-tail-staging"
 *   $metadata.message eq "worker_death"
 *
 * Producer requestId is preserved as `request_id` in the log payload
 * so a death can be cross-referenced against the producer's own logs.
 */

interface TailLog {
  timestamp: number;
  level: string;
  message: unknown[] | unknown;
}

interface TailException {
  name: string;
  message: string;
  timestamp: number;
}

interface TailEventRequest {
  url?: string;
  method?: string;
  cf?: { colo?: string };
}

// TraceItem from @cloudflare/workers-types is intentionally loose; we narrow
// here to the fields we actually consume. Fields we don't touch are typed
// as unknown to keep the surface small.
interface TraceItem {
  scriptName?: string | null;
  outcome: string;
  eventTimestamp?: number | null;
  event?: { request?: TailEventRequest } | null;
  logs?: TailLog[];
  exceptions?: TailException[];
  diagnosticsChannelEvents?: unknown[];
  scriptVersion?: { id?: string; tag?: string; message?: string } | null;
  truncated?: boolean;
}

const MAX_LOGS_FORWARDED = 50;
const MAX_LOG_MESSAGE_CHARS = 2000;

function shouldEmit(item: TraceItem): boolean {
  if (item.outcome !== 'ok') return true;
  if ((item.exceptions?.length ?? 0) > 0) return true;
  return false;
}

function summarizeLog(log: TailLog): { ts: number; level: string; message: string } {
  let message: string;
  try {
    if (Array.isArray(log.message)) {
      message = log.message
        .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
        .join(' ');
    } else if (typeof log.message === 'string') {
      message = log.message;
    } else {
      message = JSON.stringify(log.message);
    }
  } catch {
    message = '(unserializable log message)';
  }
  if (message.length > MAX_LOG_MESSAGE_CHARS) {
    message = `${message.slice(0, MAX_LOG_MESSAGE_CHARS)}…(truncated)`;
  }
  return { ts: log.timestamp, level: log.level, message };
}

function extractRequestId(item: TraceItem): string | null {
  // The producer's structured logger emits request_id inside .source for
  // every event. We scan tail logs for the first one we can extract.
  for (const log of item.logs ?? []) {
    const messages = Array.isArray(log.message) ? log.message : [log.message];
    for (const m of messages) {
      if (typeof m !== 'string') continue;
      const match = m.match(/"request_id"\s*:\s*"([0-9a-f-]{8,})"/i);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

function summarizeRequest(req: TailEventRequest | undefined): unknown {
  if (!req) return null;
  return {
    url: req.url ?? null,
    method: req.method ?? null,
    colo: req.cf?.colo ?? null,
  };
}

function summarizeException(e: TailException): unknown {
  return { name: e.name, message: e.message, timestamp: e.timestamp };
}

function summarizeScriptVersion(v: TraceItem['scriptVersion']): unknown {
  if (!v) return null;
  return { id: v.id ?? null, tag: v.tag ?? null, message: v.message ?? null };
}

function buildLogSummary(item: TraceItem): {
  log_count: number;
  logs_forwarded: number;
  last_logs: ReturnType<typeof summarizeLog>[];
} {
  const allLogs = item.logs ?? [];
  const last_logs = allLogs.slice(-MAX_LOGS_FORWARDED).map(summarizeLog);
  return { log_count: allLogs.length, logs_forwarded: last_logs.length, last_logs };
}

function buildExceptionSummary(item: TraceItem): {
  exception_count: number;
  exceptions: unknown[];
} {
  const exceptions = item.exceptions ?? [];
  return { exception_count: exceptions.length, exceptions: exceptions.map(summarizeException) };
}

function emitDeath(item: TraceItem): void {
  const death = {
    event: 'worker_death',
    script_name: item.scriptName ?? null,
    outcome: item.outcome,
    truncated: item.truncated ?? false,
    event_timestamp: item.eventTimestamp ?? null,
    request: summarizeRequest(item.event?.request),
    request_id: extractRequestId(item),
    ...buildExceptionSummary(item),
    ...buildLogSummary(item),
    script_version: summarizeScriptVersion(item.scriptVersion),
  };
  // Single-line JSON makes Workers Observability index cleanly.
  console.log(JSON.stringify(death));
}

export default {
  tail(events: TraceItem[]): void {
    for (const item of events) {
      try {
        if (!shouldEmit(item)) continue;
        emitDeath(item);
      } catch (error) {
        // Never silent — emit a tail-worker self-failure marker so we can
        // see when our own forwarding is broken. Using a distinct event so
        // it does not get mistaken for a producer death.
        console.log(
          JSON.stringify({
            event: 'tail_worker_self_failure',
            error: error instanceof Error ? error.message : String(error),
            script_name: item.scriptName ?? null,
            outcome: item.outcome,
          })
        );
      }
    }
  },
};
