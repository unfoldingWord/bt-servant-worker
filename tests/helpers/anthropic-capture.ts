/**
 * Shared harness for tests that drive `/chat/final` on a real UserDO with the
 * Anthropic call intercepted at `globalThis.fetch`.
 *
 * Why intercept at `globalThis.fetch` and not the Anthropic SDK methods:
 * `src/services/claude/orchestrator.ts` calls `globalThis.fetch` directly
 * because the SDK's internal fetch trips Cloudflare error 1003 inside a
 * Durable Object. The mock surfaces a minimal end_turn JSON response so the
 * non-streaming `/chat/final` path lands in `extractTextResponses` cleanly.
 *
 * The request logger writes one JSON line per call (src/utils/logger.ts), so
 * `console.log` / `console.warn` are captured and parsed back into
 * `{ event, payload }` records; a non-JSON line is kept as free text rather
 * than dropped, so a stray line stays visible to the test.
 *
 * Callers MUST still declare, at the top of their own file:
 *   vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));
 * `vi.mock` is hoisted per test file and cannot be centralized here.
 */
import { expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ChatResponse } from '../../src/types/engine.js';

export const ANTHROPIC_HOST = 'api.anthropic.com';

export interface CapturedAnthropicCall {
  /** The `system` prompt flattened back to text (see {@link renderSystem}). */
  system: string;
  body: Record<string, unknown>;
}

export interface LogRecord {
  event: string;
  /** Parsed JSON line, or `undefined` when the line was not structured. */
  payload: Record<string, unknown> | undefined;
}

export interface AnthropicCapture {
  calls: CapturedAnthropicCall[];
  /** `console.log` lines — where `logger.log` / `logger.info` records land. */
  logs: LogRecord[];
  /** `console.warn` lines — where `logger.warn` records land. */
  warnLogs: LogRecord[];
}

/** A text chat body; `defaults` are the per-suite identity, `overrides` win. */
export function buildChatBody(
  overrides: Partial<ChatRequest> & Pick<ChatRequest, 'message'>,
  defaults: Partial<ChatRequest> = {}
): ChatRequest {
  return {
    client_id: 'web',
    user_id: 'test-user',
    message_type: 'text',
    ...defaults,
    ...overrides,
  };
}

/**
 * Read the outbound request body regardless of fetch calling convention:
 * direct orchestrator calls pass (url, init) with a string body, but the OTel
 * fetch instrumentation (active inside the instrumented DO trace context)
 * normalizes to fetch(Request), where the body lives on the Request and
 * `init` is undefined.
 */
export async function readMockRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request) return input.clone().text();
  return '';
}

/**
 * Flatten the wire form of `system` back to the prompt text.
 *
 * Since prompt caching (issue #333) the worker sends `system` as an array of
 * text blocks — a stable, cache-marked prefix plus the per-request remainder —
 * rather than one string. The blocks concatenate back to exactly the same
 * prompt (the `'\n\n'` separator is carried inside the volatile block). The
 * string form is still handled so callers do not care which shape they get.
 */
export function renderSystem(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map((block) => (block as { text?: string }).text ?? '').join('');
}

/** Parse one console line back into a structured record; non-JSON is kept as free text. */
export function parseLogLine(raw: unknown): LogRecord {
  if (typeof raw !== 'string') return { event: String(raw), payload: undefined };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { event: typeof parsed.event === 'string' ? parsed.event : raw, payload: parsed };
  } catch {
    // Not a structured log line (some other console caller). Preserved as
    // text so the line is still visible to the test rather than dropped.
    return { event: raw, payload: undefined };
  }
}

function mockAnthropicResponse(messageIndex: number): Response {
  return new Response(
    JSON.stringify({
      id: `msg_${messageIndex}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-test',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: 'text', text: 'ok' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

/**
 * Install the SDK constructor stub, the `globalThis.fetch` interceptor and
 * the console captures. Call from `beforeEach`; pair with
 * `vi.restoreAllMocks()` in `afterEach`.
 */
export function setupAnthropicFetchCapture(): AnthropicCapture {
  const calls: CapturedAnthropicCall[] = [];
  const logs: LogRecord[] = [];
  const warnLogs: LogRecord[] = [];

  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);

  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes(ANTHROPIC_HOST)) return realFetch(input, init);
    const rawBody = await readMockRequestBody(input, init);
    const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    calls.push({ system: renderSystem(parsed.system), body: parsed });
    return mockAnthropicResponse(calls.length);
  });

  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(parseLogLine(args[0]));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnLogs.push(parseLogLine(args[0]));
  });

  return { calls, logs, warnLogs };
}

/** POST `/chat/final` on the DO and return the raw response. */
export async function postChatFinal(stub: DurableObjectStub, body: ChatRequest): Promise<Response> {
  return stub.fetch('http://fake-host/chat/final', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** POST `/chat/final`, assert 200, and return the parsed completing response. */
export async function postChatFinalJson(
  stub: DurableObjectStub,
  body: ChatRequest
): Promise<ChatResponse & { message_id: string }> {
  const response = await postChatFinal(stub, body);
  expect(response.status).toBe(200);
  return (await response.json()) as ChatResponse & { message_id: string };
}

/** GET `/preferences` and return the persisted `response_language`. */
export async function getPreferredLanguage(stub: DurableObjectStub): Promise<string> {
  const response = await stub.fetch('http://fake-host/preferences');
  expect(response.status).toBe(200);
  const data = (await response.json()) as { response_language: string };
  return data.response_language;
}

/** PUT `/preferences` with a new `response_language`. */
export async function putPreferredLanguage(stub: DurableObjectStub, code: string): Promise<void> {
  const response = await stub.fetch('http://fake-host/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_language: code }),
  });
  expect(response.status).toBe(200);
}
