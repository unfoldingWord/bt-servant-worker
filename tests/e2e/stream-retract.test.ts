/**
 * #421: byte-level check of the `retract` frame on the real `/chat/stream`
 * path through a UserDO, with the Anthropic call intercepted at
 * `globalThis.fetch`.
 *
 * Asserts the exact bytes a client reads, so the frame shape in the README
 * spec ("SSE Event Types") is what actually goes on the wire:
 *
 *   data: {"type":"retract","iteration":0,"chars":20}\n\n
 *
 * and that the `complete` payload and the saved history carry only the text
 * streamed after the last retract. Skipped on Windows (SQLite/workerd). Runs in CI.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { buildChatBody } from '../helpers/anthropic-capture.js';
import { anthropicRound, EXECUTE_CODE_TOOL } from '../helpers/anthropic-sse.js';
import type { ChatResponse } from '../../src/types/engine.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const NARRATION = 'Let me look that up.';
const ANSWER = 'Here is the answer.';

/** Serve canned rounds to the Anthropic URL in order; pass everything else through. */
function mockAnthropicRounds(rounds: string[]): { calls: () => number } {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const realFetch = globalThis.fetch.bind(globalThis);
  let call = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes('api.anthropic.com')) return realFetch(input, init);
    const body = rounds[call];
    call += 1;
    if (body === undefined) throw new Error(`unexpected Anthropic call #${call}`);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { calls: () => call };
}

/** The raw SSE body, split into its `data:` JSON frames (keepalives dropped). */
function frames(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>)
    .filter((frame) => frame.type !== 'keepalive');
}

async function streamTurn(stub: DurableObjectStub): Promise<string> {
  const response = await stub.fetch('http://fake-host/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildChatBody({ message: 'What does Psalm 23 mean?' })),
  });
  expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  return response.text();
}

async function historyAnswers(stub: DurableObjectStub): Promise<string[]> {
  const response = await stub.fetch('http://fake-host/history?user_id=test-user');
  const data = (await response.json()) as { entries: Array<{ assistant_response: string }> };
  return data.entries.map((entry) => entry.assistant_response);
}

describe('/chat/stream retract frame on the wire (#421)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
  });

  afterEach(() => vi.restoreAllMocks());

  it('streams the narration, then retracts it with the exact frame bytes, then the answer', async () => {
    mockAnthropicRounds([
      anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, EXECUTE_CODE_TOOL]),
      anthropicRound('end_turn', [{ type: 'text', text: ANSWER }]),
    ]);
    const raw = await streamTurn(stub);

    // Exact bytes: the narration frame, immediately followed by the retract frame.
    expect(raw).toContain(
      `data: {"type":"progress","text":"${NARRATION}"}\n\n` +
        `data: {"type":"retract","iteration":0,"chars":${NARRATION.length}}\n\n`
    );
    expect(raw).toContain(`data: {"type":"progress","text":"${ANSWER}"}\n\n`);

    const events = frames(raw);
    const textEvents = events.filter((e) => e.type === 'progress' || e.type === 'retract');
    expect(textEvents).toEqual([
      { type: 'progress', text: NARRATION },
      { type: 'retract', iteration: 0, chars: NARRATION.length },
      { type: 'progress', text: ANSWER },
    ]);
    // The retract lands before the tools run.
    const retractAt = events.findIndex((e) => e.type === 'retract');
    const toolsAt = events.findIndex(
      (e) => e.type === 'status' && e.key === 'status_executing_tools'
    );
    expect(retractAt).toBeGreaterThanOrEqual(0);
    expect(retractAt).toBeLessThan(toolsAt);

    const complete = events.find((e) => e.type === 'complete') as { response: ChatResponse };
    expect(complete.response.responses).toEqual([ANSWER]);
    expect(events.at(-1)?.type).toBe('complete');

    expect(await historyAnswers(stub)).toEqual([ANSWER]);
  });
});

describe('/chat/stream single-round and recovery turns (#421, #158)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
  });

  afterEach(() => vi.restoreAllMocks());

  it('sends no retract frame on a single-round turn', async () => {
    mockAnthropicRounds([anthropicRound('end_turn', [{ type: 'text', text: ANSWER }])]);
    const raw = await streamTurn(stub);
    expect(raw).not.toContain('"type":"retract"');
    const complete = frames(raw).find((e) => e.type === 'complete') as { response: ChatResponse };
    expect(complete.response.responses).toEqual([ANSWER]);
  });

  it('recovers an empty final round with one tools-off call (#158)', async () => {
    const mock = mockAnthropicRounds([
      anthropicRound('tool_use', [{ type: 'text', text: NARRATION }, EXECUTE_CODE_TOOL]),
      anthropicRound('end_turn', []),
      anthropicRound('end_turn', [{ type: 'text', text: ANSWER }]),
    ]);
    const raw = await streamTurn(stub);
    expect(mock.calls()).toBe(3);
    const complete = frames(raw).find((e) => e.type === 'complete') as { response: ChatResponse };
    expect(complete.response.responses).toEqual([ANSWER]);
    expect(await historyAnswers(stub)).toEqual([ANSWER]);
  });
});
