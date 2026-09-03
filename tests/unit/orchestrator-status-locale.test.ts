/**
 * Tests that every status line and notice the orchestrator emits itself (not
 * LLM output) is localized by `preferences.response_language` and carries a
 * stable `key` (issue #405).
 *
 * Harness follows `orchestrator-sse-ping.test.ts`: the Anthropic SDK is
 * mocked out and `fetch` returns a canned SSE body. Every iteration answers
 * with a `tool_use` for the internal `get_tool_definitions` tool (no network,
 * succeeds with `{}` against an empty catalog), so the loop runs to
 * MAX_ORCHESTRATION_ITERATIONS and exercises all four status sites plus the
 * max-iterations notice in one turn:
 *
 *   status_processing → status_executing_tools → status_preparing →
 *   status_executing_tools → notice_max_iterations
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import { ToolCatalog } from '../../src/services/mcp/index.js';
import { RequestLogger } from '../../src/utils/logger.js';
import { StreamCallbacks } from '../../src/types/engine.js';
import { Env } from '../../src/config/types.js';
import { STATUS_KEYS, UI_STRINGS, uiString, type StatusUpdate } from '../../src/i18n/ui-strings.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const MAX_ITERATIONS = 2;

function createMockEnv(): Env {
  return {
    ANTHROPIC_API_KEY: 'test-key',
    MAX_ORCHESTRATION_ITERATIONS: String(MAX_ITERATIONS),
  } as Env;
}

function createMockCatalog(): ToolCatalog {
  return { tools: [], serverMap: new Map() };
}

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

interface Captured {
  statuses: StatusUpdate[];
  progress: string[];
}

function createMockCallbacks(captured: Captured): StreamCallbacks {
  return {
    onStatus: vi.fn((status: StatusUpdate) => captured.statuses.push(status)),
    onProgress: vi.fn((text: string) => captured.progress.push(text)),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
}

/** One Anthropic SSE message whose only content block is a tool_use for `get_tool_definitions`. */
function buildToolUseSSEBody(): string {
  const usage = {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const message = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    stop_reason: null,
    stop_sequence: null,
    usage,
    content: [],
  };
  const lines = [
    `data: ${JSON.stringify({ type: 'message_start', message })}\n`,
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_tool_definitions', input: {} },
    })}\n`,
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"tool_names":["search"]}' },
    })}\n`,
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n`,
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage,
    })}\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n`,
  ];
  return lines.join('\n');
}

function mockFetchWithToolUse(): void {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);

  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(buildToolUseSSEBody(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
  );
}

async function runTurn(responseLanguage: string): Promise<Captured & { responses: string[] }> {
  mockFetchWithToolUse();
  const captured: Captured = { statuses: [], progress: [] };
  const result = await orchestrate('test message', {
    env: createMockEnv(),
    catalog: createMockCatalog(),
    history: [],
    preferences: { response_language: responseLanguage, first_interaction: true },
    logger: createMockLogger(),
    callbacks: createMockCallbacks(captured),
  });
  return { ...captured, responses: result.responses };
}

function expectedStatuses(locale: string): StatusUpdate[] {
  return [
    { key: 'status_processing', message: uiString(locale, 'status_processing') },
    {
      key: 'status_executing_tools',
      message: uiString(locale, 'status_executing_tools', { n: 1 }),
    },
    { key: 'status_preparing', message: uiString(locale, 'status_preparing') },
    {
      key: 'status_executing_tools',
      message: uiString(locale, 'status_executing_tools', { n: 1 }),
    },
  ];
}

describe('Orchestrator status locale (#405)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits every status with key + Portuguese message for response_language pt', async () => {
    const turn = await runTurn('pt');

    expect(turn.statuses).toEqual(expectedStatuses('pt'));
    // Sanity: these really are the pt table values, not English fallbacks.
    expect(turn.statuses[0]?.message).toBe(UI_STRINGS.pt.status_processing);
    expect(turn.statuses[1]?.message).toBe('Executando 1 ferramenta(s)...');
    expect(turn.statuses[2]?.message).toBe(UI_STRINGS.pt.status_preparing);
  });

  it('emits the English table values for response_language en', async () => {
    const turn = await runTurn('en');

    expect(turn.statuses).toEqual(expectedStatuses('en'));
    expect(turn.statuses.map((s) => s.message)).toEqual([
      'Processing your request...',
      'Executing 1 tool(s)...',
      'Preparing your response...',
      'Executing 1 tool(s)...',
    ]);
  });

  it('falls back to English for an unsupported response_language (sw)', async () => {
    const turn = await runTurn('sw');
    expect(turn.statuses).toEqual(expectedStatuses('en'));
  });

  it('max-iterations: pushed response and onProgress text are the same localized paragraph', async () => {
    const turn = await runTurn('pt');
    const notice = uiString('pt', 'notice_max_iterations');

    expect(notice).toBe(UI_STRINGS.pt.notice_max_iterations);
    expect(turn.responses.at(-1)).toBe(notice);
    expect(turn.progress).toContain(notice);
    // And it is not the English paragraph.
    expect(turn.responses.at(-1)).not.toBe(UI_STRINGS.en.notice_max_iterations);
  });

  it('max-iterations notice is English for en and for unsupported locales', async () => {
    const en = await runTurn('en');
    expect(en.responses.at(-1)).toBe(UI_STRINGS.en.notice_max_iterations);
    vi.restoreAllMocks();
    const sw = await runTurn('sw');
    expect(sw.responses.at(-1)).toBe(UI_STRINGS.en.notice_max_iterations);
  });

  it('contract: every emitted key is drawn from the closed StatusKey union', async () => {
    const turn = await runTurn('pt');
    expect(turn.statuses.length).toBeGreaterThan(0);
    for (const s of turn.statuses) {
      expect(STATUS_KEYS).toContain(s.key);
      expect(typeof s.message).toBe('string');
      expect(s.message.length).toBeGreaterThan(0);
    }
  });
});
