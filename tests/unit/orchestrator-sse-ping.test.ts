/**
 * Tests for Anthropic SSE `ping` event handling in the orchestrator's stream parser.
 *
 * Per https://docs.anthropic.com/en/docs/build-with-claude/streaming, `ping` events
 * are server keepalives that "may be sent between other events" — including before
 * `message_start`. The parser must treat them as no-ops regardless of state.
 *
 * Regression guard for issue #161, where an early `ping` threw
 * `Unexpected stream event before message_start: ping` and aborted the turn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import { ToolCatalog } from '../../src/services/mcp/index.js';
import { RequestLogger } from '../../src/utils/logger.js';
import { StreamCallbacks } from '../../src/types/engine.js';
import { Env } from '../../src/config/types.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

function createMockEnv(): Env {
  return { ANTHROPIC_API_KEY: 'test-key' } as Env;
}

function createMockCatalog(): ToolCatalog {
  return { tools: [], serverMap: new Map() };
}

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

function createMockCallbacks(progressChunks: string[]): StreamCallbacks {
  return {
    onProgress: vi.fn((text: string) => progressChunks.push(text)),
    onStatus: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
}

const PING_FRAME = `data: ${JSON.stringify({ type: 'ping' })}\n`;

/**
 * Build an SSE body for a single-iteration, end_turn message with one text block.
 * Ping frames can be injected at two positions:
 * - `beforeMessageStart: true` — ping arrives before message_start (issue #161 repro)
 * - `betweenContentBlocks: true` — ping arrives between content_block_start and _delta
 */
function buildSSEBodyWithPings(opts: {
  text: string;
  beforeMessageStart?: boolean;
  betweenContentBlocks?: boolean;
}): string {
  const lines: string[] = [];

  if (opts.beforeMessageStart) lines.push(PING_FRAME);

  const message: Anthropic.Message = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content: [{ type: 'text', text: opts.text, citations: null }],
  };

  lines.push(
    `data: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [] } })}\n`
  );
  lines.push(
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n`
  );

  if (opts.betweenContentBlocks) lines.push(PING_FRAME);

  lines.push(
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: opts.text } })}\n`
  );
  lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n`);
  lines.push(
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage })}\n`
  );
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n`);

  return lines.join('\n');
}

function mockFetchWithBody(body: string): void {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);

  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

describe('Orchestrator SSE parser — Anthropic ping events', () => {
  let progressChunks: string[];

  beforeEach(() => {
    progressChunks = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it('treats ping arriving before message_start as a no-op (issue #161)', async () => {
    mockFetchWithBody(buildSSEBodyWithPings({ text: 'hello world', beforeMessageStart: true }));

    const result = await orchestrate('test message', {
      env: createMockEnv(),
      catalog: createMockCatalog(),
      history: [],
      preferences: { response_language: 'en', first_interaction: true },
      logger: createMockLogger(),
      callbacks: createMockCallbacks(progressChunks),
    });

    expect(result.responses).toEqual(['hello world']);
    expect(progressChunks).toContain('hello world');
  });

  it('treats ping between content blocks as a no-op (regression guard)', async () => {
    mockFetchWithBody(buildSSEBodyWithPings({ text: 'hello world', betweenContentBlocks: true }));

    const result = await orchestrate('test message', {
      env: createMockEnv(),
      catalog: createMockCatalog(),
      history: [],
      preferences: { response_language: 'en', first_interaction: true },
      logger: createMockLogger(),
      callbacks: createMockCallbacks(progressChunks),
    });

    expect(result.responses).toEqual(['hello world']);
    expect(progressChunks).toContain('hello world');
  });
});
