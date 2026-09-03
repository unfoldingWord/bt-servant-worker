/**
 * Tests that every status line and notice the orchestrator emits itself (not
 * LLM output) is localized by `preferences.response_language` and carries a
 * stable `key` (issue #405).
 *
 * Harness: `tests/helpers/anthropic-sse.ts`. Every iteration answers with a
 * `tool_use` for the internal `get_tool_definitions` tool (no network,
 * succeeds with `{}` against an empty catalog), so the loop runs to
 * MAX_ORCHESTRATION_ITERATIONS and exercises all four status sites plus the
 * max-iterations notice in one turn:
 *
 *   status_processing → status_executing_tools → status_preparing →
 *   status_executing_tools → notice_max_iterations
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import { STATUS_KEYS, UI_STRINGS, type StatusKey } from '../../src/i18n/ui-strings.js';
import {
  buildSSEFrames,
  createMockCallbacks,
  createMockCatalog,
  createMockEnv,
  createMockLogger,
  mockAnthropicFetch,
} from '../helpers/anthropic-sse.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const MAX_ITERATIONS = 2;

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
  return buildSSEFrames([
    { type: 'message_start', message },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_tool_definitions', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"tool_names":["search"]}' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage },
    { type: 'message_stop' },
  ]);
}

interface Turn {
  keys: StatusKey[];
  messages: string[];
  progress: string[];
  responses: string[];
}

async function runTurn(responseLanguage: string): Promise<Turn> {
  mockAnthropicFetch(buildToolUseSSEBody());
  const { callbacks, statuses, progress } = createMockCallbacks();
  const result = await orchestrate('test message', {
    env: createMockEnv({ MAX_ORCHESTRATION_ITERATIONS: String(MAX_ITERATIONS) }),
    catalog: createMockCatalog(),
    history: [],
    preferences: { response_language: responseLanguage, first_interaction: true },
    logger: createMockLogger(),
    callbacks,
  });
  return {
    keys: statuses.map((s) => s.key),
    messages: statuses.map((s) => s.message),
    progress,
    responses: result.responses,
  };
}

/** `status_executing_tools` with n = 1, per table (a templated / plural value, so pinned). */
const EXECUTING_ONE_TOOL = {
  en: 'Executing 1 tool(s)...',
  pt: 'Executando 1 ferramenta...',
} as const;

/** response_language → the table its strings must come from. */
const LOCALE_CASES = [
  ['pt', 'pt'],
  ['en', 'en'],
  ['sw', 'en'],
] as const;

describe('Orchestrator status locale (#405)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(LOCALE_CASES)(
    'response_language %s → every status carries its key and the %s table message',
    async (responseLanguage, table) => {
      const turn = await runTurn(responseLanguage);
      const strings = UI_STRINGS[table];

      expect(turn.keys).toEqual([
        'status_processing',
        'status_executing_tools',
        'status_preparing',
        'status_executing_tools',
      ]);
      expect(turn.messages).toEqual([
        strings.status_processing,
        EXECUTING_ONE_TOOL[table],
        strings.status_preparing,
        EXECUTING_ONE_TOOL[table],
      ]);
    }
  );

  it.each(LOCALE_CASES)(
    'response_language %s → max-iterations notice is the %s paragraph, pushed to the response and streamed',
    async (responseLanguage, table) => {
      const turn = await runTurn(responseLanguage);
      const notice = UI_STRINGS[table].notice_max_iterations;

      expect(turn.responses.at(-1)).toBe(notice);
      expect(turn.progress).toContain(notice);
    }
  );

  it('contract: every emitted key is drawn from the closed StatusKey union', async () => {
    const turn = await runTurn('pt');
    expect(turn.keys.length).toBeGreaterThan(0);
    for (const key of turn.keys) expect(STATUS_KEYS).toContain(key);
    for (const message of turn.messages) expect(message.length).toBeGreaterThan(0);
  });
});
