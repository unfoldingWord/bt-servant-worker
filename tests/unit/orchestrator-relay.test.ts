/**
 * Orchestrator wiring for verbatim relay (#462).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import type { ToolCatalog } from '../../src/services/mcp/index.js';
import {
  createWebhookCallbacks,
  ProgressCallbackSender,
} from '../../src/services/progress/callback.js';
import { createRequestLogger } from '../../src/utils/logger.js';
import type { ChatResponse } from '../../src/types/engine.js';
import { UI_STRINGS } from '../../src/i18n/ui-strings.js';
import { formatRelayNote } from '../../src/services/claude/relay.js';
import {
  baseOpts,
  captureOutboundSSE,
  createMockLogger,
  createMockMessage,
  mcpRelayResult,
  mockAnthropicSSE,
  obsCatalog,
  progressCallbacks,
  mockAnthropicAndWebhookFetch,
  mockAnthropicSSEWithTextChunks,
  mockTimedSSEFrames,
  reconstructIterationText,
  sseFrame,
  buildCleanEofSSEBody,
  buildSSEBody,
  buildSSEBodyWithTextChunks,
  webhookTextBodies,
  type LoggedEvent,
} from './relay-test-helpers.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const callMCPToolMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/mcp/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/mcp/index.js')>()),
  callMCPTool: callMCPToolMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  callMCPToolMock.mockReset();
});

describe('inactive: byte-identical progress', () => {
  it('keeps {{relay:x}} bytes when RELAY_SERVER_IDS is empty', async () => {
    const progress: string[] = [];
    const text = 'Hello {{relay:obs-en-01-05-observation}} world';
    mockAnthropicSSE([createMockMessage('m1', 'end_turn', [{ type: 'text', text }])], true);
    await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: '' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(progress.join('')).toBe(text);
    expect(progress).toEqual(text.split(''));
  });
});

describe('inactive: multi-round exact sequence', () => {
  it('progress chunks and tool_result stay exact with relay off', async () => {
    callMCPToolMock.mockResolvedValue(mcpRelayResult('panel', 'SECRET'));
    const progress: string[] = [];
    const outbound: Array<Array<{ role: string; content: unknown }>> = [];
    captureOutboundSSE(
      [
        createMockMessage('m1', 'tool_use', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'fetch_obs_study_manual',
            input: {},
          } as Anthropic.ContentBlock,
          { type: 'text', text: 'See {{relay:panel}}' } as Anthropic.ContentBlock,
        ]),
        createMockMessage('m2', 'end_turn', [{ type: 'text', text: 'Done {{relay:panel}}' }]),
      ],
      outbound,
      true
    );
    await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: '' },
        callbacks: progressCallbacks(progress),
      })
    );
    const expected = [
      ...'See {{relay:panel}}'.split(''),
      '\n',
      ...'Done {{relay:panel}}'.split(''),
    ];
    expect(progress).toEqual(expected);
    const secondCall = JSON.stringify(outbound[1] ?? []);
    expect(secondCall).not.toContain('Relay blocks from this tool call');
    expect(secondCall).toContain('tool_result');
  });
});

describe('inactive: tool_result unchanged', () => {
  it('does not append a relay note', async () => {
    callMCPToolMock.mockResolvedValue(mcpRelayResult('obs-en-01-05-observation', '- Q1'));
    const outbound: Array<Array<{ role: string; content: unknown }>> = [];
    captureOutboundSSE(
      [
        createMockMessage('m1', 'tool_use', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'fetch_obs_study_manual',
            input: { story: 1 },
          } as Anthropic.ContentBlock,
        ]),
        createMockMessage('m2', 'end_turn', [{ type: 'text', text: 'done' }]),
      ],
      outbound
    );
    await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: '' },
        callbacks: progressCallbacks([]),
      })
    );
    expect(JSON.stringify(outbound[1])).not.toContain('Relay blocks from this tool call');
  });
});

describe('active: expand and note', () => {
  it('expands tokens and notes accepted ids', async () => {
    const progress: string[] = [];
    const relayText = '- Observation Q1\n- Observation Q2';
    callMCPToolMock.mockResolvedValue(mcpRelayResult('obs-en-01-05-observation', relayText));
    const outbound: Array<Array<{ role: string; content: unknown }>> = [];
    captureOutboundSSE(
      [
        createMockMessage('m1', 'tool_use', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'fetch_obs_study_manual',
            input: { story: 1 },
          } as Anthropic.ContentBlock,
        ]),
        createMockMessage('m2', 'end_turn', [
          { type: 'text', text: `Here:\n{{relay:obs-en-01-05-observation}}\nThanks` },
        ]),
      ],
      outbound,
      true
    );
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses.join('\n')).toBe(`Here:\n${relayText}\nThanks`);
    expect(progress.join('')).toBe(result.responses.join('\n'));
    expect(JSON.stringify(outbound[1])).toContain('Relay blocks from this tool call');
  });
});

describe('active: server not listed', () => {
  it('leaves tokens literal when relay is inactive for the catalog', async () => {
    callMCPToolMock.mockResolvedValue(mcpRelayResult('obs-en-01-05-observation', 'SECRET'));
    mockAnthropicSSE([
      createMockMessage('m1', 'tool_use', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'fetch_obs_study_manual',
          input: {},
        } as Anthropic.ContentBlock,
      ]),
      createMockMessage('m2', 'end_turn', [
        { type: 'text', text: '{{relay:obs-en-01-05-observation}}' },
      ]),
    ]);
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'other-server' },
        callbacks: progressCallbacks([]),
      })
    );
    expect(result.responses).toEqual(['{{relay:obs-en-01-05-observation}}']);
  });
});

describe('active: parallel tools', () => {
  it('gives each tool_use its own note ids', async () => {
    callMCPToolMock
      .mockResolvedValueOnce(mcpRelayResult('id-a', 'A'))
      .mockResolvedValueOnce(mcpRelayResult('id-b', 'B'));
    const catalog = {
      tools: [
        {
          name: 'tool_a',
          description: 'a',
          inputSchema: { type: 'object' as const, properties: {} },
          serverId: 'obs-5m-mcp',
          serverUrl: 'https://example.invalid/mcp',
        },
        {
          name: 'tool_b',
          description: 'b',
          inputSchema: { type: 'object' as const, properties: {} },
          serverId: 'obs-5m-mcp',
          serverUrl: 'https://example.invalid/mcp',
        },
      ],
      serverMap: obsCatalog().serverMap,
    } as ToolCatalog;
    const outbound: Array<Array<{ role: string; content: unknown }>> = [];
    captureOutboundSSE(
      [
        createMockMessage('m1', 'tool_use', [
          { type: 'tool_use', id: 't1', name: 'tool_a', input: {} } as Anthropic.ContentBlock,
          { type: 'tool_use', id: 't2', name: 'tool_b', input: {} } as Anthropic.ContentBlock,
        ]),
        createMockMessage('m2', 'end_turn', [
          { type: 'text', text: '{{relay:id-a}}+{{relay:id-b}}' },
        ]),
      ],
      outbound
    );
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        catalog,
        callbacks: progressCallbacks([]),
      })
    );
    expect(result.responses).toEqual(['A+B']);
    expect(JSON.stringify(outbound[1])).toContain('{{relay:id-a}}');
  });
});

// #410 equality (progress concat === responses.join('\\n')) holds for one
// text block per round. Two text blocks in one message and the truncation
// notice already differ by '\\n' on develop; that is unchanged.
function threeRoundMessages(middleText: string): Anthropic.Message[] {
  const tool = (id: string): Anthropic.ContentBlock =>
    ({
      type: 'tool_use',
      id,
      name: 'fetch_obs_study_manual',
      input: {},
    }) as Anthropic.ContentBlock;
  return [
    createMockMessage('m1', 'tool_use', [
      tool('t1'),
      { type: 'text', text: 'Intro' } as Anthropic.ContentBlock,
    ]),
    createMockMessage('m2', 'tool_use', [
      tool('t2'),
      { type: 'text', text: middleText } as Anthropic.ContentBlock,
    ]),
    createMockMessage('m3', 'end_turn', [{ type: 'text', text: 'Final' }]),
  ];
}

describe('active: #410 separator', () => {
  it('drops unknown-only round without an extra newline', async () => {
    const progress: string[] = [];
    callMCPToolMock.mockResolvedValue(mcpRelayResult('known', 'KNOWN'));
    mockAnthropicSSE(threeRoundMessages('{{relay:missing}}'));
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses).toEqual(['Intro', 'Final']);
    expect(progress.join('')).toBe(result.responses.join('\n'));
  });
});

describe('active: whitespace-only blocks', () => {
  it('holds whitespace-only expanded blocks out of progress and responses', async () => {
    const progress: string[] = [];
    callMCPToolMock.mockResolvedValue(mcpRelayResult('known', 'KNOWN'));
    mockAnthropicSSE(threeRoundMessages('{{relay:missing}}\n\n'));
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses).toEqual(['Intro', 'Final']);
    expect(progress.join('')).toBe('Intro\nFinal');
    expect(progress.join('')).not.toMatch(/\n\n/);
  });

  it('streams trailing whitespace after real text even when it arrives in a later delta', async () => {
    const progress: string[] = [];
    callMCPToolMock.mockResolvedValue(mcpRelayResult('known', 'KNOWN'));
    const round1 = createMockMessage('m1', 'tool_use', [
      {
        type: 'tool_use',
        id: 't1',
        name: 'fetch_obs_study_manual',
        input: {},
      } as Anthropic.ContentBlock,
      { type: 'text', text: 'Intro\n\n' } as Anthropic.ContentBlock,
    ]);
    const round2 = createMockMessage('m2', 'end_turn', [
      { type: 'text', text: 'Final answer' } as Anthropic.ContentBlock,
    ]);
    mockAnthropicSSEWithTextChunks([round1, round2], [[['Intro', '\n\n']], [['Final answer']]]);
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses).toEqual(['Intro\n\n', 'Final answer']);
    expect(progress.join('')).toBe(result.responses.join('\n'));
    expect(progress.join('')).toBe('Intro\n\n\nFinal answer');
  });
});

function executeCodeTool(id: string): Anthropic.ContentBlock {
  return {
    type: 'tool_use',
    id,
    name: 'execute_code',
    input: { code: 'await fetch_obs_study_manual({}); __result__ = "ok";' },
  } as Anthropic.ContentBlock;
}

function relayOnOpts(logger = createMockLogger(), extraEnv: Record<string, string> = {}) {
  return baseOpts(logger, {
    env: { RELAY_SERVER_IDS: 'obs-5m-mcp', ...extraEnv },
    callbacks: progressCallbacks([]),
  });
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('active: execute_code host call', () => {
  it('populates relay for the next round', async () => {
    callMCPToolMock.mockResolvedValue(mcpRelayResult('from-sandbox', 'SANDBOX'));
    mockAnthropicSSE([
      createMockMessage('m1', 'tool_use', [executeCodeTool('t1')]),
      createMockMessage('m2', 'end_turn', [{ type: 'text', text: '{{relay:from-sandbox}}' }]),
    ]);
    const result = await orchestrate('hi', relayOnOpts());
    expect(result.responses).toEqual(['SANDBOX']);
  });
});

describe('active: late host call after sandbox timeout (C2)', () => {
  it('does not register the late id or announce it in the note', async () => {
    const logs: LoggedEvent[] = [];
    callMCPToolMock.mockImplementation(async () => {
      await delayMs(200);
      return mcpRelayResult('late-id', 'SHOULD-NOT-APPEAR');
    });
    const outbound: Array<Array<{ role: string; content: unknown }>> = [];
    captureOutboundSSE(
      [
        createMockMessage('m1', 'tool_use', [executeCodeTool('t1')]),
        createMockMessage('m2', 'end_turn', [
          { type: 'text', text: 'X{{relay:late-id}}Y' } as Anthropic.ContentBlock,
        ]),
      ],
      outbound
    );
    const result = await orchestrate(
      'hi',
      relayOnOpts(createMockLogger(logs), { CODE_EXEC_TIMEOUT_MS: '50' })
    );
    await delayMs(300);
    expect(result.responses).toEqual(['XY']);
    expect(result.responses.join('')).not.toContain('SHOULD-NOT-APPEAR');
    expect(logs.some((l) => l.event === 'relay_late_block')).toBe(true);
    expect(JSON.stringify(outbound[1] ?? [])).not.toContain('late-id');
  });
});

describe('webhook iteration deltas', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reconstructs expanded text without dup or loss', async () => {
    const relayText = 'EXACT PANEL TEXT';
    callMCPToolMock.mockResolvedValue(mcpRelayResult('panel', relayText));
    const sender = new ProgressCallbackSender({
      url: 'https://example.com/webhook',
      user_id: 'u1',
      message_key: 'm1',
      token: 'tok',
    });
    const logger = createRequestLogger('relay-webhook-test');
    const callbacks = createWebhookCallbacks(sender, logger, { mode: 'iteration' });
    const fetchMock = mockAnthropicAndWebhookFetch(
      [
        createMockMessage('m1', 'tool_use', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'fetch_obs_study_manual',
            input: {},
          } as Anthropic.ContentBlock,
          { type: 'text', text: 'Prefix ' } as Anthropic.ContentBlock,
        ]),
        createMockMessage('m2', 'end_turn', [{ type: 'text', text: '{{relay:panel}}' }]),
      ],
      'example.com/webhook'
    );
    const result = await orchestrate(
      'hi',
      baseOpts(logger, {
        env: { ANTHROPIC_API_KEY: 'test-key', RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks,
      })
    );
    callbacks.onComplete({
      responses: result.responses,
      finalIterationStartIndex: result.finalIterationStartIndex,
    } as ChatResponse);
    await vi.runAllTimersAsync();
    const reconstructed = reconstructIterationText(
      webhookTextBodies(fetchMock, 'example.com/webhook')
    );
    expect(reconstructed).toBe(result.responses.join('\n'));
    expect(reconstructed).toContain(relayText);
    // periodic/sentence lastSentText quirks are pre-existing and untouched here.
  });
});

describe('active: empty-answer notice', () => {
  it('ends with the localized notice when the answer was only unusable tokens', async () => {
    const logs: LoggedEvent[] = [];
    const progress: string[] = [];
    const outbound: Array<Array<{ role: string; content: unknown }>> = [];
    captureOutboundSSE(
      [createMockMessage('m1', 'end_turn', [{ type: 'text', text: '{{relay:gone}}' }])],
      outbound
    );
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(logs), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses).toEqual([UI_STRINGS.en.notice_relay_empty]);
    expect(progress.join('')).toBe(UI_STRINGS.en.notice_relay_empty);
    expect(logs.some((l) => l.event === 'relay_empty_answer')).toBe(true);
    expect(outbound).toHaveLength(1);
  });

  it('emits the notice through the pending separator gate', async () => {
    const progress: string[] = [];
    callMCPToolMock.mockResolvedValue(mcpRelayResult('known', 'KNOWN'));
    mockAnthropicSSE([
      createMockMessage('m1', 'tool_use', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'fetch_obs_study_manual',
          input: {},
        } as Anthropic.ContentBlock,
        { type: 'text', text: 'Intro' } as Anthropic.ContentBlock,
      ]),
      createMockMessage('m2', 'end_turn', [{ type: 'text', text: '{{relay:gone}}' }]),
    ]);
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses).toEqual(['Intro', UI_STRINGS.en.notice_relay_empty]);
    expect(progress.join('')).toBe(result.responses.join('\n'));
  });
});

describe('active: truncation notice after a held separator', () => {
  it('releases the separator so progress matches responses', async () => {
    const progress: string[] = [];
    callMCPToolMock.mockResolvedValue(mcpRelayResult('known', 'KNOWN'));
    mockAnthropicSSE([
      createMockMessage('m1', 'tool_use', [
        { type: 'text', text: 'Intro' } as Anthropic.ContentBlock,
        {
          type: 'tool_use',
          id: 't1',
          name: 'fetch_obs_study_manual',
          input: {},
        } as Anthropic.ContentBlock,
      ]),
      createMockMessage('m2', 'max_tokens', [{ type: 'text', text: '{{relay:gone}}' }]),
    ]);
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses).toEqual(['Intro', UI_STRINGS.en.notice_answer_truncated]);
    expect(progress.join('')).toBe(result.responses.join('\n'));
  });
});

describe('active: no notice for a blank answer', () => {
  it('adds no notice when the model wrote no text at all', async () => {
    const logs: LoggedEvent[] = [];
    mockAnthropicSSE([createMockMessage('m1', 'end_turn', [{ type: 'text', text: '  \n' }])]);
    const result = await orchestrate('hi', relayOnOpts(createMockLogger(logs)));
    expect(result.responses).toEqual([]);
    expect(logs.some((l) => l.event === 'relay_empty_answer')).toBe(false);
  });
});

function mockAnthropicAndWebhookWithChunkedRound1(
  round1: Anthropic.Message,
  round2: Anthropic.Message,
  round1Chunks: string[][],
  webhookHost: string
): ReturnType<typeof vi.fn> {
  let call = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes(webhookHost)) return new Response('ok');
    const messages = [round1, round2];
    const msg = messages[Math.min(call, messages.length - 1)]!;
    const body =
      call === 0 ? buildSSEBodyWithTextChunks(msg, round1Chunks) : buildSSEBody(msg, false);
    call += 1;
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  return fetchMock;
}

describe('active: trailing whitespace + webhook reconstruction (C2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('iteration webhook matches responses.join when trailing ws streams after text', async () => {
    callMCPToolMock.mockResolvedValue(mcpRelayResult('known', 'KNOWN'));
    const sender = new ProgressCallbackSender({
      url: 'https://example.com/webhook',
      user_id: 'u1',
      message_key: 'm1',
      token: 'tok',
    });
    const logger = createRequestLogger('relay-ws-webhook');
    const callbacks = createWebhookCallbacks(sender, logger, { mode: 'iteration' });
    const round1 = createMockMessage('m1', 'tool_use', [
      {
        type: 'tool_use',
        id: 't1',
        name: 'fetch_obs_study_manual',
        input: {},
      } as Anthropic.ContentBlock,
      { type: 'text', text: 'Intro\n\n' } as Anthropic.ContentBlock,
    ]);
    const round2 = createMockMessage('m2', 'end_turn', [
      { type: 'text', text: 'Final answer' } as Anthropic.ContentBlock,
    ]);
    const fetchMock = mockAnthropicAndWebhookWithChunkedRound1(
      round1,
      round2,
      [['Intro', '\n\n']],
      'example.com/webhook'
    );
    const result = await orchestrate(
      'hi',
      baseOpts(logger, {
        env: { ANTHROPIC_API_KEY: 'test-key', RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks,
      })
    );
    callbacks.onComplete({
      responses: result.responses,
      finalIterationStartIndex: result.finalIterationStartIndex,
    } as ChatResponse);
    await vi.runAllTimersAsync();
    expect(reconstructIterationText(webhookTextBodies(fetchMock, 'example.com/webhook'))).toBe(
      result.responses.join('\n')
    );
  });
});

describe('active: id from another turn', () => {
  it('removes a token whose id was never published this turn', async () => {
    const progress: string[] = [];
    mockAnthropicSSE([
      createMockMessage('m1', 'end_turn', [{ type: 'text', text: 'X{{relay:from-prior-turn}}Y' }]),
    ]);
    // Recovery will fire (raw non-blank, expanded blank after unknown removal...
    // wait: expanded is "XY" which is non-blank — no recovery.
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses).toEqual(['XY']);
    expect(progress.join('')).toBe('XY');
  });
});

describe('active: note after tool error', () => {
  it('still appends the note when a later error follows a valid block', async () => {
    callMCPToolMock
      .mockResolvedValueOnce(mcpRelayResult('ok-id', 'OK'))
      .mockRejectedValueOnce(new Error('boom'));
    const catalog = {
      tools: [
        {
          name: 'tool_a',
          description: 'a',
          inputSchema: { type: 'object' as const, properties: {} },
          serverId: 'obs-5m-mcp',
          serverUrl: 'https://example.invalid/mcp',
        },
        {
          name: 'tool_b',
          description: 'b',
          inputSchema: { type: 'object' as const, properties: {} },
          serverId: 'obs-5m-mcp',
          serverUrl: 'https://example.invalid/mcp',
        },
      ],
      serverMap: obsCatalog().serverMap,
    } as ToolCatalog;
    const outbound: Array<Array<{ role: string; content: unknown }>> = [];
    captureOutboundSSE(
      [
        createMockMessage('m1', 'tool_use', [
          { type: 'tool_use', id: 't1', name: 'tool_a', input: {} } as Anthropic.ContentBlock,
          { type: 'tool_use', id: 't2', name: 'tool_b', input: {} } as Anthropic.ContentBlock,
        ]),
        createMockMessage('m2', 'end_turn', [{ type: 'text', text: '{{relay:ok-id}}' }]),
      ],
      outbound
    );
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        catalog,
        callbacks: progressCallbacks([]),
      })
    );
    expect(result.responses).toEqual(['OK']);
    const toolResults = JSON.stringify(outbound[1]);
    expect(toolResults).toContain('{{relay:ok-id}}');
    expect(toolResults).toContain('boom');
  });
});

describe('active: parallel execute_code notes', () => {
  it('gives each execute_code its exact accepted-id note', async () => {
    callMCPToolMock
      .mockResolvedValueOnce(mcpRelayResult('from-a', 'A'))
      .mockResolvedValueOnce(mcpRelayResult('from-b', 'B'));
    const outbound: Array<Array<{ role: string; content: unknown }>> = [];
    captureOutboundSSE(
      [
        createMockMessage('m1', 'tool_use', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'execute_code',
            input: { code: 'await fetch_obs_study_manual({}); __result__ = "a";' },
          } as Anthropic.ContentBlock,
          {
            type: 'tool_use',
            id: 't2',
            name: 'execute_code',
            input: { code: 'await fetch_obs_study_manual({}); __result__ = "b";' },
          } as Anthropic.ContentBlock,
        ]),
        createMockMessage('m2', 'end_turn', [
          { type: 'text', text: '{{relay:from-a}}+{{relay:from-b}}' },
        ]),
      ],
      outbound
    );
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks([]),
      })
    );
    expect(result.responses).toEqual(['A+B']);
    const secondCall = JSON.stringify(outbound[1] ?? []);
    // Each tool_result gets its own exact note (ids only for that call).
    expect(secondCall).toContain(JSON.stringify(formatRelayNote(['from-a'])).slice(1, -1));
    expect(secondCall).toContain(JSON.stringify(formatRelayNote(['from-b'])).slice(1, -1));
    expect(secondCall).not.toContain(
      JSON.stringify(formatRelayNote(['from-a', 'from-b'])).slice(1, -1)
    );
  });
});

describe('active: TTS input uses expanded final round', () => {
  it('finalIterationStartIndex slice is the expanded text', async () => {
    callMCPToolMock.mockResolvedValue(mcpRelayResult('panel', 'PANEL'));
    mockAnthropicSSE([
      createMockMessage('m1', 'tool_use', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'fetch_obs_study_manual',
          input: {},
        } as Anthropic.ContentBlock,
        { type: 'text', text: 'Narration' } as Anthropic.ContentBlock,
      ]),
      createMockMessage('m2', 'end_turn', [{ type: 'text', text: '{{relay:panel}}' }]),
    ]);
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks([]),
      })
    );
    const ttsInput = result.responses.slice(result.finalIterationStartIndex).join('\n');
    expect(ttsInput).toBe('PANEL');
    expect(ttsInput).not.toContain('{{relay:');
  });
});

describe('active: stalled cut token', () => {
  it('is not a deliverable partial', async () => {
    vi.useFakeTimers();
    const messageStart = sseFrame({
      type: 'message_start',
      message: {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const textStart = sseFrame({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    const delta = sseFrame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '{{relay:panel' },
    });
    mockTimedSSEFrames([messageStart, textStart, delta], { gapMs: 1_000, close: false });
    const pending = orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks([]),
      })
    );
    const settled = pending.then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e })
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await settled;
    vi.useRealTimers();
    expect(outcome.ok).toBe(false);
  });
});

describe('active: max_tokens with cut token', () => {
  it('keeps the truncation notice path', async () => {
    const progress: string[] = [];
    mockAnthropicSSE([
      createMockMessage('m1', 'max_tokens', [{ type: 'text', text: 'Hi {{relay:x' }]),
    ]);
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses).toEqual(['Hi ', UI_STRINGS.en.notice_answer_truncated]);
    expect(progress.at(-1)).toBe(UI_STRINGS.en.notice_answer_truncated);
    expect(progress.join('')).toContain('Hi ');
    expect(progress.join('')).not.toContain('{{relay:');
  });
});

describe('active: clean EOF flushes retained filter state', () => {
  it('flushes a cut opening so progress matches expanded responses', async () => {
    const progress: string[] = [];
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
      this: object
    ) {
      return this;
    } as unknown as () => object);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(buildCleanEofSSEBody('Hello {{re'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );
    const result = await orchestrate(
      'hi',
      baseOpts(createMockLogger(), {
        env: { RELAY_SERVER_IDS: 'obs-5m-mcp' },
        callbacks: progressCallbacks(progress),
      })
    );
    expect(result.responses.join('\n')).toBe(progress.join(''));
    expect(progress.join('')).toBe('Hello {{re');
  });
});
