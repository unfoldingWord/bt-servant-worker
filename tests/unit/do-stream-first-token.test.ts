/**
 * Tests the `stream_first_token` predicate in `UserDO.buildSSESender` (#410).
 *
 * The metric must time the first *word*, not the first frame. Before the fix it
 * fired on any `progress` event, so on a tools-first turn it timed the
 * inter-iteration separator — 27.6s recorded against 47.3s of real wait on one
 * staging turn. Gating the separator in the orchestrator removes the usual
 * source of a whitespace-only frame, but not the possibility: `applyContentDelta`
 * forwards raw `text_delta` chunks, so a response can legitimately open with one.
 * This test pins the predicate itself, which the orchestrator test cannot reach.
 *
 * `buildSSESender` is private; it is reached through a typed cast, the same way
 * `do-status-locale.test.ts` reaches the DO's other private methods. Everything
 * from the emit site outward — the writer, the wire frames — is real code.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { UserDO } from '../../src/durable-objects/user-do.js';
import type { SSEEvent } from '../../src/types/engine.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { Env } from '../../src/config/types.js';

/** The private surface this test reaches into. */
interface UserDOSSEInternals {
  buildSSESender(
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
    logger: RequestLogger,
    startTime: number
  ): {
    sendEvent: (event: SSEEvent) => Promise<void>;
    keepaliveInterval: ReturnType<typeof setInterval>;
    state: { clientDisconnected: boolean; firstTokenTime: number | null };
  };
}

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

function createDO(): UserDOSSEInternals {
  const state = {
    storage: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), setAlarm: vi.fn() },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
  const env = { DEFAULT_ORG: 'unfoldingWord' } as unknown as Env;
  return new UserDO(state, env) as unknown as UserDOSSEInternals;
}

/** Every `stream_first_token` call the sender made. */
function firstTokenLogs(logger: RequestLogger): unknown[][] {
  const log = logger.log as unknown as ReturnType<typeof vi.fn>;
  return log.mock.calls.filter((call: unknown[]) => call[0] === 'stream_first_token');
}

/**
 * Drain the readable concurrently — a TransformStream backpressures after one
 * queued chunk, so an undrained writer deadlocks the second `sendEvent`.
 */
function drain(readable: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(readable).text();
}

/** A sender wired to a live stream, plus the frames it put on the wire. */
async function withSender(
  body: (send: (event: SSEEvent) => Promise<void>, logger: RequestLogger) => Promise<void>
): Promise<{ logger: RequestLogger; wire: string }> {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const logger = createMockLogger();
  const { sendEvent, keepaliveInterval } = createDO().buildSSESender(writer, logger, Date.now());
  const drained = drain(readable);
  try {
    await body(sendEvent, logger);
  } finally {
    clearInterval(keepaliveInterval);
    await writer.close();
  }
  return { logger, wire: await drained };
}

describe('stream_first_token predicate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ignores whitespace-only progress and fires once on the first real text', async () => {
    const { logger } = await withSender(async (send, log) => {
      await send({ type: 'progress', text: '\n' });
      await send({ type: 'progress', text: '   ' });
      expect(firstTokenLogs(log)).toHaveLength(0);

      await send({ type: 'progress', text: 'Bem-vindo' });
      expect(firstTokenLogs(log)).toHaveLength(1);

      await send({ type: 'progress', text: ' e obrigado' });
    });

    const calls = firstTokenLogs(logger);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ time_to_first_token_ms: expect.any(Number) });
  });

  it('never fires for a non-progress frame', async () => {
    const { logger } = await withSender(async (send) => {
      await send({ type: 'status', key: 'status_preparing', message: 'Preparing…' });
      await send({ type: 'tool_use', tool: 'execute_code', input: {} });
    });
    expect(firstTokenLogs(logger)).toHaveLength(0);
  });

  it('still writes whitespace-only progress to the wire', async () => {
    const { wire } = await withSender(async (send) => {
      await send({ type: 'progress', text: '\n' });
      await send({ type: 'progress', text: 'Bem-vindo' });
    });
    const frames = wire
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice('data: '.length)) as SSEEvent);
    expect(frames).toEqual([
      { type: 'progress', text: '\n' },
      { type: 'progress', text: 'Bem-vindo' },
    ]);
  });
});
