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

import { describe, it, expect, vi, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import {
  buildSSEFrames,
  createMockCallbacks,
  createMockCatalog,
  createMockEnv,
  createMockLogger,
  mockAnthropicFetch,
} from '../helpers/anthropic-sse.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const PING = { type: 'ping' };

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

  return buildSSEFrames([
    ...(opts.beforeMessageStart ? [PING] : []),
    { type: 'message_start', message: { ...message, content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...(opts.betweenContentBlocks ? [PING] : []),
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: opts.text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: message.usage,
    },
    { type: 'message_stop' },
  ]);
}

async function runTurn(body: string): Promise<{ responses: string[]; progress: string[] }> {
  mockAnthropicFetch(body);
  const { callbacks, progress } = createMockCallbacks();
  const result = await orchestrate('test message', {
    env: createMockEnv(),
    catalog: createMockCatalog(),
    history: [],
    preferences: { response_language: 'en', first_interaction: true },
    logger: createMockLogger(),
    callbacks,
  });
  return { responses: result.responses, progress };
}

describe('Orchestrator SSE parser — Anthropic ping events', () => {
  afterEach(() => vi.restoreAllMocks());

  it('treats ping arriving before message_start as a no-op (issue #161)', async () => {
    const turn = await runTurn(
      buildSSEBodyWithPings({ text: 'hello world', beforeMessageStart: true })
    );

    expect(turn.responses).toEqual(['hello world']);
    expect(turn.progress).toContain('hello world');
  });

  it('treats ping between content blocks as a no-op (regression guard)', async () => {
    const turn = await runTurn(
      buildSSEBodyWithPings({ text: 'hello world', betweenContentBlocks: true })
    );

    expect(turn.responses).toEqual(['hello world']);
    expect(turn.progress).toContain('hello world');
  });
});
