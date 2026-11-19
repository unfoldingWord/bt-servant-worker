/**
 * #421 / #158: stream-and-retract on the SSE transport.
 *
 * The orchestrator streams every round's text as it arrives (keeping
 * time-to-first-token, which #478 lost and #482 reverted). When a round that
 * streamed text ends in tool calls, it sends `retract` ("discard all progress
 * text since the turn started or since the last retract"), and the turn's
 * `responses` carry only what came after the last retract. A turn left with
 * nothing on screen gets one tools-off recovery call (#158), then an apology.
 *
 * Only a transport that wires `onRetract` (SSE) gets any of this; the
 * callback wire is pinned separately in `callback-wire-unchanged.test.ts`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate, OrchestrationResult } from '../../src/services/claude/orchestrator.js';
import type { RetractNotice, StreamCallbacks } from '../../src/types/engine.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { Env } from '../../src/config/types.js';
import { UI_STRINGS } from '../../src/i18n/ui-strings.js';
import {
  anthropicRound,
  createMockCatalog,
  createMockLogger,
  EXECUTE_CODE_TOOL as TOOL,
} from '../helpers/anthropic-sse.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

type Event =
  | { kind: 'progress'; text: string }
  | { kind: 'retract'; retract: RetractNotice }
  | { kind: 'status'; key: string };

interface Harness {
  events: Event[];
  requests: Array<Record<string, unknown>>;
  logger: RequestLogger;
}

/** Answer each Anthropic call with the next canned round (or a Response for errors). */
function mockRounds(rounds: Array<string | Response>): Array<Record<string, unknown>> {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const requests: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = rounds[requests.length - 1];
    if (next === undefined) throw new Error(`unexpected Anthropic call #${requests.length}`);
    if (next instanceof Response) return next;
    return new Response(next, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return requests;
}

function sseCallbacks(events: Event[], withRetract: boolean): StreamCallbacks {
  return {
    onStatus: (status) => events.push({ kind: 'status', key: status.key }),
    onProgress: (text) => events.push({ kind: 'progress', text }),
    onComplete: () => {},
    onError: () => {},
    ...(withRetract
      ? { onRetract: (retract: RetractNotice) => events.push({ kind: 'retract', retract }) }
      : {}),
  };
}

async function runTurn(
  rounds: Array<string | Response>,
  opts: { withRetract?: boolean; env?: Partial<Env>; turnStartedAt?: number; locale?: string } = {}
): Promise<Harness & { result: OrchestrationResult }> {
  const events: Event[] = [];
  const requests = mockRounds(rounds);
  const logger = createMockLogger();
  const result = await orchestrate('hi', {
    env: { ANTHROPIC_API_KEY: 'test-key', ...opts.env } as Env,
    catalog: createMockCatalog(),
    history: [],
    preferences: { response_language: opts.locale ?? 'en', first_interaction: false },
    logger,
    callbacks: sseCallbacks(events, opts.withRetract ?? true),
    ...(opts.turnStartedAt !== undefined ? { turnStartedAt: opts.turnStartedAt } : {}),
  });
  return { events, requests, logger, result };
}

/** Progress and retract only, in order: what a client renders. */
function textFrames(events: Event[]): Array<string | RetractNotice> {
  return events.flatMap((e) =>
    e.kind === 'progress' ? [e.text] : e.kind === 'retract' ? [e.retract] : []
  );
}

/** Apply the frames the way the spec tells a client to: what is left on screen. */
function screen(events: Event[]): string {
  let shown = '';
  for (const frame of textFrames(events)) {
    if (typeof frame === 'string') shown += frame;
    else {
      expect(frame.chars).toBe(shown.length);
      shown = '';
    }
  }
  return shown;
}

function logged(
  logger: RequestLogger,
  level: 'log' | 'warn' | 'error',
  event: string
): unknown[][] {
  const fn = logger[level] as unknown as ReturnType<typeof vi.fn>;
  return fn.mock.calls.filter((call: unknown[]) => call[0] === event);
}

const NARRATION = 'Let me look that up.';
const ANSWER = 'Here is the answer.';

describe('SSE stream-and-retract (#421)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('streams narration, retracts it before the tools run, then streams the answer', async () => {
    const { events, result } = await runTurn([
      anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, TOOL]),
      anthropicRound('end_turn', [{ type: 'text', text: ANSWER }]),
    ]);

    // Narration streams live (time-to-first-token kept), then is taken back
    // BEFORE the tool status, and no separator precedes the answer.
    expect(events).toEqual([
      { kind: 'status', key: 'status_processing' },
      { kind: 'progress', text: NARRATION },
      { kind: 'retract', retract: { iteration: 0, chars: NARRATION.length } },
      { kind: 'status', key: 'status_executing_tools' },
      { kind: 'status', key: 'status_preparing' },
      { kind: 'progress', text: ANSWER },
    ]);
    expect(result.responses).toEqual([ANSWER]);
    expect(result.finalIterationStartIndex).toBe(0);
    expect(screen(events)).toBe(result.responses.join('\n'));
  });

  it('sends no retract for a tools-first round that streamed nothing', async () => {
    const { events, result } = await runTurn([
      anthropicRound('tool_use', [TOOL]),
      anthropicRound('end_turn', [{ type: 'text', text: ANSWER }]),
    ]);
    expect(events.some((e) => e.kind === 'retract')).toBe(false);
    expect(textFrames(events)).toEqual([ANSWER]);
    expect(result.responses).toEqual([ANSWER]);
  });
});

describe('SSE stream-and-retract (#421): several rounds', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts each retract from the previous one only', async () => {
    const second = 'Now the notes.';
    const { events, result, logger } = await runTurn([
      anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, TOOL]),
      anthropicRound('tool_use', [
        { type: 'text', text: second },
        { ...TOOL, id: 'tool_2' },
      ]),
      anthropicRound('end_turn', [{ type: 'text', text: ANSWER }]),
    ]);
    expect(textFrames(events)).toEqual([
      NARRATION,
      { iteration: 0, chars: NARRATION.length },
      second,
      { iteration: 1, chars: second.length },
      ANSWER,
    ]);
    expect(result.responses).toEqual([ANSWER]);
    expect(screen(events)).toBe(ANSWER);
    expect(logged(logger, 'log', 'intermediate_responses_dropped')).toEqual([
      ['intermediate_responses_dropped', { count: 2, lengths: [NARRATION.length, second.length] }],
    ]);
  });
});

describe('SSE stream-and-retract (#421): what does not change', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a single-round turn is unchanged: no retract, every word kept', async () => {
    const { events, result } = await runTurn([
      anthropicRound('end_turn', [{ type: 'text', text: ANSWER }]),
    ]);
    expect(textFrames(events)).toEqual([ANSWER]);
    expect(result.responses).toEqual([ANSWER]);
  });

  it('a transport without onRetract keeps every round (callback and final-JSON behaviour)', async () => {
    const { events, result } = await runTurn(
      [
        anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, TOOL]),
        anthropicRound('end_turn', [{ type: 'text', text: ANSWER }]),
      ],
      { withRetract: false }
    );
    expect(textFrames(events)).toEqual([NARRATION, '\n', ANSWER]);
    expect(result.responses).toEqual([NARRATION, ANSWER]);
    expect(result.finalIterationStartIndex).toBe(1);
  });

  it('a non-SSE turn whose final round is empty makes no recovery call', async () => {
    const { requests, result } = await runTurn(
      [
        anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, TOOL]),
        anthropicRound('end_turn', []),
      ],
      { withRetract: false }
    );
    expect(requests).toHaveLength(2);
    expect(result.responses).toEqual([NARRATION]);
  });
});

describe('SSE turn never ends on a blank screen (#158)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs one tools-off recovery call when the final round has no text', async () => {
    const { events, requests, result } = await runTurn(
      [
        anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, TOOL]),
        anthropicRound('end_turn', []),
        anthropicRound('end_turn', [{ type: 'text', text: 'Recovered answer.' }]),
      ],
      { locale: 'pt' }
    );
    expect(requests).toHaveLength(3);
    const recovery = requests[2]!;
    expect(recovery.tool_choice).toEqual({ type: 'none' });
    expect(recovery.tools).toBeDefined();
    // The instruction rides on the last user turn (the tool results), so roles alternate.
    const messages = recovery.messages as Array<{ role: string; content: unknown }>;
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    const blocks = last.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]?.type).toBe('tool_result');
    expect(blocks.at(-1)?.text).toContain('Do not call any tools');
    expect(blocks.at(-1)?.text).toContain('"pt"');
    // Earlier calls never carried tool_choice.
    expect(requests[0]!.tool_choice).toBeUndefined();
    expect(requests[1]!.tool_choice).toBeUndefined();

    expect(result.responses).toEqual(['Recovered answer.']);
    expect(screen(events)).toBe('Recovered answer.');
  });

  it('sends the localized apology when the recovery call is empty too', async () => {
    const { events, result, logger } = await runTurn([
      anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, TOOL]),
      anthropicRound('end_turn', []),
      anthropicRound('end_turn', []),
    ]);
    const apology = UI_STRINGS.en.notice_empty_answer;
    expect(result.responses).toEqual([apology]);
    expect(screen(events)).toBe(apology);
    expect(logged(logger, 'warn', 'empty_final_answer').map((c) => c[1])).toEqual([
      { recovery: 'forced_reply', iteration: 2 },
      { recovery: 'apology', iteration: 2 },
    ]);
  });
});

describe('SSE recovery (#158): gates, failures and the iteration cap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips the recovery call past the recovery gate and apologizes', async () => {
    const { requests, result } = await runTurn(
      [
        anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, TOOL]),
        anthropicRound('end_turn', []),
      ],
      { turnStartedAt: Date.now() - 250_000 }
    );
    expect(requests).toHaveLength(2);
    expect(result.responses).toEqual([UI_STRINGS.en.notice_empty_answer]);
  });

  it('logs a failed recovery call and still apologizes instead of failing the turn', async () => {
    const { result, logger } = await runTurn([
      anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, TOOL]),
      anthropicRound('end_turn', []),
      new Response('{"error":"bad request"}', { status: 400 }),
    ]);
    expect(logged(logger, 'error', 'recovery_call_failed')).toHaveLength(1);
    expect(result.responses).toEqual([UI_STRINGS.en.notice_empty_answer]);
  });

  it('at the iteration cap: every round retracted, recovery answers, then the cap notice', async () => {
    const { events, requests, result } = await runTurn(
      [
        anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, TOOL]),
        anthropicRound('tool_use', [
          { type: 'text', text: 'Still looking.' },
          { ...TOOL, id: 't2' },
        ]),
        anthropicRound('end_turn', [{ type: 'text', text: 'Best answer so far.' }]),
      ],
      { env: { MAX_ORCHESTRATION_ITERATIONS: '2' } }
    );
    expect(requests).toHaveLength(3);
    expect(requests[2]!.tool_choice).toEqual({ type: 'none' });
    const notice = UI_STRINGS.en.notice_max_iterations;
    expect(result.responses).toEqual(['Best answer so far.', notice]);
    expect(screen(events)).toBe(`Best answer so far.${notice}`);
  });
});
