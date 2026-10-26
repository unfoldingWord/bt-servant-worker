/**
 * Model route chain (#403): the ordered list of (provider, model) pairs that may
 * serve a turn when the one before it is down.
 *
 * Why a chain and not Anthropic's own `fallbacks` parameter: that feature fires
 * only on safety-classifier refusals. A 529, a 5xx, or a dead connection is
 * returned to the caller as-is, which is exactly the case this module exists
 * for. The two OpenRouter tiers use OpenRouter's Anthropic-compatible Messages
 * endpoint, so every route speaks the same request and SSE shape; only the
 * URL, the credential header and the model string differ.
 *
 * Tiers, cheapest first:
 *   1. `primary`           — Anthropic, `CLAUDE_MODEL`.
 *   2. `anthropic-alt`     — Anthropic, another Claude model. Covers the common
 *                            model-specific "elevated errors" incident.
 *   3. `openrouter-claude` — the same Claude model through OpenRouter, which
 *                            fails over between Anthropic/Bedrock/Vertex itself.
 *                            Covers an api.anthropic.com-wide outage.
 *   4. `openrouter-alt`    — a non-Claude model through OpenRouter. Last resort.
 *
 * A tier whose configuration is missing is omitted and logged, never pointed at
 * a default that cannot work.
 */

import type { Env } from '../../config/types.js';
import type { RequestLogger } from '../../utils/logger.js';

/** Default Claude model — can be overridden via CLAUDE_MODEL env var. */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Tier-2 default. Same API generation as the primary (no always-on thinking, no
 * forced-tool-choice rejection), so the request body needs no per-model
 * tailoring. Costs more per token, but only ever runs during an incident.
 */
export const DEFAULT_FALLBACK_CLAUDE_MODEL = 'claude-opus-4-6';

/** Tier-3 default: the primary model's OpenRouter slug. */
export const DEFAULT_OPENROUTER_CLAUDE_MODEL = 'anthropic/claude-sonnet-4.6';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const OPENROUTER_MESSAGES_URL = 'https://openrouter.ai/api/v1/messages';

/** Anthropic API version header value — sent to OpenRouter too, it honours it. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

export type RouteId = 'primary' | 'anthropic-alt' | 'openrouter-claude' | 'openrouter-alt';
export type RouteProvider = 'anthropic' | 'openrouter';

/** Every route id, in chain order. */
export const ROUTE_ORDER: readonly RouteId[] = [
  'primary',
  'anthropic-alt',
  'openrouter-claude',
  'openrouter-alt',
];

export interface ModelRoute {
  id: RouteId;
  provider: RouteProvider;
  url: string;
  model: string;
  /**
   * Request headers including the credential. A function, not a field, so a
   * route object can be logged whole without leaking the key.
   */
  headers(): Record<string, string>;
  /**
   * Whether the body may carry the top-level (automatic) `cache_control`.
   * OpenRouter honours per-block breakpoints for every provider but only
   * guarantees the top-level form when it routes to Anthropic directly, which
   * is precisely the provider that is down when this tier runs.
   */
  topLevelCacheControl: boolean;
  /**
   * Attempts an outage-class failure gets on this route before the chain moves
   * on. The primary earns a second try (a single dropped connection during an
   * Anthropic deploy should not flip a turn to another model); fallbacks get one.
   */
  outageAttempts: number;
}

export interface RouteChain {
  routes: ModelRoute[];
  /**
   * Staging-only outage drill (`FALLBACK_FORCE_ROUTE`): every route BEFORE this
   * one reports a synthetic outage without a network call, so a tier can be
   * exercised end to end with real traffic. Refused in production.
   */
  forcedRoute: RouteId | undefined;
}

export type RouteEnv = Pick<
  Env,
  | 'ENVIRONMENT'
  | 'ANTHROPIC_API_KEY'
  | 'CLAUDE_MODEL'
  | 'FALLBACK_CLAUDE_MODEL'
  | 'OPENROUTER_API_KEY'
  | 'OPENROUTER_CLAUDE_MODEL'
  | 'OPENROUTER_ALT_MODEL'
  | 'FALLBACK_FORCE_ROUTE'
>;

function anthropicRoute(id: RouteId, model: string, apiKey: string, attempts: number): ModelRoute {
  return {
    id,
    provider: 'anthropic',
    url: ANTHROPIC_MESSAGES_URL,
    model,
    headers: () => ({
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    }),
    topLevelCacheControl: true,
    outageAttempts: attempts,
  };
}

function openrouterRoute(id: RouteId, model: string, apiKey: string): ModelRoute {
  return {
    id,
    provider: 'openrouter',
    url: OPENROUTER_MESSAGES_URL,
    model,
    headers: () => ({
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': ANTHROPIC_API_VERSION,
    }),
    topLevelCacheControl: false,
    outageAttempts: 1,
  };
}

/** A route, or the reason it is not configured. */
type RouteOrOmission = { route: ModelRoute } | { omitted: RouteId; reason: string };

function resolveTiers(env: RouteEnv): RouteOrOmission[] {
  const altModel = env.FALLBACK_CLAUDE_MODEL ?? DEFAULT_FALLBACK_CLAUDE_MODEL;
  const orKey = env.OPENROUTER_API_KEY;
  const orAltModel = env.OPENROUTER_ALT_MODEL;
  return [
    {
      route: anthropicRoute('primary', env.CLAUDE_MODEL ?? DEFAULT_MODEL, env.ANTHROPIC_API_KEY, 2),
    },
    altModel
      ? { route: anthropicRoute('anthropic-alt', altModel, env.ANTHROPIC_API_KEY, 1) }
      : { omitted: 'anthropic-alt', reason: 'disabled by config' },
    orKey
      ? {
          route: openrouterRoute(
            'openrouter-claude',
            env.OPENROUTER_CLAUDE_MODEL ?? DEFAULT_OPENROUTER_CLAUDE_MODEL,
            orKey
          ),
        }
      : { omitted: 'openrouter-claude', reason: 'OPENROUTER_API_KEY unset' },
    !orKey
      ? { omitted: 'openrouter-alt', reason: 'OPENROUTER_API_KEY unset' }
      : orAltModel
        ? { route: openrouterRoute('openrouter-alt', orAltModel, orKey) }
        : { omitted: 'openrouter-alt', reason: 'OPENROUTER_ALT_MODEL unset' },
  ];
}

function resolveForcedRoute(
  env: RouteEnv,
  routes: ModelRoute[],
  logger: RequestLogger
): RouteId | undefined {
  const wanted = env.FALLBACK_FORCE_ROUTE;
  if (!wanted) return undefined;
  if (env.ENVIRONMENT === 'production') {
    logger.warn('model_route_force_refused', { route: wanted, reason: 'production' });
    return undefined;
  }
  const match = routes.find((r) => r.id === wanted);
  if (!match) {
    logger.warn('model_route_force_refused', { route: wanted, reason: 'route not configured' });
    return undefined;
  }
  logger.warn('model_route_forced', { route: match.id, model: match.model });
  return match.id;
}

/**
 * Build the chain for one request from the environment. Cheap and pure apart
 * from logging, so it runs per request rather than per isolate and reflects a
 * var change on the next turn.
 */
export function buildRouteChain(env: RouteEnv, logger: RequestLogger): RouteChain {
  const routes: ModelRoute[] = [];
  for (const tier of resolveTiers(env)) {
    if ('route' in tier) {
      routes.push(tier.route);
    } else {
      logger.log('model_route_omitted', { route: tier.omitted, reason: tier.reason });
    }
  }
  return { routes, forcedRoute: resolveForcedRoute(env, routes, logger) };
}
