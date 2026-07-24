/**
 * Bounded sync-poll wrapper around ptxprint-mcp's `get_job_status`.
 *
 * v1 strategy: poll every 5s up to a 60s ceiling. In `mode: "simple"`
 * jobs measured in ptxprint-mcp's smokes are 4–10s, so 60s is a comfortable
 * margin. If the ceiling is hit we return `{ state: "pending", job_id }`
 * and the macro-tool surfaces that to Claude — the user can re-ask, which
 * hits ptxprint-mcp's content-addressed cache instantly.
 */

import { RequestLogger } from '../../utils/logger.js';
import { JobStatusResult } from './types.js';
import { countMetric, recordMetric } from '../telemetry/index.js';

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;

export interface PollResult {
  /** Whether the poll resolved to a terminal state (succeeded/failed/cancelled) or timed out. */
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  /** Final state observed (or the last observed state on timeout). */
  state: JobStatusResult['state'] | 'unknown';
  /** Number of polls performed (>=1 — at least one fetch happens before any return). */
  polls: number;
  /** Total wall-clock time of the polling loop, for observability. */
  elapsed_ms: number;
  /** Most recent status payload, for surfacing pdf_url / errors / human_summary. */
  lastStatus: JobStatusResult | null;
}

/**
 * Function signature the polling loop calls into. Production wires this to
 * `callMCPTool(server, "get_job_status", { job_id }, ...)`. Tests inject a
 * fake that returns successive status snapshots.
 */
export type GetJobStatusFn = (jobId: string) => Promise<JobStatusResult>;

function isTerminal(state: JobStatusResult['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function singlePoll(
  jobId: string,
  getJobStatus: GetJobStatusFn,
  logger: RequestLogger,
  pollIndex: number,
  startMs: number
): Promise<JobStatusResult> {
  const pollStart = Date.now();
  let status: JobStatusResult;
  try {
    status = await getJobStatus(jobId);
  } catch (error) {
    // Don't swallow: log + rethrow. A failing get_job_status is a real
    // orchestration error — the macro-tool catches it and surfaces failure.
    logger.error('ptxprint_poll_status_error', error, {
      job_id: jobId,
      poll_index: pollIndex,
      elapsed_ms: Date.now() - startMs,
    });
    throw error;
  }
  logger.log('ptxprint_poll_iteration', {
    job_id: jobId,
    poll_index: pollIndex,
    state: status.state,
    failure_mode: status.failure_mode ?? null,
    progress: status.progress ?? null,
    human_summary: status.human_summary ?? null,
    iteration_ms: Date.now() - pollStart,
    elapsed_ms: Date.now() - startMs,
  });
  return status;
}

function buildTerminalResult(
  status: JobStatusResult,
  polls: number,
  elapsed: number,
  jobId: string,
  logger: RequestLogger
): PollResult {
  logger.log('ptxprint_poll_terminal', {
    job_id: jobId,
    state: status.state,
    failure_mode: status.failure_mode ?? null,
    polls,
    elapsed_ms: elapsed,
  });
  recordMetric('ptxprint_poll_duration_ms', elapsed, { status: status.state });
  countMetric('ptxprint_poll_total', { status: status.state });
  return {
    outcome: status.state as 'succeeded' | 'failed' | 'cancelled',
    state: status.state,
    polls,
    elapsed_ms: elapsed,
    lastStatus: status,
  };
}

function buildTimeoutPollResult(
  jobId: string,
  polls: number,
  elapsed: number,
  lastStatus: JobStatusResult | null,
  logger: RequestLogger
): PollResult {
  logger.warn('ptxprint_poll_timeout', {
    job_id: jobId,
    polls,
    elapsed_ms: elapsed,
    last_state: lastStatus?.state ?? 'unknown',
  });
  recordMetric('ptxprint_poll_duration_ms', elapsed, { status: 'timeout' });
  countMetric('ptxprint_poll_total', { status: 'timeout' });
  return {
    outcome: 'timeout',
    state: lastStatus?.state ?? 'unknown',
    polls,
    elapsed_ms: elapsed,
    lastStatus,
  };
}

export async function pollUntilDone(
  jobId: string,
  getJobStatus: GetJobStatusFn,
  logger: RequestLogger,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<PollResult> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const start = Date.now();
  let polls = 0;
  let lastStatus: JobStatusResult | null = null;

  logger.log('ptxprint_poll_start', {
    job_id: jobId,
    interval_ms: intervalMs,
    timeout_ms: timeoutMs,
  });

  while (Date.now() - start < timeoutMs) {
    polls += 1;
    lastStatus = await singlePoll(jobId, getJobStatus, logger, polls, start);
    if (isTerminal(lastStatus.state)) {
      return buildTerminalResult(lastStatus, polls, Date.now() - start, jobId, logger);
    }
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  return buildTimeoutPollResult(jobId, polls, Date.now() - start, lastStatus, logger);
}
