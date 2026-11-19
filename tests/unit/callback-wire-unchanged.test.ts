/**
 * #421 redo: the callback (webhook) transport must keep its exact output.
 *
 * Ian's hard requirements on #421 (2026-11-11): the gateways' narration stays
 * as it is today, and a `retract` frame is never POSTed to a callback webhook
 * (the gateways return 400 on an unknown event type). Only SSE gets retract.
 *
 * These tests drive the REAL orchestrator through the REAL DO webhook wiring
 * (`UserDO.buildWebhookCallbacks` → `createWebhookCallbacks` →
 * `ProgressCallbackSender`) with `fetch` split between a canned Anthropic
 * stream and a captured gateway URL. The expected POST sequences below were
 * recorded on `develop` (v2.62.6) BEFORE the retract change was written, and
 * the same file passes unchanged after it: that is the proof the callback
 * wire did not move.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import { UserDO } from '../../src/durable-objects/user-do.js';
import type { ChatRequest, ChatResponse, StreamCallbacks } from '../../src/types/engine.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { Env } from '../../src/config/types.js';
import { buildSSEFrames, createMockCatalog, createMockLogger } from '../helpers/anthropic-sse.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const GATEWAY_URL = 'https://gateway.example/progress-callback';

interface UserDOInternals {
  buildWebhookCallbacks(body: ChatRequest, logger: RequestLogger): StreamCallbacks | undefined;
}

function createDO(): UserDOInternals {
  const state = {
    storage: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      setAlarm: vi.fn(async () => undefined),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
  const env = {
    DEFAULT_ORG: 'unfoldingWord',
    ENGINE_API_KEY: 'test-engine-key',
  } as unknown as Env;
  return new UserDO(state, env) as unknown as UserDOInternals;
}

type Block =
  { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** The stream events for one content block. */
function blockEvents(block: Block, index: number): object[] {
  const start =
    block.type === 'text'
      ? { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
      : {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        };
  const delta =
    block.type === 'text'
      ? { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }
      : {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        };
  return [start, delta, { type: 'content_block_stop', index }];
}

/** One Anthropic streaming response, as SSE frames. */
function round(stopReason: 'tool_use' | 'end_turn', blocks: Block[]): string {
  const message = {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: null,
    stop_sequence: null,
    usage: USAGE,
    content: [],
  };
  return buildSSEFrames([
    { type: 'message_start', message },
    ...blocks.flatMap(blockEvents),
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: USAGE,
    },
    { type: 'message_stop' },
  ]);
}

const TOOL: Block = {
  type: 'tool_use',
  id: 'tool_1',
  name: 'execute_code',
  input: { code: '__result__ = "x"' },
};

/** Stub Anthropic with `rounds` in order and capture every gateway POST body. */
function wire(rounds: string[]): { posts: Array<Record<string, unknown>> } {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const posts: Array<Record<string, unknown>> = [];
  let call = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === GATEWAY_URL) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      delete body.timestamp;
      posts.push(body);
      return new Response('ok', { status: 200 });
    }
    const body = rounds[Math.min(call, rounds.length - 1)]!;
    call += 1;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return { posts };
}

/** Run one callback turn the way `processImmediateCallback` does. */
async function runCallbackTurn(
  progressMode: ChatRequest['progress_mode']
): Promise<ChatResponse['responses']> {
  const logger = createMockLogger();
  const body = {
    client_id: 'whatsapp',
    user_id: 'u1',
    message: 'hi',
    message_type: 'text',
    progress_callback_url: GATEWAY_URL,
    message_key: 'k1',
    progress_mode: progressMode,
  } as ChatRequest;
  const callbacks = createDO().buildWebhookCallbacks(body, logger)!;
  const result = await orchestrate('hi', {
    env: { ANTHROPIC_API_KEY: 'test-key' } as Env,
    catalog: createMockCatalog(),
    history: [],
    preferences: { response_language: 'en', first_interaction: false },
    logger,
    callbacks,
  });
  const response = { responses: result.responses } as ChatResponse;
  await callbacks.onComplete(response);
  // Let the fire-and-forget webhook sends settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return result.responses;
}

const base = { user_id: 'u1', message_key: 'k1' };
const status = (key: string, message: string) => ({ ...base, type: 'status', key, message });

describe('callback transport output is unchanged by the #421 redo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('iteration mode: narration still posts as its own progress message, then the answer', async () => {
    const { posts } = wire([
      round('tool_use', [{ type: 'text', text: 'Let me look that up.' }, TOOL]),
      round('end_turn', [{ type: 'text', text: 'Here is the answer.' }]),
    ]);
    const responses = await runCallbackTurn('iteration');

    expect(responses).toEqual(['Let me look that up.', 'Here is the answer.']);
    expect(posts).toEqual([
      status('status_processing', 'Processing your request...'),
      status('status_executing_tools', 'Executing 1 tool(s)...'),
      { ...base, type: 'progress', text: 'Let me look that up.' },
      status('status_preparing', 'Preparing your response...'),
      { ...base, type: 'complete', text: '\nHere is the answer.' },
    ]);
    expect(posts.some((p) => p.type === 'retract')).toBe(false);
  });

  it('iteration mode: a final round with no text still ends on the narration (no recovery call)', async () => {
    const { posts } = wire([
      round('tool_use', [{ type: 'text', text: 'Checking the notes.' }, TOOL]),
      round('end_turn', []),
    ]);
    const anthropicCalls = () =>
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([input]) => String(input instanceof Request ? input.url : input) !== GATEWAY_URL
      ).length;
    const responses = await runCallbackTurn('iteration');

    expect(responses).toEqual(['Checking the notes.']);
    expect(anthropicCalls()).toBe(2);
    expect(posts).toEqual([
      status('status_processing', 'Processing your request...'),
      status('status_executing_tools', 'Executing 1 tool(s)...'),
      { ...base, type: 'progress', text: 'Checking the notes.' },
      status('status_preparing', 'Preparing your response...'),
    ]);
  });

  it('complete mode: one complete POST carrying every round, as before', async () => {
    const { posts } = wire([
      round('tool_use', [{ type: 'text', text: 'Let me look that up.' }, TOOL]),
      round('end_turn', [{ type: 'text', text: 'Here is the answer.' }]),
    ]);
    await runCallbackTurn('complete');

    expect(posts).toEqual([
      { ...base, type: 'complete', text: 'Let me look that up.\nHere is the answer.' },
    ]);
  });
});
