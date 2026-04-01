/**
 * Tests for iteration separator behavior in the orchestrator.
 *
 * When Claude processes multiple iterations (e.g., tool calls followed by responses),
 * a separator is added between iterations for streaming output. This test verifies
 * the separator is a single newline, not double newlines.
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
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content,
  };
}

/** Create a mock MessageStream that emits text events and returns a final message. */
function createMockStream(message: Anthropic.Message) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
      return this;
    },
    async finalMessage() {
      // Fire text events for any text content blocks
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          for (const handler of listeners['text'] ?? []) {
            handler(block.text);
          }
        }
      }
      return message;
    },
  };
}

function setupMultiIterationMock() {
  let callCount = 0;
  const firstMessage = createMockMessage('msg_1', 'tool_use', [
    { type: 'text', text: 'Let me search for that' },
    {
      type: 'tool_use',
      id: 'tool_1',
      name: 'execute_code',
      input: { code: '__result__ = "test"' },
    },
  ]);
  const secondMessage = createMockMessage('msg_2', 'end_turn', [
    { type: 'text', text: 'Here is the answer' },
  ]);

  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    messages: {
      stream: vi.fn(() => {
        const isFirst = callCount === 0;
        callCount++;
        return createMockStream(isFirst ? firstMessage : secondMessage);
      }),
    },
  }));
}

function setupSingleIterationMock() {
  const message = createMockMessage('msg_1', 'end_turn', [
    { type: 'text', text: 'Single response' },
  ]);

  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    messages: {
      stream: vi.fn(() => createMockStream(message)),
    },
  }));
}

describe('Orchestrator iteration separator - multi iteration', () => {
  let progressChunks: string[];

  beforeEach(() => {
    progressChunks = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses single newline separator between iterations during streaming', async () => {
    setupMultiIterationMock();
    await orchestrate('test message', {
      env: createMockEnv(),
      catalog: createMockCatalog(),
      history: [],
      preferences: { response_language: 'en', first_interaction: true },
      logger: createMockLogger(),
      callbacks: createMockCallbacks(progressChunks),
    });
    expect(progressChunks.filter((c) => c === '\n').length).toBe(1);
    expect(progressChunks.filter((c) => c === '\n\n').length).toBe(0);
  });
});

describe('Orchestrator iteration separator - single iteration', () => {
  let progressChunks: string[];

  beforeEach(() => {
    progressChunks = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not add separator on first iteration', async () => {
    setupSingleIterationMock();
    await orchestrate('test message', {
      env: createMockEnv(),
      catalog: createMockCatalog(),
      history: [],
      preferences: { response_language: 'en', first_interaction: true },
      logger: createMockLogger(),
      callbacks: createMockCallbacks(progressChunks),
    });
    expect(progressChunks.filter((c) => c === '\n').length).toBe(0);
  });
});
