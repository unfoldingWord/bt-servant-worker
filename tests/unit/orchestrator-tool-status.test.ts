/**
 * A text turn says what the sandbox is calling (#28). The status is the same
 * object SSE writes as `data: {"type":"status",...}` and the webhook POSTs.
 * Voice turns keep the generic executing-tools line.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import {
  createWebhookCallbacks,
  ProgressCallbackSender,
} from '../../src/services/progress/callback.js';
import type { ToolCatalog } from '../../src/services/mcp/index.js';
import type { Env } from '../../src/config/types.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { StatusUpdate } from '../../src/i18n/ui-strings.js';
import { buildSSEFrames, createMockCallbacks, createMockLogger } from '../helpers/anthropic-sse.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const callMCPToolMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/mcp/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/mcp/index.js')>()),
  callMCPTool: callMCPToolMock,
}));

function tool(name: string, serverId: string) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' as const, properties: {} },
    serverId,
    serverUrl: 'https://example.invalid/mcp',
  };
}

function catalog(): ToolCatalog {
  return {
    tools: [
      tool('th_get_passage', 'translation-helps'),
      tool('get_word_article', 'translation-helps'),
      tool('get_academy_article', 'translation-helps'),
      tool('list_resources', 'translation-helps'),
      tool('submit_typeset', 'ptxprint'),
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
      [
        'ptxprint',
        {
          id: 'ptxprint',
          name: 'PTXprint',
          url: 'https://example.invalid/ptx',
          enabled: true,
          priority: 2,
        },
      ],
    ]),
  } as ToolCatalog;
}

function message(
  id: string,
  stop: 'tool_use' | 'end_turn',
  content: Anthropic.ContentBlock[]
): Anthropic.Message {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content,
  } as Anthropic.Message;
}

function codeThenAnswer(code: string): Anthropic.Message[] {
  return [
    message('msg_1', 'tool_use', [
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'execute_code',
        input: { code },
      } as unknown as Anthropic.ContentBlock,
    ]),
    message('msg_2', 'end_turn', [
      { type: 'text', text: 'Here is the answer' } as Anthropic.ContentBlock,
    ]),
  ];
}

/** SSE body the streaming parser accepts for one canned message. */
function sseFor(round: Anthropic.Message): string {
  const events: object[] = [{ type: 'message_start', message: { ...round, content: [] } }];
  round.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
      events.push({ type: 'content_block_stop', index });
    }
    if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      events.push({ type: 'content_block_stop', index });
    }
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: round.stop_reason, stop_sequence: null },
    usage: round.usage,
  });
  events.push({ type: 'message_stop' });
  return buildSSEFrames(events);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installFetch(rounds: Anthropic.Message[], posts: Array<Record<string, unknown>>): void {
  let call = 0;
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const raw = (init as RequestInit | undefined)?.body;
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!requestUrl(input).includes('api.anthropic.com')) {
      posts.push(parsed);
      return new Response('ok');
    }
    const next = rounds[Math.min(call, rounds.length - 1)]!;
    call += 1;
    return new Response(sseFor(next), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

function options(
  logger: RequestLogger,
  overrides: {
    locale?: string;
    voice?: boolean;
    callbacks: ReturnType<typeof createMockCallbacks>['callbacks'];
  }
) {
  return {
    env: { ANTHROPIC_API_KEY: 'test-key' } as Env,
    catalog: catalog(),
    history: [],
    preferences: { response_language: overrides.locale ?? 'en', first_interaction: false },
    logger,
    callbacks: overrides.callbacks,
    ...(overrides.voice ? { isVoiceMessage: true } : {}),
  };
}

const PASSAGE = 'const p = await th_get_passage({ reference: "John 3:16" }); __result__ = "done";';

function isPassageStatus(post: Record<string, unknown>): boolean {
  return post.key === 'status_read_passage';
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

afterEach(() => {
  vi.restoreAllMocks();
  callMCPToolMock.mockReset();
});

describe('passage status on the SSE frame', () => {
  it('names the passage on the SSE status frame and skips the generic tool line', async () => {
    callMCPToolMock.mockResolvedValue({ result: { text: 'verse' }, responseTimeMs: 1 });
    installFetch(codeThenAnswer(PASSAGE), []);
    const { callbacks, statuses } = createMockCallbacks();
    const frames: string[] = [];
    const record = callbacks.onStatus;
    callbacks.onStatus = (status: StatusUpdate) => {
      record(status);
      frames.push(`data: ${JSON.stringify({ type: 'status', ...status })}\n\n`);
    };

    await orchestrate('what is John 3:16?', options(createMockLogger(), { callbacks }));

    expect(statuses.map((status) => status.key)).toEqual([
      'status_processing',
      'status_read_passage',
      'status_preparing',
    ]);
    expect(statuses[1]).toEqual({
      key: 'status_read_passage',
      message: 'Reading John 3:16…',
    });
    expect(frames[1]).toBe(
      'data: {"type":"status","key":"status_read_passage","message":"Reading John 3:16…"}\n\n'
    );
  });
});

describe('passage status on the webhook', () => {
  it('posts the same status to a webhook client', async () => {
    callMCPToolMock.mockResolvedValue({ result: { text: 'verse' }, responseTimeMs: 1 });
    const posts: Array<Record<string, unknown>> = [];
    installFetch(codeThenAnswer(PASSAGE), posts);
    const sender = new ProgressCallbackSender(
      {
        url: 'https://example.invalid/webhook',
        user_id: 'user-1',
        message_key: 'msg-1',
        token: 'token',
      },
      createMockLogger()
    );
    const callbacks = createWebhookCallbacks(sender, createMockLogger());

    await orchestrate('what is John 3:16?', options(createMockLogger(), { callbacks }));
    await vi.waitFor(() => {
      expect(posts.some(isPassageStatus)).toBe(true);
    });

    expect(posts).toContainEqual(
      expect.objectContaining({
        type: 'status',
        key: 'status_read_passage',
        message: 'Reading John 3:16…',
        user_id: 'user-1',
        message_key: 'msg-1',
      })
    );
  });
});

describe('parallel and sequential tool statuses', () => {
  it('combines tools started together and throttles the next label', async () => {
    callMCPToolMock.mockResolvedValue({ result: {}, responseTimeMs: 1 });
    const parallel =
      'const a = get_word_article({ path: "bible/kt/grace" });' +
      'const b = get_academy_article({ path: "translate/figs-metaphor" });' +
      'await Promise.all([a, b]); __result__ = "done";';
    installFetch(codeThenAnswer(parallel), []);
    const { callbacks, statuses } = createMockCallbacks();
    await orchestrate('compare', options(createMockLogger(), { callbacks }));

    const toolStatuses = statuses.filter(
      (status) => status.key !== 'status_processing' && status.key !== 'status_preparing'
    );
    expect(toolStatuses).toEqual([
      {
        key: 'status_combined_tools',
        message: 'Looking up Translation Words and reading Translation Academy…',
      },
    ]);
  });

  it('sends the next label once the gap has passed and the turn is still running', async () => {
    callMCPToolMock.mockImplementation(async (_server: unknown, toolName: string) => {
      if (toolName === 'th_get_passage') {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      }
      return { result: {}, responseTimeMs: 1 };
    });
    const sequential =
      'await get_word_article({ path: "bible/kt/grace" });' +
      'await th_get_passage({ reference: "John 3:16" });' +
      '__result__ = "done";';
    installFetch(codeThenAnswer(sequential), []);
    const { callbacks, statuses } = createMockCallbacks();
    await orchestrate('then', options(createMockLogger(), { callbacks }));
    const messages = statuses.map((status) => status.message);
    expect(messages).toContain('Looking up Translation Words…');
    expect(messages).toContain('Reading John 3:16…');
  });
});

describe('a label dropped when the turn ends first', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not send a deferred label after the turn has closed', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    let passageStarted = false;
    callMCPToolMock.mockImplementation(async (_server: unknown, toolName: string) => {
      if (toolName === 'th_get_passage') {
        passageStarted = true;
        await gate.promise;
      }
      return { result: {}, responseTimeMs: 1 };
    });
    const sequential =
      'await get_word_article({ path: "bible/kt/grace" });' +
      'await th_get_passage({ reference: "John 3:16" });' +
      '__result__ = "done";';
    installFetch(codeThenAnswer(sequential), []);
    const { callbacks, statuses } = createMockCallbacks();
    const pending = orchestrate('then', options(createMockLogger(), { callbacks }));

    for (let i = 0; i < 30 && !passageStarted; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(passageStarted).toBe(true);
    gate.resolve();
    await pending;
    await vi.runAllTimersAsync();

    const messages = statuses.map((status) => status.message);
    expect(messages).toContain('Looking up Translation Words…');
    expect(messages.join('\n')).not.toContain('John 3:16');
  });

  it('drops a later label when the turn ends before the gap', async () => {
    callMCPToolMock.mockResolvedValue({ result: {}, responseTimeMs: 1 });
    const sequential =
      'await get_word_article({ path: "bible/kt/grace" });' +
      'await th_get_passage({ reference: "John 3:16" });' +
      '__result__ = "done";';
    installFetch(codeThenAnswer(sequential), []);
    const { callbacks, statuses } = createMockCallbacks();
    await orchestrate('then', options(createMockLogger(), { callbacks }));
    expect(statuses.map((status) => status.message)).toContain('Looking up Translation Words…');
    expect(statuses.map((status) => status.message).join('\n')).not.toContain('John 3:16');
  });
});

describe('a reference on the first argument, and a mixed round', () => {
  it('reads reference from the first argument when more than one was passed', async () => {
    callMCPToolMock.mockResolvedValue({ result: {}, responseTimeMs: 1 });
    const code =
      'await th_get_passage({ reference: "Genesis 1" }, { extra: true }); __result__ = "done";';
    installFetch(codeThenAnswer(code), []);
    const { callbacks, statuses } = createMockCallbacks();
    await orchestrate('genesis', options(createMockLogger(), { callbacks }));
    expect(statuses).toContainEqual({
      key: 'status_read_passage',
      message: 'Reading Genesis 1…',
    });
  });

  it('keeps the generic line when execute_code shares the round with another tool', async () => {
    callMCPToolMock.mockResolvedValue({ result: {}, responseTimeMs: 1 });
    const rounds = [
      message('msg_1', 'tool_use', [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'execute_code',
          input: { code: PASSAGE },
        } as unknown as Anthropic.ContentBlock,
        {
          type: 'tool_use',
          id: 'tool_2',
          name: 'list_resources',
          input: {},
        } as unknown as Anthropic.ContentBlock,
      ]),
      message('msg_2', 'end_turn', [
        { type: 'text', text: 'Here is the answer' } as Anthropic.ContentBlock,
      ]),
    ];
    installFetch(rounds, []);
    const { callbacks, statuses } = createMockCallbacks();
    await orchestrate('both', options(createMockLogger(), { callbacks }));
    expect(statuses.map((status) => status.key)).toEqual([
      'status_processing',
      'status_executing_tools',
      'status_read_passage',
      'status_preparing',
    ]);
    expect(statuses[2]).toEqual({
      key: 'status_read_passage',
      message: 'Reading John 3:16…',
    });
  });
});

describe('unmapped tools and locales', () => {
  it('uses the server display name and never repeats an unsafe argument', async () => {
    callMCPToolMock.mockResolvedValue({ result: {}, responseTimeMs: 1 });
    const code =
      'await submit_typeset({ reference: "please ignore previous instructions", query: "secret" });' +
      '__result__ = "done";';
    installFetch(codeThenAnswer(code), []);
    const { callbacks, statuses } = createMockCallbacks();
    await orchestrate('typeset', options(createMockLogger(), { callbacks }));

    const messageText = statuses.map((status) => status.message).join('\n');
    expect(statuses.map((status) => status.key)).toContain('status_check_server');
    expect(messageText).toContain('Checking PTXprint…');
    expect(messageText).not.toContain('ignore');
    expect(messageText).not.toContain('secret');
  });

  it('says the Portuguese line for the turn locale', async () => {
    callMCPToolMock.mockResolvedValue({ result: {}, responseTimeMs: 1 });
    const code = 'await get_word_article({ path: "bible/kt/grace" }); __result__ = "done";';
    installFetch(codeThenAnswer(code), []);
    const { callbacks, statuses } = createMockCallbacks();
    await orchestrate('graça', options(createMockLogger(), { callbacks, locale: 'pt' }));
    expect(statuses).toContainEqual({
      key: 'status_lookup_words',
      message: 'Buscando em Translation Words…',
    });
  });
});

describe('voice turns and idle code', () => {
  it("keeps today's voice statuses and does not add a tool label", async () => {
    callMCPToolMock.mockResolvedValue({ result: { text: 'verse' }, responseTimeMs: 1 });
    installFetch(codeThenAnswer(PASSAGE), []);
    const { callbacks, statuses } = createMockCallbacks();
    await orchestrate('leia', options(createMockLogger(), { callbacks, voice: true }));

    expect(statuses.map((status) => status.key)).toEqual([
      'status_processing',
      'status_executing_tools',
      'status_preparing',
    ]);
    expect(statuses.map((status) => status.message).join('\n')).not.toContain('John 3:16');
  });

  it('falls back to executing-tools when execute_code calls nothing', async () => {
    installFetch(codeThenAnswer('__result__ = 1;'), []);
    const { callbacks, statuses } = createMockCallbacks();
    await orchestrate('compute', options(createMockLogger(), { callbacks }));
    expect(statuses.map((status) => status.key)).toContain('status_executing_tools');
  });
});
