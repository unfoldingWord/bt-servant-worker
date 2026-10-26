/**
 * History hardening at the model boundary (#403).
 *
 * Once a fallback model may sit on the other end, two shapes that Anthropic
 * tolerates in a RESPONSE but rejects in the next REQUEST must never reach the
 * stored history: a `tool_use.input` that stayed a raw string because its JSON
 * never parsed, and an empty text block. Both are observable only in the body
 * of the NEXT call, so the assertions read the second request.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import {
  buildSSEFrames,
  createMockCallbacks,
  createMockCatalog,
  createMockEnv,
  createMockLogger,
} from '../helpers/anthropic-sse.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const usage = { input_tokens: 1, output_tokens: 1 };

/** Iteration 1: an empty text block + a tool_use whose JSON never parses. */
const BROKEN_TOOL_TURN = buildSSEFrames([
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: null,
      usage,
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'tool_1', name: 'execute_code', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{not json' },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage },
  { type: 'message_stop' },
]);

const FINAL_TURN = buildSSEFrames([
  {
    type: 'message_start',
    message: {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: null,
      usage,
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage },
  { type: 'message_stop' },
]);

afterEach(() => vi.restoreAllMocks());

describe('assistant history pushed after a malformed response', () => {
  it('coerces an unparseable tool input to {} and drops the empty text block', async () => {
    const bodies: Array<{ messages: Anthropic.MessageParam[] }> = [];
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
      this: object
    ) {
      return this;
    } as unknown as () => object);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse((init as RequestInit).body as string));
      return new Response(bodies.length === 1 ? BROKEN_TOOL_TURN : FINAL_TURN, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const logger = createMockLogger();

    const result = await orchestrate('hello', {
      env: createMockEnv(),
      catalog: createMockCatalog(),
      history: [],
      preferences: { response_language: 'en', first_interaction: false },
      logger,
      callbacks: createMockCallbacks().callbacks,
    });

    expect(result.responses).toEqual(['done']);
    expect(bodies).toHaveLength(2);
    const assistantTurn = bodies[1]!.messages.find((m) => m.role === 'assistant')!;
    const content = assistantTurn.content as Anthropic.ContentBlock[];
    expect(content.map((b) => b.type)).toEqual(['tool_use']);
    expect((content[0] as Anthropic.ToolUseBlock).input).toEqual({});

    const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warned).toContain('assistant_content_sanitized');
  });
});
