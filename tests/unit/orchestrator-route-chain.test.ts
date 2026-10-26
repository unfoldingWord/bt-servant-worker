/**
 * Route chain fallback (#403): when the route serving a turn reports an outage,
 * the same call is retried on the next configured route, silently to the user.
 *
 * Driven through `orchestrate()` with `fetch` scripted per (URL, model) so the
 * assertions are about what actually went over the wire — which endpoint, which
 * credential, which model — and what the turn reported, not about internals.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate, type RetryClock } from '../../src/services/claude/orchestrator.js';
import { ClaudeAPIError } from '../../src/utils/errors.js';
import type { Env } from '../../src/config/types.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { ToolCatalog } from '../../src/services/mcp/index.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const { countMetricSpy } = vi.hoisted(() => ({ countMetricSpy: vi.fn() }));
vi.mock('../../src/services/telemetry/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/telemetry/index.js')>()),
  countMetric: countMetricSpy,
}));

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const OPENROUTER = 'https://openrouter.ai/api/v1/messages';

interface LoggedEvent {
  level: 'log' | 'warn' | 'error';
  event: string;
  data: Record<string, unknown>;
}

function createMockLogger(sink: LoggedEvent[]): RequestLogger {
  const push =
    (level: LoggedEvent['level']) =>
    (event: string, ...rest: unknown[]): void => {
      const data = (level === 'error' ? rest[1] : rest[0]) as Record<string, unknown>;
      sink.push({ level, event, data: data ?? {} });
    };
  return {
    log: vi.fn(push('log')),
    warn: vi.fn(push('warn')),
    error: vi.fn(push('error')),
  } as unknown as RequestLogger;
}

/** Backoff sleeps resolve instantly; `now` is frozen so the window never expires. */
const INSTANT_CLOCK: RetryClock = { sleep: async () => {}, now: () => 0, random: () => 0 };

function fullEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'staging',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    OPENROUTER_API_KEY: 'sk-or-test',
    OPENROUTER_ALT_MODEL: 'openai/gpt-5.4',
    ...overrides,
  } as Env;
}

interface WireCall {
  url: string;
  model: string;
  headers: Record<string, string>;
}

function message(
  text: string,
  model: string,
  stop: 'end_turn' | 'tool_use' = 'end_turn',
  extra: Anthropic.ContentBlock[] = []
): Anthropic.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content: [{ type: 'text', text } as Anthropic.ContentBlock, ...extra],
  } as Anthropic.Message;
}

type Script = (call: WireCall, index: number) => Response | Promise<Response>;

/** Script `fetch` by what is on the wire; returns the recorded calls. */
function scriptFetch(script: Script): WireCall[] {
  const calls: WireCall[] = [];
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as { model: string };
    const call = {
      url: String(url),
      model: body.model,
      headers: (init as RequestInit).headers as Record<string, string>,
    };
    calls.push(call);
    return await script(call, calls.length - 1);
  });
  return calls;
}

const json = (msg: Anthropic.Message): Response =>
  new Response(JSON.stringify(msg), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const status = (code: number): Response => new Response('{}', { status: code });

async function run(env: Env, sink: LoggedEvent[]) {
  return orchestrate('hello', {
    env,
    catalog: { tools: [], serverMap: new Map() } as ToolCatalog,
    history: [],
    preferences: { response_language: 'en', first_interaction: false },
    logger: createMockLogger(sink),
    retryClock: INSTANT_CLOCK,
  });
}

const eventsNamed = (sink: LoggedEvent[], name: string) => sink.filter((e) => e.event === name);

beforeEach(() => countMetricSpy.mockClear());
afterEach(() => vi.restoreAllMocks());

describe('route chain — hopping', () => {
  it('primary 529 twice → anthropic-alt answers; the hop is logged and metered', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch((c) =>
      c.model === 'claude-sonnet-4-6' ? status(529) : json(message('from alt', c.model))
    );

    const result = await run(fullEnv(), sink);

    expect(result.responses).toEqual(['from alt']);
    expect(calls.map((c) => c.model)).toEqual([
      'claude-sonnet-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
    ]);
    const hops = eventsNamed(sink, 'model_route_fallback');
    expect(hops).toHaveLength(1);
    expect(hops[0]!.level).toBe('warn');
    expect(hops[0]!.data).toMatchObject({
      from_route: 'primary',
      to_route: 'anthropic-alt',
      outage: 'http_5xx',
      status: 529,
      attempts: 2,
    });
    expect(countMetricSpy).toHaveBeenCalledWith('model_route_fallback_total', {
      from_route: 'primary',
      to_route: 'anthropic-alt',
      reason: 'http_5xx',
    });
  });

  it('primary and alt down → openrouter-claude answers on the OpenRouter URL with a Bearer token', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch((c) =>
      c.url === ANTHROPIC ? status(503) : json(message('from openrouter', c.model))
    );

    const result = await run(fullEnv(), sink);

    expect(result.responses).toEqual(['from openrouter']);
    const served = calls.at(-1)!;
    expect(served.url).toBe(OPENROUTER);
    expect(served.model).toBe('anthropic/claude-sonnet-4.6');
    expect(served.headers.authorization).toBe('Bearer sk-or-test');
    expect(calls.filter((c) => c.url === ANTHROPIC)).toHaveLength(3); // 2 primary + 1 alt
    expect(eventsNamed(sink, 'model_route_fallback').map((e) => e.data.to_route)).toEqual([
      'anthropic-alt',
      'openrouter-claude',
    ]);
  });
});

describe('route chain — rate limits stay put', () => {
  it('a 429 on the primary is retried in place and never hops', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch((c, i) => (i === 0 ? status(429) : json(message('ok', c.model))));

    const result = await run(fullEnv(), sink);

    expect(result.responses).toEqual(['ok']);
    expect(calls.map((c) => c.model)).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-6']);
    expect(eventsNamed(sink, 'model_route_fallback')).toHaveLength(0);
  });
});

describe('route chain — exhaustion', () => {
  it('every route down → ClaudeAPIError with a clean message, routes logged, nothing leaked', async () => {
    const sink: LoggedEvent[] = [];
    scriptFetch(async () => {
      throw new TypeError('network failure: ECONNRESET 10.0.0.1');
    });

    let caught: unknown;
    try {
      await run(fullEnv(), sink);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClaudeAPIError);
    expect((caught as Error).message).not.toContain('ECONNRESET');
    expect((caught as Error).message).toMatch(/all model routes failed/i);
    const exhausted = eventsNamed(sink, 'model_route_chain_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.level).toBe('error');
    expect(exhausted[0]!.data).toMatchObject({
      routes_attempted: ['primary', 'anthropic-alt', 'openrouter-claude', 'openrouter-alt'],
      last_outage: 'network_error',
    });
  });

  it('with only the primary configured, an outage still surfaces as ClaudeAPIError', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch(() => status(529));

    await expect(
      run(fullEnv({ FALLBACK_CLAUDE_MODEL: '', OPENROUTER_API_KEY: undefined }), sink)
    ).rejects.toBeInstanceOf(ClaudeAPIError);
    expect(calls).toHaveLength(2);
  });
});

describe('route chain — sticky within the turn', () => {
  it('after a hop, the next iteration of the same turn goes straight to the fallback', async () => {
    const sink: LoggedEvent[] = [];
    const toolCall = {
      type: 'tool_use',
      id: 'tool_1',
      name: 'execute_code',
      input: { code: '__result__ = "x"' },
    } as unknown as Anthropic.ContentBlock;
    let altCalls = 0;
    const calls = scriptFetch((c) => {
      if (c.model === 'claude-sonnet-4-6') return status(529);
      altCalls += 1;
      return altCalls === 1
        ? json(message('thinking', c.model, 'tool_use', [toolCall]))
        : json(message('final', c.model));
    });

    const result = await run(fullEnv(), sink);

    expect(result.responses).toEqual(['thinking', 'final']);
    // 2 failed primary attempts, then every call of the turn on the alt.
    expect(calls.map((c) => c.model)).toEqual([
      'claude-sonnet-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-6',
    ]);
    expect(eventsNamed(sink, 'model_route_fallback')).toHaveLength(1);
  });
});

describe('route chain — FALLBACK_FORCE_ROUTE drill', () => {
  it('skips every route before the forced one without touching the network', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch((c) => json(message('drill', c.model)));

    const result = await run(fullEnv({ FALLBACK_FORCE_ROUTE: 'openrouter-claude' }), sink);

    expect(result.responses).toEqual(['drill']);
    expect(calls.map((c) => c.url)).toEqual([OPENROUTER]);
    expect(eventsNamed(sink, 'model_route_fallback').map((e) => e.data)).toMatchObject([
      { from_route: 'primary', to_route: 'anthropic-alt', outage: 'forced' },
      { from_route: 'anthropic-alt', to_route: 'openrouter-claude', outage: 'forced' },
    ]);
  });

  it('is ignored in production: the primary serves as usual', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch((c) => json(message('prod', c.model)));

    await run(
      fullEnv({ ENVIRONMENT: 'production', FALLBACK_FORCE_ROUTE: 'openrouter-claude' }),
      sink
    );

    expect(calls.map((c) => c.model)).toEqual(['claude-sonnet-4-6']);
  });
});
