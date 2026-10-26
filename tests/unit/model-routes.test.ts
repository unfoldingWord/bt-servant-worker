/**
 * Model route chain (#403).
 *
 * The chain is the ordered list of (provider, model) pairs a turn may be served
 * by: Anthropic primary, an alternate Claude model on Anthropic, the same Claude
 * model via OpenRouter, and a non-Claude model via OpenRouter. Each tier is
 * enabled purely by configuration; an unconfigured tier is OMITTED (and logged),
 * never silently pointed at a default that cannot work.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildRouteChain,
  ANTHROPIC_MESSAGES_URL,
  OPENROUTER_MESSAGES_URL,
  DEFAULT_MODEL,
} from '../../src/services/claude/routes.js';
import type { RequestLogger } from '../../src/utils/logger.js';

type RouteEnv = Parameters<typeof buildRouteChain>[0];

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

function env(overrides: Partial<RouteEnv> = {}): RouteEnv {
  return { ENVIRONMENT: 'staging', ANTHROPIC_API_KEY: 'sk-ant-test', ...overrides } as RouteEnv;
}

function eventsOf(fn: unknown): Array<[string, Record<string, unknown>]> {
  return (fn as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => [c[0] as string, c[1] as Record<string, unknown>] as [string, Record<string, unknown>]
  );
}

describe('buildRouteChain — which tiers exist', () => {
  it('with only an Anthropic key yields primary + anthropic-alt and omits both OpenRouter tiers', () => {
    const logger = createMockLogger();
    const chain = buildRouteChain(env(), logger);

    expect(chain.routes.map((r) => r.id)).toEqual(['primary', 'anthropic-alt']);
    expect(chain.routes[0]).toMatchObject({
      provider: 'anthropic',
      url: ANTHROPIC_MESSAGES_URL,
      model: DEFAULT_MODEL,
    });
    expect(chain.routes[1]).toMatchObject({
      provider: 'anthropic',
      url: ANTHROPIC_MESSAGES_URL,
      model: 'claude-opus-4-6',
    });

    const omitted = eventsOf(logger.log).filter(([e]) => e === 'model_route_omitted');
    expect(omitted.map(([, d]) => d.route)).toEqual(['openrouter-claude', 'openrouter-alt']);
    expect(omitted.every(([, d]) => d.reason === 'OPENROUTER_API_KEY unset')).toBe(true);
  });

  it('CLAUDE_MODEL overrides the primary model only', () => {
    const chain = buildRouteChain(env({ CLAUDE_MODEL: 'claude-sonnet-5-5' }), createMockLogger());
    expect(chain.routes[0]!.model).toBe('claude-sonnet-5-5');
    expect(chain.routes[1]!.model).toBe('claude-opus-4-6');
  });

  it('FALLBACK_CLAUDE_MODEL="" disables the anthropic-alt tier explicitly', () => {
    const logger = createMockLogger();
    const chain = buildRouteChain(env({ FALLBACK_CLAUDE_MODEL: '' }), logger);

    expect(chain.routes.map((r) => r.id)).toEqual(['primary']);
    const omitted = eventsOf(logger.log).filter(([e]) => e === 'model_route_omitted');
    expect(omitted[0]![1]).toMatchObject({ route: 'anthropic-alt', reason: 'disabled by config' });
  });
});

describe('buildRouteChain — OpenRouter tiers', () => {
  it('an OpenRouter key enables openrouter-claude with the default Claude slug; alt still needs a model', () => {
    const logger = createMockLogger();
    const chain = buildRouteChain(env({ OPENROUTER_API_KEY: 'sk-or-test' }), logger);

    expect(chain.routes.map((r) => r.id)).toEqual([
      'primary',
      'anthropic-alt',
      'openrouter-claude',
    ]);
    expect(chain.routes[2]).toMatchObject({
      provider: 'openrouter',
      url: OPENROUTER_MESSAGES_URL,
      model: 'anthropic/claude-sonnet-4.6',
    });
    const omitted = eventsOf(logger.log).filter(([e]) => e === 'model_route_omitted');
    expect(omitted).toEqual([
      ['model_route_omitted', { route: 'openrouter-alt', reason: 'OPENROUTER_ALT_MODEL unset' }],
    ]);
  });

  it('all four tiers when fully configured, with attempts and cache flags per provider', () => {
    const chain = buildRouteChain(
      env({ OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_ALT_MODEL: 'openai/gpt-5.4' }),
      createMockLogger()
    );

    expect(chain.routes.map((r) => r.id)).toEqual([
      'primary',
      'anthropic-alt',
      'openrouter-claude',
      'openrouter-alt',
    ]);
    expect(chain.routes[3]!.model).toBe('openai/gpt-5.4');
    expect(chain.routes.map((r) => r.outageAttempts)).toEqual([2, 1, 1, 1]);
    expect(chain.routes.map((r) => r.topLevelCacheControl)).toEqual([true, true, false, false]);
  });
});

describe('buildRouteChain — headers carry the right credential per provider', () => {
  it('Anthropic routes send x-api-key; OpenRouter routes send a Bearer token; both pin anthropic-version', () => {
    const chain = buildRouteChain(
      env({ OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_ALT_MODEL: 'openai/gpt-5.4' }),
      createMockLogger()
    );
    const [primary, , orClaude] = chain.routes;

    expect(primary!.headers()).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
    expect(orClaude!.headers()).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-or-test',
      'anthropic-version': '2023-06-01',
    });
  });
});

describe('buildRouteChain — FALLBACK_FORCE_ROUTE (staging-only outage drill)', () => {
  it('names the forced route outside production and logs it', () => {
    const logger = createMockLogger();
    const chain = buildRouteChain(env({ FALLBACK_FORCE_ROUTE: 'anthropic-alt' }), logger);

    expect(chain.forcedRoute).toBe('anthropic-alt');
    expect(eventsOf(logger.warn).map(([e]) => e)).toContain('model_route_forced');
  });

  it('is refused in production with a warning', () => {
    const logger = createMockLogger();
    const chain = buildRouteChain(
      env({ ENVIRONMENT: 'production', FALLBACK_FORCE_ROUTE: 'anthropic-alt' }),
      logger
    );

    expect(chain.forcedRoute).toBeUndefined();
    const warned = eventsOf(logger.warn).find(([e]) => e === 'model_route_force_refused');
    expect(warned![1]).toMatchObject({ route: 'anthropic-alt', reason: 'production' });
  });

  it('is refused when it names a route that is not in the chain', () => {
    const logger = createMockLogger();
    const chain = buildRouteChain(env({ FALLBACK_FORCE_ROUTE: 'openrouter-alt' }), logger);

    expect(chain.forcedRoute).toBeUndefined();
    const warned = eventsOf(logger.warn).find(([e]) => e === 'model_route_force_refused');
    expect(warned![1]).toMatchObject({ route: 'openrouter-alt', reason: 'route not configured' });
  });
});
