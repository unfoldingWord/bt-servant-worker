/**
 * Per-route transport (#403): the request body and the HTTP call are shaped by
 * the route that serves them, not by a hard-coded Anthropic endpoint.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildMessageBody, postToRoute } from '../../src/services/claude/orchestrator.js';
import { buildRouteChain } from '../../src/services/claude/routes.js';
import type { RequestLogger } from '../../src/utils/logger.js';

type BodyCtx = Parameters<typeof buildMessageBody>[0];

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

function chain() {
  return buildRouteChain(
    {
      ENVIRONMENT: 'staging',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_ALT_MODEL: 'openai/gpt-5.4',
    },
    createMockLogger()
  ).routes;
}

function bodyCtx(): BodyCtx {
  return {
    maxTokens: 1234,
    systemStable: 'STABLE',
    systemVolatile: '\n\nVOLATILE',
    tools: [],
    messages: [{ role: 'user', content: 'hi' }],
  } as unknown as BodyCtx;
}

afterEach(() => vi.restoreAllMocks());

describe('buildMessageBody — shaped by the route', () => {
  it('an Anthropic route carries the route model and the top-level rolling breakpoint', () => {
    const [primary] = chain();
    const body = JSON.parse(buildMessageBody(bodyCtx(), primary!, false)) as Record<
      string,
      unknown
    >;

    expect(body.model).toBe(primary!.model);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(1234);
  });

  it('an OpenRouter route drops the top-level breakpoint but keeps the per-block one', () => {
    const routes = chain();
    const orAlt = routes[3]!;
    const body = JSON.parse(buildMessageBody(bodyCtx(), orAlt, true)) as {
      model: string;
      cache_control?: unknown;
      stream: boolean;
      system: Array<{ cache_control?: unknown }>;
    };

    expect(body.model).toBe('openai/gpt-5.4');
    expect('cache_control' in body).toBe(false);
    expect(body.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.stream).toBe(true);
  });
});

describe('postToRoute — URL and credential come from the route', () => {
  it('posts to the route URL with the route headers and the given body', async () => {
    const routes = chain();
    const orClaude = routes[2]!;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    await postToRoute(orClaude, '{"x":1}', new AbortController().signal);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/messages');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toEqual(orClaude.headers());
    expect((init as RequestInit).body).toBe('{"x":1}');
  });
});
