/**
 * Tests for iteration separator behavior in the orchestrator.
 *
 * When Claude processes multiple iterations (e.g., tool calls followed by responses),
 * a separator is added between iterations for streaming output. This test verifies
 * the separator is a single space, not double newlines.
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

function createMockStream(textToEmit: string, finalMessage: Anthropic.Message) {
  const emitText = (callback: (text: string) => void) => setTimeout(() => callback(textToEmit), 0);
  const onHandler = vi.fn((event: string, callback: (text: string) => void) => {
    if (event === 'text') emitText(callback);
    return { on: vi.fn() };
  });
  const finalMessageFn = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return finalMessage;
  });
  return { on: onHandler, finalMessage: finalMessageFn };
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

  const mockStream = vi.fn().mockImplementation(() => {
    const isFirst = callCount === 0;
    callCount++;
    return createMockStream(
      isFirst ? 'Let me search for that' : 'Here is the answer',
      isFirst ? firstMessage : secondMessage
    );
  });

  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    messages: { stream: mockStream, create: vi.fn() },
  }));
}

function setupSingleIterationMock() {
  const message = createMockMessage('msg_1', 'end_turn', [
    { type: 'text', text: 'Single response' },
  ]);
  const mockStream = vi.fn().mockImplementation(() => createMockStream('Single response', message));
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    messages: { stream: mockStream, create: vi.fn() },
  }));
}

describe('Orchestrator iteration separator - multi iteration', () => {
  let progressChunks: string[];

  beforeEach(() => {
    progressChunks = [];
  });
  afterEach(() => vi.clearAllMocks());

  it('uses single space separator between iterations during streaming', async () => {
    setupMultiIterationMock();
    await orchestrate('test message', {
      env: createMockEnv(),
      catalog: createMockCatalog(),
      history: [],
      preferences: { response_language: 'en', first_interaction: true },
      logger: createMockLogger(),
      callbacks: createMockCallbacks(progressChunks),
    });
    expect(progressChunks.filter((c) => c === ' ').length).toBe(1);
    expect(progressChunks.filter((c) => c === '\n\n').length).toBe(0);
  });
});

describe('Orchestrator iteration separator - single iteration', () => {
  let progressChunks: string[];

  beforeEach(() => {
    progressChunks = [];
  });
  afterEach(() => vi.clearAllMocks());

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
    expect(progressChunks.filter((c) => c === ' ').length).toBe(0);
  });
});
