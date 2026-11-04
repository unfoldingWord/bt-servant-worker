/**
 * Streaming deadline behaviour (#481).
 *
 * Before #481 a streaming call was cut at 90 s total, whether or not data was
 * still flowing. In prod every firing over 7 days was a live long answer, the
 * text already received was thrown away, and the turn failed with the abort's
 * cancel reason (`upstream-abort`) as its error.
 *
 * Now:
 * - a stall timer (30 s without a chunk) replaces the per-call total cap;
 * - a turn ceiling (270 s from turn start) is the backstop;
 * - a cut-off FINAL round (no tool call) delivers its text plus the localized
 *   truncation notice instead of failing the turn;
 * - a cut-off round with a tool call still fails, with a typed error;
 * - a `max_tokens` final round gets the same notice.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeStreamAbortedError, orchestrate } from '../../src/services/claude/orchestrator.js';
import { UI_STRINGS } from '../../src/i18n/ui-strings.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import {
  createMockCallbacks,
  createMockCatalog,
  createMockEnv,
  createMockLogger,
} from '../helpers/anthropic-sse.js';

// `APIError` is needed: the failure path checks `instanceof Anthropic.APIError`.
vi.mock('@anthropic-ai/sdk', () => ({
  default: Object.assign(vi.fn(), { APIError: class APIError extends Error {} }),
}));

const NOTICE_EN = UI_STRINGS.en.notice_answer_truncated;

function frame(event: object): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const MESSAGE_START = frame({
  type: 'message_start',
  message: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  },
});
const TEXT_START = frame({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
});
const textDelta = (text: string, index = 0): string =>
  frame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const TOOL_START = frame({
  type: 'content_block_start',
  index: 1,
  content_block: { type: 'tool_use', id: 'tu_1', name: 'fetch_scripture', input: {} },
});
const toolJson = (partial: string): string =>
  frame({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: partial },
  });
const finish = (stopReason: string): string[] => [
  frame({ type: 'content_block_stop', index: 0 }),
  frame({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 20 },
  }),
  frame({ type: 'message_stop' }),
];

interface TimedStreamOptions {
  /** Delay before each frame after the first (the first is sent at once). */
  gapMs: number;
  /** Close the body after the last frame; otherwise it goes silent and stays open. */
  close: boolean;
  /**
   * What the body does when the fetch signal aborts. `error-reason` errors it
   * with the bare string `upstream-abort`, the shape that reached users in prod.
   * Default: nothing (the guard's race is what notices the abort).
   */
  onAbort?: 'error-reason';
}

/** Answer every fetch with an SSE body that emits `frames` on a timer. */
function mockTimedSSE(frames: string[], opts: TimedStreamOptions): void {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const encoder = new TextEncoder();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (opts.onAbort === 'error-reason') {
          init?.signal?.addEventListener('abort', () => controller.error('upstream-abort'));
        }
        frames.forEach((f, i) => {
          setTimeout(() => {
            if (init?.signal?.aborted) return;
            controller.enqueue(encoder.encode(f));
            if (opts.close && i === frames.length - 1) controller.close();
          }, i * opts.gapMs);
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

interface TurnResult {
  responses: string[];
  progress: string[];
  stopReason: string | null;
  logger: RequestLogger;
}

/** Run one streaming turn, advancing fake time until it settles. */
async function runTurn(
  opts: {
    locale?: string;
    turnStartedAt?: number;
    advanceMs: number;
    refreshLock?: () => Promise<void>;
  } = { advanceMs: 0 }
): Promise<TurnResult> {
  const logger = createMockLogger();
  const { callbacks, progress } = createMockCallbacks();
  const pending = orchestrate('Tell me about Mark 3:7-12', {
    env: createMockEnv(),
    catalog: createMockCatalog(),
    history: [],
    preferences: { response_language: opts.locale ?? 'en', first_interaction: false },
    logger,
    callbacks,
    turnStartedAt: opts.turnStartedAt,
    refreshLock: opts.refreshLock,
  });
  // Attach the rejection handler now so advancing time cannot surface it as unhandled.
  const settled = pending.then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await vi.advanceTimersByTimeAsync(opts.advanceMs);
  const outcome = await settled;
  if (!outcome.ok) throw outcome.error;
  return {
    responses: outcome.result.responses,
    progress,
    stopReason: outcome.result.telemetry.finalStopReason,
    logger,
  };
}

function loggedEvents(fn: unknown): Array<[string, Record<string, unknown>]> {
  return (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => {
    const data = (c.length === 3 ? c[2] : c[1]) as Record<string, unknown> | undefined;
    return [c[0] as string, data ?? {}];
  });
}

function findLog(
  logger: RequestLogger,
  level: 'warn' | 'error' | 'log',
  event: string
): Record<string, unknown> | undefined {
  return loggedEvents(logger[level]).find(([name]) => name === event)?.[1];
}

/** A final-round answer: text deltas only, then silence (never finishes). */
function stalledAnswer(deltas: string[]): string[] {
  return [MESSAGE_START, TEXT_START, ...deltas.map((d) => textDelta(d))];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('streaming deadline (#481): a live stream is never cut by a total-duration cap', () => {
  it('a 120 s answer whose chunks keep arriving completes in full, with no notice', async () => {
    vi.useFakeTimers();
    const deltas = Array.from({ length: 10 }, (_, i) => `part${i} `);
    mockTimedSSE(
      [MESSAGE_START, TEXT_START, ...deltas.map((d) => textDelta(d)), ...finish('end_turn')],
      {
        gapMs: 9_000,
        close: true,
      }
    );

    const turn = await runTurn({ advanceMs: 200_000 });

    expect(turn.responses).toEqual([deltas.join('')]);
    expect(turn.progress).not.toContain(NOTICE_EN);
    expect(turn.stopReason).toBe('end_turn');
    expect(findLog(turn.logger, 'warn', 'sse_stream_aborted')).toBeUndefined();
  });
});

describe('streaming deadline (#481): a stalled final answer is delivered with a notice', () => {
  it('30 s of silence mid-answer keeps the text, appends the notice and does not fail', async () => {
    vi.useFakeTimers();
    mockTimedSSE(stalledAnswer(['Jesus withdrew ', 'with his disciples ', 'to the sea']), {
      gapMs: 1_000,
      close: false,
    });

    const turn = await runTurn({ advanceMs: 60_000 });

    expect(turn.responses).toEqual(['Jesus withdrew with his disciples to the sea', NOTICE_EN]);
    expect(turn.progress.at(-1)).toBe(NOTICE_EN);
    expect(turn.stopReason).toBe('stream_aborted');
    expect(findLog(turn.logger, 'warn', 'sse_stream_aborted')).toMatchObject({
      stream_abort_kind: 'stall',
      had_message: true,
    });
    expect(findLog(turn.logger, 'warn', 'answer_truncated')).toMatchObject({
      cause: 'stall',
      recovery_affordable: true,
    });
  });

  it('the stall timer measures silence, not age: it fires 30 s after the LAST chunk', async () => {
    vi.useFakeTimers();
    // Chunks every 20 s for 80 s: never 30 s of silence until the stream stops.
    mockTimedSSE(stalledAnswer(['a', 'b', 'c', 'd', 'e']), { gapMs: 20_000, close: false });

    const turn = await runTurn({ advanceMs: 150_000 });

    expect(turn.responses).toEqual(['abcde', NOTICE_EN]);
    const aborted = findLog(turn.logger, 'warn', 'sse_stream_aborted');
    expect(aborted).toMatchObject({ stream_abort_kind: 'stall' });
    // Last chunk at ~80 s of body time, so the abort lands at ~110 s, not 30 s.
    expect(aborted?.elapsed_ms as number).toBeGreaterThanOrEqual(110_000);
  });

  it('the prod shape: a body that errors with the bare cancel reason is still a delivered partial', async () => {
    vi.useFakeTimers();
    mockTimedSSE(stalledAnswer(['Long answer ', 'still writing']), {
      gapMs: 1_000,
      close: false,
      onAbort: 'error-reason',
    });

    const turn = await runTurn({ advanceMs: 60_000 });

    expect(turn.responses).toEqual(['Long answer still writing', NOTICE_EN]);
    expect(turn.responses.join('')).not.toContain('upstream-abort');
  });

  it('uses the turn locale for the notice', async () => {
    vi.useFakeTimers();
    mockTimedSSE(stalledAnswer(['Jesus se retirou']), { gapMs: 1_000, close: false });

    const turn = await runTurn({ locale: 'pt', advanceMs: 60_000 });

    expect(turn.responses).toEqual(['Jesus se retirou', UI_STRINGS.pt.notice_answer_truncated]);
  });
});

describe('streaming deadline (#481): the turn ceiling is the backstop', () => {
  it('a stream still flowing at 270 s of turn time is cut as `deadline` and delivered', async () => {
    vi.useFakeTimers();
    // The turn started 260 s ago, so 10 s of streaming budget remain.
    const turnStartedAt = Date.now() - 260_000;
    mockTimedSSE(stalledAnswer(['x', 'y', 'z', 'w', 'v']), { gapMs: 4_000, close: false });

    const turn = await runTurn({ turnStartedAt, advanceMs: 30_000 });

    expect(turn.responses.at(-1)).toBe(NOTICE_EN);
    expect(findLog(turn.logger, 'warn', 'sse_stream_aborted')).toMatchObject({
      stream_abort_kind: 'deadline',
    });
    // Past 240 s, a rescue call would not have been affordable.
    expect(findLog(turn.logger, 'warn', 'answer_truncated')).toMatchObject({
      cause: 'deadline',
      recovery_affordable: false,
    });
  });
});

describe('streaming deadline (#481): rounds that cannot stand as an answer still fail', () => {
  it('a stall while a tool call is being written throws ClaudeStreamAbortedError', async () => {
    vi.useFakeTimers();
    mockTimedSSE(
      [
        MESSAGE_START,
        TEXT_START,
        textDelta('Let me look that up. '),
        TOOL_START,
        toolJson('{"ref'),
      ],
      { gapMs: 1_000, close: false }
    );

    await expect(runTurn({ advanceMs: 60_000 })).rejects.toBeInstanceOf(ClaudeStreamAbortedError);
  });

  it('a stall before any text arrives throws, with the kind on the failure log', async () => {
    vi.useFakeTimers();
    mockTimedSSE([frame({ type: 'ping' })], { gapMs: 1_000, close: false });

    let caught: unknown;
    const turn = await runTurn({ advanceMs: 60_000 }).catch((error: unknown) => {
      caught = error;
      return undefined;
    });

    expect(turn).toBeUndefined();
    expect(caught).toBeInstanceOf(ClaudeStreamAbortedError);
    expect((caught as ClaudeStreamAbortedError).abortKind).toBe('stall');
    expect((caught as Error).message).toContain('timeout');
  });
});

describe('streaming deadline (#481): stream errors that are not ours are not swallowed', () => {
  it('a body that errors on its own (no guard abort) still fails the turn with that error', async () => {
    vi.useFakeTimers();
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
      this: object
    ) {
      return this;
    } as unknown as () => object);
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(MESSAGE_START + TEXT_START + textDelta('Half')));
          setTimeout(() => controller.error(new Error('connection reset')), 1_000);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    await expect(runTurn({ advanceMs: 5_000 })).rejects.toThrow('connection reset');
  });
});

describe('max_tokens (#481 comment, Q4 seam)', () => {
  it('a final round that stopped on max_tokens keeps its text and gets the notice', async () => {
    vi.useFakeTimers();
    mockTimedSSE(
      [MESSAGE_START, TEXT_START, textDelta('A long answer that ran out'), ...finish('max_tokens')],
      {
        gapMs: 10,
        close: true,
      }
    );

    const turn = await runTurn({ advanceMs: 1_000 });

    expect(turn.responses).toEqual(['A long answer that ran out', NOTICE_EN]);
    expect(turn.stopReason).toBe('max_tokens');
    expect(findLog(turn.logger, 'warn', 'answer_truncated')).toMatchObject({ cause: 'max_tokens' });
  });
});

describe('per-user lock refresh during long turns (#481)', () => {
  it('refreshes at round start and keeps refreshing well inside 90 s while a 120 s stream flows', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const refreshedAt: number[] = [];
    const refreshLock = vi.fn(async () => {
      refreshedAt.push(Date.now() - start);
    });
    const deltas = Array.from({ length: 14 }, (_, i) => `p${i} `);
    mockTimedSSE(
      [MESSAGE_START, TEXT_START, ...deltas.map((d) => textDelta(d)), ...finish('end_turn')],
      { gapMs: 7_000, close: true }
    );

    const turn = await runTurn({ advanceMs: 200_000, refreshLock });

    expect(turn.responses).toEqual([deltas.join('')]);
    expect(refreshedAt[0]).toBe(0); // round start
    const lastChunkAt = 7_000 * (deltas.length + 4);
    const gaps = [...refreshedAt, lastChunkAt].slice(1).map((t, i) => t - refreshedAt[i]!);
    expect(Math.max(...gaps)).toBeLessThan(45_000);
    // Throttled: not one write per chunk.
    expect(refreshLock.mock.calls.length).toBeLessThan(deltas.length);
  });

  it('a failing refresh is logged and does not fail the turn', async () => {
    vi.useFakeTimers();
    const refreshLock = vi.fn(async () => {
      throw new Error('storage unavailable');
    });
    mockTimedSSE([MESSAGE_START, TEXT_START, textDelta('ok'), ...finish('end_turn')], {
      gapMs: 10,
      close: true,
    });

    const turn = await runTurn({ advanceMs: 1_000, refreshLock });

    expect(turn.responses).toEqual(['ok']);
    expect(findLog(turn.logger, 'warn', 'turn_lock_refresh_failed')).toMatchObject({
      reason: 'round_start',
      error: 'storage unavailable',
    });
  });
});
