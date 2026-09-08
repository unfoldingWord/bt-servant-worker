/**
 * Per-turn telemetry captured by the orchestrator.
 *
 * The facts under test here were previously computed and discarded: the model
 * that answered, what the turn cost, how many iterations it took, why it
 * stopped. `OrchestrationResult` carried only text, so nothing downstream could
 * report on a turn.
 *
 * The assertion that earns this file is SUMMING: one turn can run many
 * generations, and the turn's cost is their sum. Reading usage off the final
 * response — the natural mistake — silently under-reports every multi-step turn.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import { ToolCatalog } from '../../src/services/mcp/index.js';
import { RequestLogger } from '../../src/utils/logger.js';
import { Env } from '../../src/config/types.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

// Only `callMCPTool` is faked; the rest of the MCP module (catalog helpers,
// health tracking) is the real thing, so a sandbox call still walks the whole
// validate → health-check → count path before it reaches the wire.
const callMCPToolMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/mcp/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/mcp/index.js')>()),
  callMCPTool: callMCPToolMock,
}));

const PER_CALL_INPUT = 10;
const PER_CALL_OUTPUT = 20;

interface LoggedEvent {
  event: string;
  data: Record<string, unknown>;
}

function createMockLogger(sink: LoggedEvent[]): RequestLogger {
  return {
    log: vi.fn((event: string, data: Record<string, unknown>) => sink.push({ event, data })),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as RequestLogger;
}

function baseOptions(logger: RequestLogger) {
  return {
    env: { ANTHROPIC_API_KEY: 'test-key' } as Env,
    catalog: { tools: [], serverMap: new Map() } as ToolCatalog,
    history: [],
    preferences: { response_language: 'en', first_interaction: true },
    logger,
  };
}

function createMockMessage(
  id: string,
  stopReason: 'tool_use' | 'end_turn',
  content: Anthropic.ContentBlock[]
): Anthropic.Message {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: PER_CALL_INPUT,
      output_tokens: PER_CALL_OUTPUT,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content,
  } as Anthropic.Message;
}

/** Non-streaming JSON response — the `transport: 'final'` path. */
function mockJsonResponses(messages: Anthropic.Message[]): void {
  let call = 0;
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const msg = messages[Math.min(call, messages.length - 1)];
    call++;
    return new Response(JSON.stringify(msg), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const TOOL_THEN_ANSWER = (): Anthropic.Message[] => [
  createMockMessage('msg_1', 'tool_use', [
    { type: 'text', text: 'Looking that up' } as Anthropic.ContentBlock,
    {
      type: 'tool_use',
      id: 'tool_1',
      name: 'execute_code',
      input: { code: '__result__ = "x"' },
    } as unknown as Anthropic.ContentBlock,
  ]),
  createMockMessage('msg_2', 'end_turn', [
    { type: 'text', text: 'Here is the answer' } as Anthropic.ContentBlock,
  ]),
];

/** A one-tool catalog so `fetch_scripture` is a real host function inside the sandbox. */
function scriptureCatalogOptions(logger: RequestLogger) {
  return {
    ...baseOptions(logger),
    catalog: {
      tools: [
        {
          name: 'fetch_scripture',
          description: 'Fetch a passage',
          inputSchema: { type: 'object' as const, properties: {} },
          serverId: 'translation-helps',
          serverUrl: 'https://example.invalid/mcp',
        },
      ],
      serverMap: new Map([
        [
          'translation-helps',
          {
            id: 'translation-helps',
            name: 'Translation Helps',
            url: 'https://example.invalid/mcp',
            enabled: true,
            priority: 1,
          },
        ],
      ]),
    } as ToolCatalog,
  };
}

/** execute_code whose body calls an MCP tool through its sandbox host function. */
const SANDBOX_MCP_CALL = (): Anthropic.Message[] => [
  createMockMessage('msg_1', 'tool_use', [
    {
      type: 'tool_use',
      id: 'tool_1',
      name: 'execute_code',
      input: {
        code: 'const p = await fetch_scripture({ reference: "John 3:16" }); __result__ = "done";',
      },
    } as unknown as Anthropic.ContentBlock,
  ]),
  createMockMessage('msg_2', 'end_turn', [
    { type: 'text', text: 'Here is the answer' } as Anthropic.ContentBlock,
  ]),
];

describe('orchestration telemetry — token accounting', () => {
  afterEach(() => vi.restoreAllMocks());

  it('SUMS usage across iterations rather than taking the last response', async () => {
    mockJsonResponses(TOOL_THEN_ANSWER());
    const result = await orchestrate('test', baseOptions(createMockLogger([])));

    expect(result.telemetry.iterations).toBe(2);
    // The whole point: 2 calls, not 1. Last-write-wins would give 10 / 20.
    expect(result.telemetry.usage.input_tokens).toBe(PER_CALL_INPUT * 2);
    expect(result.telemetry.usage.output_tokens).toBe(PER_CALL_OUTPUT * 2);
    expect(result.telemetry.usage.billable_input_tokens).toBe(PER_CALL_INPUT * 2);
  });

  it('reports a single-iteration turn without inflating counts', async () => {
    mockJsonResponses([
      createMockMessage('msg_1', 'end_turn', [
        { type: 'text', text: 'Direct answer' } as Anthropic.ContentBlock,
      ]),
    ]);
    const result = await orchestrate('test', baseOptions(createMockLogger([])));

    expect(result.telemetry.iterations).toBe(1);
    expect(result.telemetry.usage.input_tokens).toBe(PER_CALL_INPUT);
    expect(result.telemetry.usage.output_tokens).toBe(PER_CALL_OUTPUT);
  });
});

describe('orchestration telemetry — run shape', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports exitReason done and the final stop_reason', async () => {
    mockJsonResponses(TOOL_THEN_ANSWER());
    const result = await orchestrate('test', baseOptions(createMockLogger([])));

    expect(result.telemetry.exitReason).toBe('done');
    // The LAST response's stop_reason, not the first ('tool_use').
    expect(result.telemetry.finalStopReason).toBe('end_turn');
  });

  it('reports the requested model and a zero mcp call count', async () => {
    mockJsonResponses([
      createMockMessage('msg_1', 'end_turn', [
        { type: 'text', text: 'ok' } as Anthropic.ContentBlock,
      ]),
    ]);
    const result = await orchestrate('test', baseOptions(createMockLogger([])));

    expect(typeof result.telemetry.model).toBe('string');
    expect(result.telemetry.model.length).toBeGreaterThan(0);
    expect(result.telemetry.mcpCallsMade).toBe(0);
  });

  it('leaves modeSwitchedTo null when the turn never switched mode', async () => {
    mockJsonResponses([
      createMockMessage('msg_1', 'end_turn', [
        { type: 'text', text: 'ok' } as Anthropic.ContentBlock,
      ]),
    ]);
    const result = await orchestrate('test', baseOptions(createMockLogger([])));

    expect(result.telemetry.modeSwitchedTo).toBeNull();
  });
});

describe('orchestration telemetry — turn_id threading', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stamps the caller turn_id on every generation-level log', async () => {
    const sink: LoggedEvent[] = [];
    mockJsonResponses(TOOL_THEN_ANSWER());
    await orchestrate('test', { ...baseOptions(createMockLogger(sink)), turnId: 'turn-abc' });

    // request_id cannot be the join key: drainQueue reuses one logger across turns.
    for (const name of ['claude_request', 'claude_response', 'orchestration_summary']) {
      const entries = sink.filter((e) => e.event === name);
      expect(entries.length, `${name} should be logged`).toBeGreaterThan(0);
      for (const e of entries) expect(e.data.turn_id, `${name}.turn_id`).toBe('turn-abc');
    }
  });

  it('omits turn_id entirely when the caller supplies none', async () => {
    const sink: LoggedEvent[] = [];
    mockJsonResponses([
      createMockMessage('msg_1', 'end_turn', [
        { type: 'text', text: 'ok' } as Anthropic.ContentBlock,
      ]),
    ]);
    await orchestrate('test', baseOptions(createMockLogger(sink)));

    const responses = sink.filter((e) => e.event === 'claude_response');
    expect(responses.length).toBeGreaterThan(0);
    for (const e of responses) expect('turn_id' in e.data).toBe(false);
  });
});

describe('orchestration telemetry — rollup on orchestration_summary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('carries iterations, exit_reason and stop_reason for the downstream ingest', async () => {
    const sink: LoggedEvent[] = [];
    mockJsonResponses(TOOL_THEN_ANSWER());
    await orchestrate('test', baseOptions(createMockLogger(sink)));

    const summary = sink.find((e) => e.event === 'orchestration_summary');
    expect(summary).toBeDefined();
    expect(summary?.data.iterations).toBe(2);
    expect(summary?.data.exit_reason).toBe('done');
    expect(summary?.data.stop_reason).toBe('end_turn');
    expect(typeof summary?.data.model).toBe('string');
  });
});

describe('orchestration telemetry — tool calls', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records each tool call by name with server, timing and outcome — never its arguments', async () => {
    mockJsonResponses(TOOL_THEN_ANSWER());
    const result = await orchestrate('test', baseOptions(createMockLogger([])));

    expect(result.telemetry.toolCalls).toHaveLength(1);
    const [call] = result.telemetry.toolCalls;
    expect(call?.name).toBe('execute_code');
    expect(call?.server_id).toBeNull(); // a host tool, not an MCP server
    expect(typeof call?.started_at).toBe('number');
    expect(call?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof call?.ok).toBe('boolean');
    // The fixture's tool input must not leak into the record.
    expect(JSON.stringify(result.telemetry.toolCalls)).not.toContain('__result__');
  });

  it('records nothing for a turn that called no tools', async () => {
    mockJsonResponses([
      createMockMessage('msg_1', 'end_turn', [
        { type: 'text', text: 'ok' } as Anthropic.ContentBlock,
      ]),
    ]);
    const result = await orchestrate('test', baseOptions(createMockLogger([])));
    expect(result.telemetry.toolCalls).toEqual([]);
  });
});

/**
 * The calls the sandbox makes are the ones that actually hit an MCP server.
 * They never pass through the outer ToolUseBlock hook, so a turn whose
 * `execute_code` fetched scripture used to record the wrapper alone —
 * `tool_calls` said `execute_code`, `mcp_calls_made` said 1, and no consumer
 * could name the server tool that ran.
 */
describe('orchestration telemetry — tool calls made inside execute_code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    callMCPToolMock.mockReset();
  });

  it('records the MCP tool a sandbox host function called, with its server and via', async () => {
    callMCPToolMock.mockResolvedValue({
      result: { text: 'For God so loved the world' },
      metadata: undefined,
      responseTimeMs: 5,
    });
    mockJsonResponses(SANDBOX_MCP_CALL());
    const result = await orchestrate('test', scriptureCatalogOptions(createMockLogger([])));

    expect(result.telemetry.mcpCallsMade).toBe(1);
    expect(result.telemetry.toolCalls.map((c) => [c.name, c.server_id, c.via, c.ok])).toEqual([
      // The nested call completes first — the wrapper is only done once the sandbox is.
      ['fetch_scripture', 'translation-helps', 'execute_code', true],
      ['execute_code', null, null, true],
    ]);
    const [nested] = result.telemetry.toolCalls;
    expect(typeof nested?.started_at).toBe('number');
    expect(nested?.duration_ms).toBeGreaterThanOrEqual(0);
    // The reference the sandbox asked for is an argument, and arguments never ride along.
    expect(JSON.stringify(result.telemetry.toolCalls)).not.toContain('John 3:16');
  });

  it('records a failed sandbox call as a call that happened, not as silence', async () => {
    callMCPToolMock.mockRejectedValue(new Error('upstream exploded'));
    mockJsonResponses(SANDBOX_MCP_CALL());
    const result = await orchestrate('test', scriptureCatalogOptions(createMockLogger([])));

    const nested = result.telemetry.toolCalls.find((c) => c.name === 'fetch_scripture');
    expect(nested?.ok).toBe(false);
    expect(nested?.via).toBe('execute_code');
    expect(nested?.server_id).toBe('translation-helps');
    // The failure reached the model as a tool error, not as a silently empty result.
    expect(JSON.stringify(result.telemetry.toolCalls)).not.toContain('upstream exploded');
  });
});
