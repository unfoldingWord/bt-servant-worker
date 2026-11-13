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
import { ClaudeAPIError, UpstreamSpendLimitError } from '../../src/utils/errors.js';
import {
  createMemoryRouteHealthStore,
  type RouteHealthStore,
} from '../../src/services/claude/route-health.js';
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

describe('route chain — shared breaker', () => {
  async function runWithStore(env: Env, sink: LoggedEvent[], routeHealth: RouteHealthStore) {
    return orchestrate('hello', {
      env,
      catalog: { tools: [], serverMap: new Map() } as ToolCatalog,
      history: [],
      preferences: { response_language: 'en', first_interaction: false },
      logger: createMockLogger(sink),
      retryClock: INSTANT_CLOCK,
      routeHealth,
    });
  }

  it('a route the breaker reports open is skipped without a network call', async () => {
    const sink: LoggedEvent[] = [];
    const store = createMemoryRouteHealthStore();
    await store.open({ id: 'primary', model: 'claude-sonnet-4-6' } as never, {
      outage: 'http_5xx',
      status: 529,
      attempts: 2,
    });
    const calls = scriptFetch((c) => json(message('skipped primary', c.model)));

    const result = await runWithStore(fullEnv(), sink, store);

    expect(result.responses).toEqual(['skipped primary']);
    expect(calls.map((c) => c.model)).toEqual(['claude-opus-4-6']);
    const skipped = eventsNamed(sink, 'route_breaker_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.data).toMatchObject({ route: 'primary' });
  });

  it('an outage opens the breaker for that route; a forced skip does not', async () => {
    const sink: LoggedEvent[] = [];
    const store = createMemoryRouteHealthStore();
    scriptFetch((c) =>
      c.model === 'claude-sonnet-4-6' ? status(503) : json(message('ok', c.model))
    );

    await runWithStore(fullEnv(), sink, store);
    expect([...(await store.readOpen(['primary', 'anthropic-alt']))]).toEqual(['primary']);

    const drillStore = createMemoryRouteHealthStore();
    await runWithStore(fullEnv({ FALLBACK_FORCE_ROUTE: 'anthropic-alt' }), [], drillStore);
    expect((await drillStore.readOpen(['primary', 'anthropic-alt'])).size).toBe(0);
  });
});

describe('route chain — breaker cannot cause a total outage', () => {
  async function runWithStore(env: Env, sink: LoggedEvent[], routeHealth: RouteHealthStore) {
    return orchestrate('hello', {
      env,
      catalog: { tools: [], serverMap: new Map() } as ToolCatalog,
      history: [],
      preferences: { response_language: 'en', first_interaction: false },
      logger: createMockLogger(sink),
      retryClock: INSTANT_CLOCK,
      routeHealth,
    });
  }

  it('when every route is open they are all tried anyway, in order', async () => {
    const sink: LoggedEvent[] = [];
    const store = createMemoryRouteHealthStore();
    for (const id of ['primary', 'anthropic-alt', 'openrouter-claude', 'openrouter-alt']) {
      await store.open({ id, model: 'm' } as never, {
        outage: 'http_5xx',
        status: 503,
        attempts: 1,
      });
    }
    const calls = scriptFetch((c) => json(message('all open', c.model)));

    const result = await runWithStore(fullEnv(), sink, store);

    expect(result.responses).toEqual(['all open']);
    expect(calls.map((c) => c.model)).toEqual(['claude-sonnet-4-6']);
    expect(eventsNamed(sink, 'route_breaker_skipped')).toHaveLength(0);
  });
});

describe('route chain — served model telemetry', () => {
  const toolCall = {
    type: 'tool_use',
    id: 'tool_1',
    name: 'execute_code',
    input: { code: '__result__ = "x"' },
  } as unknown as Anthropic.ContentBlock;

  it('reports the model and route that answered, and usage split per served model', async () => {
    const sink: LoggedEvent[] = [];
    // Iteration 1 is served by the primary; it then goes down and the alt finishes the turn.
    let primaryCalls = 0;
    scriptFetch((c) => {
      if (c.model === 'claude-sonnet-4-6') {
        primaryCalls += 1;
        return primaryCalls === 1
          ? json(message('step one', 'claude-sonnet-4-6', 'tool_use', [toolCall]))
          : status(529);
      }
      return json(message('step two', 'claude-opus-4-6'));
    });

    const result = await run(fullEnv(), sink);

    expect(result.telemetry.model).toBe('claude-sonnet-4-6');
    expect(result.telemetry.servedModel).toBe('claude-opus-4-6');
    expect(result.telemetry.route).toBe('anthropic-alt');
    expect(Object.keys(result.telemetry.usageByModel).sort()).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]);
    expect(result.telemetry.usageByModel['claude-sonnet-4-6']!.input_tokens).toBe(10);
    expect(result.telemetry.usageByModel['claude-opus-4-6']!.input_tokens).toBe(10);
    expect(result.telemetry.usage.input_tokens).toBe(20);
  });

  it('labels the token counters with the SERVED model and route', async () => {
    const sink: LoggedEvent[] = [];
    scriptFetch((c) =>
      c.model === 'claude-sonnet-4-6' ? status(529) : json(message('ok', 'claude-opus-4-6'))
    );

    await run(fullEnv(), sink);

    const inputCall = countMetricSpy.mock.calls.find((c) => c[0] === 'claude_input_tokens_total');
    expect(inputCall![1]).toMatchObject({ model: 'claude-opus-4-6', route: 'anthropic-alt' });
  });

  it('on the happy path the served model is whatever the primary reported and the route is primary', async () => {
    const sink: LoggedEvent[] = [];
    scriptFetch((c) => json(message('ok', c.model)));

    const result = await run(fullEnv(), sink);

    expect(result.telemetry.servedModel).toBe('claude-sonnet-4-6');
    expect(result.telemetry.route).toBe('primary');
    expect(Object.keys(result.telemetry.usageByModel)).toEqual(['claude-sonnet-4-6']);
  });
});

// #468 fixtures: the documented spend-stop bodies.
const SPEND_400 = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
  },
});
const SPEND_CAP_429 = JSON.stringify({
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message: 'You have reached your API usage limits.',
    details: { error_code: 'enforced_spend_limit_reached' },
  },
});
const raw = (code: number, text: string): Response => new Response(text, { status: code });

async function runCaught(env: Env, sink: LoggedEvent[]): Promise<unknown> {
  try {
    await run(env, sink);
  } catch (error) {
    return error;
  }
  throw new Error('expected the turn to fail');
}

describe('route chain — spend and billing stops never fall over (#468)', () => {
  it('a self-set spend-limit 400 on the primary stops at once: one call, no hop, typed error, alert event', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch(() => raw(400, SPEND_400));

    const caught = await runCaught(fullEnv(), sink);

    expect(caught).toBeInstanceOf(UpstreamSpendLimitError);
    expect(caught).toMatchObject({ code: 'UPSTREAM_SPEND_LIMIT', statusCode: 503 });
    expect((caught as Error).message).not.toMatch(/usage limits|regain/i);
    expect(calls).toHaveLength(1);
    expect(eventsNamed(sink, 'model_route_fallback')).toHaveLength(0);
    const alert = eventsNamed(sink, 'anthropic_spend_limit_reached');
    expect(alert).toHaveLength(1);
    expect(alert[0]!.level).toBe('error');
    expect(alert[0]!.data).toMatchObject({
      kind: 'spend_limit',
      route: 'primary',
      status: 400,
      error_type: 'invalid_request_error',
    });
    expect(alert[0]!.data.upstream_message).toMatch(/regain access on 2026-11-01/);
    expect(countMetricSpy).toHaveBeenCalledWith('upstream_quota_total', {
      reason: 'spend_limit',
      route: 'primary',
    });
  });

  it('the tier spend-cap 429 is not retried and does not hop', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch(() => raw(429, SPEND_CAP_429));

    const caught = await runCaught(fullEnv(), sink);

    expect(caught).toMatchObject({ kind: 'spend_cap', code: 'UPSTREAM_SPEND_LIMIT' });
    expect(calls).toHaveLength(1);
    expect(eventsNamed(sink, 'claude_api_retry')).toHaveLength(0);
  });

  it('a 402 is a billing stop with its own code', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch(() =>
      raw(402, '{"type":"error","error":{"type":"billing_error","message":"declined"}}')
    );

    const caught = await runCaught(fullEnv(), sink);

    expect(caught).toMatchObject({ kind: 'billing', code: 'UPSTREAM_BILLING', statusCode: 503 });
    expect(calls).toHaveLength(1);
  });
});

describe('route chain — spend stops stop the chain (#468)', () => {
  it('primary down, then a spend stop on anthropic-alt: the chain stops there and never reaches OpenRouter', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch((c) =>
      c.model === 'claude-sonnet-4-6' ? status(529) : raw(400, SPEND_400)
    );

    const caught = await runCaught(fullEnv(), sink);

    expect(caught).toBeInstanceOf(UpstreamSpendLimitError);
    expect(calls.some((c) => c.url === OPENROUTER)).toBe(false);
    expect(eventsNamed(sink, 'anthropic_spend_limit_reached')[0]!.data).toMatchObject({
      route: 'anthropic-alt',
    });
  });
});

describe('route chain — non-spend errors keep their handling (#468)', () => {
  it('an ordinary validation 400 keeps its old handling (HTTP error path, no alert)', async () => {
    const sink: LoggedEvent[] = [];
    scriptFetch(() =>
      raw(
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}'
      )
    );

    const caught = await runCaught(fullEnv(), sink);

    // The SDK is mocked in this file, so the APIError wrapping is not asserted
    // here; the terminal HTTP error log proves the old path ran.
    expect(caught).not.toBeInstanceOf(UpstreamSpendLimitError);
    expect(eventsNamed(sink, 'anthropic_spend_limit_reached')).toHaveLength(0);
    // The body was read for classification, then handed on intact.
    expect(eventsNamed(sink, 'claude_fetch_http_error')[0]!.data.body_preview).toMatch(
      /prompt is too long/
    );
  });

  it('an ordinary 429 is still retried in place, its body intact for the retry drain', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch((c, i) =>
      i === 0
        ? raw(429, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}')
        : json(message('ok', c.model))
    );

    const result = await run(fullEnv(), sink);

    expect(result.responses).toEqual(['ok']);
    expect(calls).toHaveLength(2);
    expect(eventsNamed(sink, 'anthropic_spend_limit_reached')).toHaveLength(0);
  });

  it('an OpenRouter 402 is not classified as an Anthropic spend stop', async () => {
    const sink: LoggedEvent[] = [];
    scriptFetch((c) => (c.url === ANTHROPIC ? status(503) : raw(402, '{"error":"no credits"}')));

    const caught = await runCaught(fullEnv(), sink);

    expect(caught).not.toBeInstanceOf(UpstreamSpendLimitError);
    expect(eventsNamed(sink, 'anthropic_spend_limit_reached')).toHaveLength(0);
  });
});

describe('route chain — unreadable error bodies (#468)', () => {
  /** A response whose body stream errors on read. */
  const unreadable = (code: number): Response =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('socket reset'));
        },
      }),
      { status: code }
    );

  it('an unreadable 402 is still a billing stop (status alone), logged, with no retry', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch(() => unreadable(402));

    const caught = await run(fullEnv(), sink).catch((error: unknown) => error);

    expect(caught).toMatchObject({ kind: 'billing', code: 'UPSTREAM_BILLING' });
    expect(calls).toHaveLength(1);
    expect(eventsNamed(sink, 'claude_error_body_unreadable')[0]!.data).toMatchObject({
      status: 402,
      error: 'socket reset',
    });
  });

  it('an unreadable ordinary 429 is logged and keeps its retry policy', async () => {
    const sink: LoggedEvent[] = [];
    const calls = scriptFetch((c, i) => (i === 0 ? unreadable(429) : json(message('ok', c.model))));

    const result = await run(fullEnv(), sink);

    expect(result.responses).toEqual(['ok']);
    expect(calls).toHaveLength(2);
    expect(eventsNamed(sink, 'claude_error_body_unreadable')).toHaveLength(1);
    expect(eventsNamed(sink, 'anthropic_spend_limit_reached')).toHaveLength(0);
  });
});
