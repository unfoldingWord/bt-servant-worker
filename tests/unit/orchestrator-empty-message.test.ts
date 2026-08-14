/**
 * Outbound-request invariant: no user turn may ever be empty (#360).
 *
 * The unit tests around `resolveTurnMessage` pin the specific bug — a
 * trigger-only message stripping to `''`. These tests pin the INVARIANT that
 * bug violated, at the last point before the request leaves the worker:
 *
 *   every user message in the outbound Anthropic payload has non-empty content
 *
 * That matters because #360 was never really about triggers. The Anthropic API
 * rejects the ENTIRE request when any user turn is empty, so ONE empty string
 * from ANY caller costs the whole turn — the user gets a 502 and no reply. The
 * original guard (`strippedMessage: rest || messageText`) lived in the
 * classifier and was silently dropped by an unrelated refactor in 6f19b20; it
 * had no test, so nothing noticed for 93 days.
 *
 * These tests do not care where an empty message comes from. They assert the
 * worker cannot emit one, which is the property that actually needs to hold.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import { ToolCatalog } from '../../src/services/mcp/index.js';
import { RequestLogger } from '../../src/utils/logger.js';
import { ChatHistoryEntry } from '../../src/types/engine.js';
import { Env } from '../../src/config/types.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

function createMockLogger(): RequestLogger {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as RequestLogger;
}

/**
 * Minimal end_turn reply. `orchestrate()` takes the non-streaming path when no
 * `callbacks` are supplied (see callClaude), so this is plain JSON, not SSE —
 * we only care about the REQUEST here, not the reply.
 */
function endTurnResponse(): string {
  return JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: 'ok' }],
  });
}

interface OutboundMessage {
  role: string;
  content: unknown;
}

/** Mock the Anthropic HTTP call and capture every outbound request body. */
function captureOutboundRequests(): OutboundMessage[][] {
  const captured: OutboundMessage[][] = [];

  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { messages: OutboundMessage[] };
    captured.push(body.messages);
    return new Response(endTurnResponse(), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return captured;
}

function baseOptions(logger: RequestLogger, history: ChatHistoryEntry[] = []) {
  return {
    env: { ANTHROPIC_API_KEY: 'test-key' } as Env,
    catalog: { tools: [], serverMap: new Map() } as ToolCatalog,
    history,
    preferences: { response_language: 'en', first_interaction: false },
    logger,
  };
}

/** Content is "empty" if it is '', whitespace, or an empty block array. */
function isEmptyContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return content === null || content === undefined;
}

afterEach(() => vi.restoreAllMocks());

describe('orchestrate() — outbound user turns are never empty (#360)', () => {
  it('never sends an empty user turn even when handed an empty message', async () => {
    const captured = captureOutboundRequests();

    await orchestrate('', baseOptions(createMockLogger()));

    expect(captured.length).toBeGreaterThan(0);
    for (const messages of captured) {
      const emptyUserTurns = messages.filter((m) => m.role === 'user' && isEmptyContent(m.content));
      // This is the exact condition the Anthropic API rejects with
      // "messages.N: user messages must have non-empty content".
      expect(emptyUserTurns).toEqual([]);
    }
  });

  it('never sends an empty user turn for a whitespace-only message', async () => {
    const captured = captureOutboundRequests();

    await orchestrate('   \n  ', baseOptions(createMockLogger()));

    for (const messages of captured) {
      expect(messages.filter((m) => m.role === 'user' && isEmptyContent(m.content))).toEqual([]);
    }
  });

  it('holds when prior history is present (the shape that broke in prod)', async () => {
    // Elsy's failing request was `messages.10` — the current turn at the end of
    // a populated history. A guard that only handles the no-history case would
    // pass the tests above and still fail the way prod actually failed.
    const captured = captureOutboundRequests();
    const history: ChatHistoryEntry[] = [
      { user_message: 'hello', assistant_message: 'hi there' },
      { user_message: 'who wrote Luke?', assistant_message: 'Luke did.' },
    ];

    await orchestrate('', baseOptions(createMockLogger(), history));

    for (const messages of captured) {
      expect(messages.filter((m) => m.role === 'user' && isEmptyContent(m.content))).toEqual([]);
      // History must survive intact — the backstop replaces the turn, not the thread.
      expect(messages.length).toBeGreaterThan(1);
    }
  });
});

describe('orchestrate() — empty-message backstop is observable and inert otherwise', () => {
  it('logs the empty message at ERROR level rather than swallowing it', async () => {
    // Degrading quietly would trade a loud 502 for a silent wrong answer, and
    // hide the upstream bug that produced the empty turn. Per CLAUDE.md this
    // must be observable.
    captureOutboundRequests();
    const logger = createMockLogger();

    await orchestrate('', baseOptions(logger));

    expect(logger.error).toHaveBeenCalledWith(
      'empty_user_message',
      expect.any(Error),
      expect.objectContaining({ history_length: 0 })
    );
  });

  it('leaves an ordinary message completely untouched', async () => {
    const captured = captureOutboundRequests();

    await orchestrate('who wrote the gospel of Luke?', baseOptions(createMockLogger()));

    const lastUserTurn = captured[0]?.filter((m) => m.role === 'user').pop();
    expect(JSON.stringify(lastUserTurn?.content)).toContain('who wrote the gospel of Luke?');
  });

  it('does not log empty_user_message for an ordinary message', async () => {
    captureOutboundRequests();
    const logger = createMockLogger();

    await orchestrate('a real question', baseOptions(logger));

    expect(logger.error).not.toHaveBeenCalledWith(
      'empty_user_message',
      expect.anything(),
      expect.anything()
    );
  });
});
