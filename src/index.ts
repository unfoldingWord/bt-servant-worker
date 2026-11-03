/**
 * bt-servant-worker entry point
 *
 * Routes requests to Durable Objects for per-user serialization.
 * MCP server config is stored in KV and passed to DOs via request body.
 */

import { Hono, type Context } from 'hono';
import { Env } from './config/types.js';
import { APP_VERSION } from './generated/version.js';
import { UserDO as UserDOClass } from './durable-objects/index.js';
import { discoverAllTools, listOrgResources } from './services/mcp/index.js';
import { readDoSnapshot } from './services/admin/do-snapshot.js';
import { MCPServerWrite } from './types/mcp.js';
import { ChatCaller, ChatRequest, ChatTransport, ChatType } from './types/engine.js';
import { DEFAULT_ORG_CONFIG, OrgConfig, validateOrgConfig } from './types/org-config.js';
import {
  checkModeSlugUniqueness,
  DEFAULT_PROMPT_VALUES,
  findModeBySlug,
  MAX_MODES_PER_ORG,
  mergePromptOverrides,
  OrgModes,
  PromptMode,
  PromptOverrides,
  resolvePromptOverrides,
  validateModeAliases,
  validateModeName,
  validatePromptMode,
  validatePromptOverrides,
} from './types/prompt-overrides.js';
import {
  Language,
  MAX_LANGUAGES_PER_ORG,
  OrgLanguages,
  sanitizeLanguageDocument,
  validateDefaultLanguageUpdate,
  validateLanguage,
  validateLanguageName,
} from './types/languages.js';
import {
  DEFAULT_LANGUAGE_SCAFFOLD,
  LanguageScaffold,
  sanitizeScaffoldDocument,
  validateLanguageScaffold,
} from './types/language-scaffold.js';
import { validateResourceLanguage } from './types/resources.js';
import { synthesizeModeDocument } from './types/mode-markdown.js';
import { readAllPublishedModes } from './utils/cross-org-modes.js';
import { stripControlChars } from './types/prompt-overrides.js';
import { constantTimeCompare } from './utils/crypto.js';
import { ValidationError } from './utils/errors.js';
import { getAudio, VOICE_SUBMISSION_PREFIX } from './services/audio/index.js';
import { createRequestLogger, type RequestLogger } from './utils/logger.js';
import { createTimingContext, timePhase, type TimingContext } from './utils/timing.js';
import {
  MAX_SERVERS,
  MCP_GLOBAL_KEY,
  findDuplicateServerIds,
  validateOrgNotReserved,
  validateServerConfig,
  validateServerId,
} from './utils/mcp-validation.js';
import {
  describeLeftoverLegacyKeys,
  describeMigrationHint,
  type McpServerPool,
  mergeServerPool,
  poolWriteAuthError,
  readMcpServerPool,
  readMcpServerPoolOrEmpty,
  toPublicServerConfig,
  toPublicServerConfigs,
  upsertServer,
} from './utils/mcp-servers.js';
import { resolveOrgFromBody } from './utils/org.js';
import { validateChatBody } from './utils/chat-validation.js';
import {
  applyPartnerChatPolicy,
  isPartnerRouteAllowed,
  principalKeyId,
  type Principal,
} from './services/partner-keys/policy.js';
import { lookupPartnerKeyByToken, partnerKeyStore } from './services/partner-keys/store.js';
import {
  hasValidPartnerKeyTag,
  looksLikePartnerKey,
  partnerKeyPrefix,
} from './services/partner-keys/key-material.js';
import type { RotateOutcome } from './services/partner-keys/ledger.js';
import { orgHasConfig } from './services/partner-keys/org-exists.js';
import {
  type PartnerKeyRecord,
  partnerKeyStatus,
  readRevokeBody,
  readRotateBody,
  toPublicPartnerKey,
  validatePartnerKeyCreate,
  validatePartnerKeyOrg,
} from './types/partner-keys.js';
import { instrument, instrumentDO } from '@microlabs/otel-cf-workers';
import {
  resolveTelemetryConfig,
  initLogTelemetry,
  flushLogTelemetry,
  initMetricTelemetry,
  flushMetricTelemetry,
  countMetric,
  withUserPseudonym,
} from './services/telemetry/index.js';

// Re-export so tests and consumers can import from './src/index.js'
export { validateChatBody };

// Instrument the Durable Object: each fetch()/alarm() invocation gets its own
// trace context, flushed from the DO fetch context where raw global fetch works.
// No-op export until telemetry is configured (0% head sampler when unset).
export const UserDO = instrumentDO(UserDOClass, resolveTelemetryConfig);
// Single writer for partner API key administration (admin-portal#354).
export { PartnerKeyStoreDO } from './durable-objects/index.js';

/**
 * Hono env: bindings plus what the `/api/*` auth middleware sets per request:
 * the principal, and a request id + logger. Today only the auth path, the
 * `/api/v1/admin/api-keys` routes and the chat handler use that logger; the
 * other admin handlers still mint their own (to be converted, see PR #475).
 */
type AppEnv = {
  Bindings: Env;
  Variables: { principal: Principal; requestId: string; logger: RequestLogger };
};

const app = new Hono<AppEnv>();

// Telemetry (M2): tee structured logs to OTLP and flush this isolate's buffered
// records at the request boundary. Registered first so its `finally` wraps every
// route AND the auth middleware below — a 401/403 rejection still flushes its log.
// A genuine no-op until telemetry secrets are set (initLogTelemetry bails, no sink
// is registered). `executionCtx` is absent in some test harnesses, so guard it.
app.use('*', async (c, next) => {
  initLogTelemetry(c.env);
  initMetricTelemetry(c.env);
  try {
    await next();
  } finally {
    try {
      // The callbacks are only invoked when telemetry is enabled AND has buffered
      // data; in that state (deployed envs) `executionCtx` is always present.
      flushLogTelemetry((promise) => c.executionCtx.waitUntil(promise));
      flushMetricTelemetry((promise) => c.executionCtx.waitUntil(promise));
    } catch (err) {
      // Telemetry is best-effort and must NEVER alter the response, so we contain
      // any flush-time failure here. We cannot route it through the logger facade
      // (that would re-enter this same OTLP path); console.warn is the safety net.

      console.warn(`otlp_flush_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
});

// Health check - no auth required
app.get('/health', (c) => c.json({ status: 'healthy', version: APP_VERSION }));

// Public ptxprint artifact serving — no auth required.
//
// Why public: ptxprint-mcp's container at klappy.workers.dev fetches our USFM
// source URLs during typesetting. It cannot satisfy our /api/* ENGINE_API_KEY
// auth, so a public endpoint is required. PDFs are also served here so that
// downstream consumers (Meta WhatsApp document fetcher, web client iframe)
// can load them without auth.
//
// Privacy: keys are content-addressed (sha256-based) for USFM and job-id-based
// (sha256 of canonicalized payload) for PDFs. Path is unguessable; the lack
// of auth is comparable to a private signed URL.
//
// Bucket: PTXPRINT_BUCKET (defined in wrangler.toml).
app.get('/public/ptxprint/*', async (c) => servePublicPtxprintObject(c.req.path, c.env));

/**
 * Rejections of a VALID partner key that is used outside its scope: the key
 * is real, so "Invalid API key" would be misleading.
 */
const NOT_PERMITTED_REASONS: ReadonlySet<string> = new Set([
  'partner_route_forbidden',
  'partner_admin_forbidden',
]);

/** Observable auth rejection: one log line + one counter, never the token value. */
function rejectAuth(
  c: Context<AppEnv>,
  status: 401 | 403,
  reason: string,
  extra: Record<string, unknown> = {}
) {
  c.get('logger').warn('auth_rejected', {
    reason,
    status,
    path: c.req.path,
    method: c.req.method,
    ...extra,
  });
  countMetric('auth_rejections_total', { reason, status_code: status });
  const error =
    status === 401
      ? 'Authorization header with Bearer token required'
      : NOT_PERMITTED_REASONS.has(reason)
        ? 'This API key is not permitted to call this endpoint'
        : 'Invalid API key';
  return c.json({ error }, status);
}

/**
 * Resolve a partner-shaped bearer token to an active partner key, or an auth
 * rejection. Unknown, revoked and expired keys get the SAME 403 body (a caller
 * learns nothing about which keys exist); only the log reason differs.
 */
async function authenticatePartner(
  c: Context<AppEnv>,
  token: string
): Promise<{ ok: true; key: PartnerKeyRecord } | { ok: false; response: Response }> {
  let key: PartnerKeyRecord | null;
  try {
    key = await lookupPartnerKeyByToken(c.env.API_KEYS, token);
  } catch (error) {
    c.get('logger').error('partner_key_lookup_failed', error, {
      path: c.req.path,
      method: c.req.method,
    });
    countMetric('auth_rejections_total', { reason: 'partner_lookup_error', status_code: 503 });
    return {
      ok: false,
      response: c.json({ error: 'Authentication temporarily unavailable' }, 503),
    };
  }
  if (!key) return { ok: false, response: rejectAuth(c, 403, 'unknown_partner_key') };
  const status = partnerKeyStatus(key, Date.now());
  if (status !== 'active') {
    // revoked_partner_key | expired_partner_key (past its rotation grace)
    const reason = `${status}_partner_key`;
    return { ok: false, response: rejectAuth(c, 403, reason, { key_id: key.id }) };
  }
  return { ok: true, key };
}

/**
 * Everything checked about a non-internal token BEFORE any KV read, so a junk
 * token, a guessed one, or a real one on a route partners may never call
 * costs no I/O: the shape, the route allowlist, then the keyed tag (an HMAC
 * only PARTNER_KEY_TAG_SECRET can produce; see key-material.ts). The display
 * prefix (`bts_<8 hex>`) is not secret and is logged for attribution.
 * Returns the rejection, or null to go on to the lookup.
 */
async function partnerPreflight(c: Context<AppEnv>, token: string): Promise<Response | null> {
  if (!looksLikePartnerKey(token)) return rejectAuth(c, 403, 'invalid_token');
  const keyPrefix = { key_prefix: partnerKeyPrefix(token) };
  if (!isPartnerRouteAllowed(c.req.method, c.req.path)) {
    return rejectAuth(c, 403, 'partner_route_forbidden', keyPrefix);
  }
  const secret = c.env.PARTNER_KEY_TAG_SECRET;
  if (!secret) {
    c.get('logger').error(
      'partner_key_tag_secret_missing',
      new Error('PARTNER_KEY_TAG_SECRET unset')
    );
    countMetric('auth_rejections_total', {
      reason: 'partner_tag_secret_missing',
      status_code: 503,
    });
    return c.json({ error: 'Authentication temporarily unavailable' }, 503);
  }
  if (!(await hasValidPartnerKeyTag(token, secret))) {
    return rejectAuth(c, 403, 'invalid_partner_key_tag', keyPrefix);
  }
  return null;
}

// Auth middleware for all /api routes.
//
// ENGINE_API_KEY (our own clients: web client, WhatsApp gateway, admin portal)
// behaves exactly as before and is the "internal" principal. Any other bearer
// token is looked up as a partner key (admin-portal#354); an active one becomes
// the "partner" principal and may only reach the routes in
// isPartnerRouteAllowed (the two chat endpoints). Every rejection is logged
// (auth_rejected + reason) and counted.
app.use('/api/*', async (c, next) => {
  // The request's id and logger are minted HERE, once, and shared through the
  // context with the auth path, the /api/v1/admin/api-keys routes and the chat
  // handler, so their lines for one request carry the same request_id. Other
  // admin handlers still create their own logger (pre-existing; follow-up).
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.set('logger', createRequestLogger(requestId));
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return rejectAuth(c, 401, 'missing_bearer');
  }

  const token = authHeader.slice(7);
  if (constantTimeCompare(token, c.env.ENGINE_API_KEY)) {
    c.set('principal', { kind: 'internal' });
    return next();
  }

  const refused = await partnerPreflight(c, token);
  if (refused) return refused;
  const auth = await authenticatePartner(c, token);
  if (!auth.ok) return auth.response;
  c.set('principal', { kind: 'partner', key: auth.key });
  return next();
});

// Second fence for every admin route: only the internal principal, whatever
// the allowlist above says. A partner key is already stopped there; this keeps
// the invariant next to the admin surface if that allowlist is ever widened.
app.use('/api/v1/admin/*', async (c, next) => {
  if (c.get('principal')?.kind !== 'internal') {
    return rejectAuth(c, 403, 'partner_admin_forbidden', {
      key_id: principalKeyId(c.get('principal')),
    });
  }
  return next();
});

/** The per-request values a chat handler takes from the auth middleware. */
type ChatRequestContext = AppEnv['Variables'];

// Chat endpoints — explicit transport per route.
//
// - POST /api/v1/chat           → synchronous, final-only JSON response.
//                                  Rejects progress_callback_url, progress_mode,
//                                  progress_throttle_seconds, and message_key.
//                                  Returns 429 CONCURRENT_REQUEST_REJECTED with
//                                  Retry-After when the user's DO is busy
//                                  processing another request — the final
//                                  transport cannot hold an HTTP connection
//                                  open while the queue drains.
// - POST /api/v1/chat/stream    → SSE streaming only.
// - POST /api/v1/chat/callback  → 202 + webhook delivery; requires
//                                  progress_callback_url and message_key.
app.post('/api/v1/chat', async (c) => {
  return handleChatRequest(c.req.raw, c.env, 'final', c.var);
});

app.post('/api/v1/chat/stream', async (c) => {
  return handleChatRequest(c.req.raw, c.env, 'stream', c.var);
});

app.post('/api/v1/chat/callback', async (c) => {
  return handleChatRequest(c.req.raw, c.env, 'callback', c.var);
});

// User endpoints with org scope (new paths)
app.get('/api/v1/orgs/:org/users/:userId/preferences', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/preferences');
});

app.put('/api/v1/orgs/:org/users/:userId/preferences', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/preferences');
});

app.get('/api/v1/orgs/:org/users/:userId/history', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/history');
});

// Audio serving endpoint — serves TTS audio from R2
app.get('/api/v1/audio/*', async (c) => {
  const start = Date.now();
  const audioKey = c.req.path.replace('/api/v1/audio/', '');
  if (!audioKey || !audioKey.startsWith('audio/')) {
    return c.json({ error: 'Invalid audio key' }, 400);
  }

  const logger = createRequestLogger(crypto.randomUUID());
  try {
    const object = await getAudio(c.env.AUDIO_BUCKET, audioKey, logger);
    if (!object) {
      logger.log('audio_serve_miss', { audio_key: audioKey, total_ms: Date.now() - start });
      return c.json({ error: 'Audio not found' }, 404);
    }

    logger.log('audio_serve_hit', {
      audio_key: audioKey,
      size_bytes: object.size,
      total_ms: Date.now() - start,
    });

    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType ?? 'audio/ogg');
    headers.set('Content-Length', String(object.size));
    headers.set('Cache-Control', 'private, max-age=86400');

    return new Response(object.body, { headers });
  } catch (error) {
    logger.error('audio_get_error', error, { audio_key: audioKey, total_ms: Date.now() - start });
    return c.json({ error: 'Failed to retrieve audio' }, 500);
  }
});

// Voice-submission serving endpoint — serves archived inbound voice messages
// from R2. Separate from the TTS audio route so we can diverge on auth/cache
// policy later without entangling the two. R2 keys are unguessable UUIDs,
// but this route still sits behind the global `/api/*` Bearer middleware
// above (line 83) — same posture as the existing `/api/v1/audio/*` route.
//
// Consumers (web client, Telegram gateway) MUST send `Authorization: Bearer
// $ENGINE_API_KEY` to fetch these objects. URLs handed to clients via
// `AudioAttachment.url` cannot be embedded directly in a `<audio src>` tag
// from a browser context that cannot inject auth headers — fetch as a blob
// with auth and pass an object URL to the player, or have a server-side
// integration (gateway) download-with-auth and re-deliver. This matches
// how TTS audio at `/api/v1/audio/*` is consumed today.
app.get('/api/v1/voice-submissions/*', async (c) => {
  const start = Date.now();
  const key = c.req.path.replace('/api/v1/voice-submissions/', '');
  if (!key || !key.startsWith(`${VOICE_SUBMISSION_PREFIX}/`)) {
    return c.json({ error: 'Invalid voice-submission key' }, 400);
  }

  const logger = createRequestLogger(crypto.randomUUID());
  try {
    const object = await getAudio(c.env.AUDIO_BUCKET, key, logger);
    if (!object) {
      logger.log('voice_submission_serve_miss', {
        voice_submission_key: key,
        total_ms: Date.now() - start,
      });
      return c.json({ error: 'Voice submission not found' }, 404);
    }

    logger.log('voice_submission_serve_hit', {
      voice_submission_key: key,
      size_bytes: object.size,
      total_ms: Date.now() - start,
    });

    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType ?? 'audio/ogg');
    headers.set('Content-Length', String(object.size));
    headers.set('Cache-Control', 'private, max-age=86400');

    return new Response(object.body, { headers });
  } catch (error) {
    logger.error('voice_submission_get_error', error, {
      voice_submission_key: key,
      total_ms: Date.now() - start,
    });
    return c.json({ error: 'Failed to retrieve voice submission' }, 500);
  }
});

// Admin auth middleware - validates org-specific or super admin access.
// NOTE: auth rejections for these routes are already gated and logged
// (auth_rejected) by the global `/api/*` middleware above, which runs first. A
// request only reaches here after presenting a valid ENGINE_API_KEY, so the
// rejection branches below are effectively unreachable and deliberately do not
// re-log — the global middleware is the single place auth failures are recorded.
app.use('/api/v1/admin/orgs/:org/*', async (c, next) => {
  const org = c.req.param('org');
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header with Bearer token required' }, 401);
  }

  const token = authHeader.slice(7);

  // Check super admin (ENGINE_API_KEY) first
  if (constantTimeCompare(token, c.env.ENGINE_API_KEY)) {
    return next();
  }

  // Check org-specific admin key from KV
  const orgAdminKey = await c.env.ORG_ADMIN_KEYS.get(org);
  if (orgAdminKey && constantTimeCompare(token, orgAdminKey)) {
    return next();
  }

  return c.json({ error: 'Unauthorized for this organization' }, 403);
});

// Admin endpoints for MCP server management - now using KV directly.
//
// The MCP server list is a single GLOBAL pool by decision (admin-portal#278):
// it is one library shared by every organization, unlike modes/languages,
// which stay per org. The `:org` path parameter keeps the route shape and is
// echoed in responses, but storage always uses MCP_GLOBAL_KEY. See
// readMcpServerPool (src/utils/mcp-servers.ts) for the transitional read
// fallback to the legacy per-org key, and poolNotMigratedResponse for why
// writes are refused while that fallback is what is serving the pool.
app.get('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
  const discover = c.req.query('discover') === 'true';
  const logger = createRequestLogger(crypto.randomUUID());

  const orgError = validateOrgNotReserved(org);
  if (orgError) {
    return c.json({ error: orgError }, 400);
  }

  try {
    const pool = await readMcpServerPool(c.env.MCP_SERVERS, c.env.DEFAULT_ORG, logger, 'admin');
    const { servers } = pool;
    const state = poolStateFields(c.env.DEFAULT_ORG, pool);

    logger.log('admin_action', {
      action: 'list_mcp_servers',
      org,
      server_count: servers.length,
      discover,
      migrated: pool.migrated,
    });

    // If discover=true, run discovery and include status/errors in response
    if (discover && servers.length > 0) {
      const enabledServers = servers.filter((s) => s.enabled);
      const manifests = await discoverAllTools(enabledServers, logger);

      const serverStatuses = servers.map((server) => {
        const manifest = manifests.find((m) => m.serverId === server.id);
        return {
          ...toPublicServerConfig(server, c.env.DEFAULT_ORG),
          discovery_status: manifest ? (manifest.error ? 'error' : 'ok') : 'skipped',
          discovery_error: manifest?.error ?? null,
          tools_count: manifest?.tools.length ?? 0,
        };
      });

      return c.json({ org, ...state, servers: serverStatuses });
    }

    return c.json({ org, ...state, servers: toPublicServerConfigs(servers, c.env.DEFAULT_ORG) });
  } catch (error) {
    logger.error('admin_action', error, { action: 'list_mcp_servers', org });
    return c.json({ error: 'Failed to read MCP servers from storage' }, 500);
  }
});

/**
 * Migration-state fields spread into admin GET bodies and the 409 body.
 * Unmigrated: `migrated:false`, `code`, `fallback_found`, `legacy_keys`,
 * `legacy_listing`, `stale_global_suspected`, `warning` (guidance from
 * describeMigrationHint). Migrated: `migrated:true`, `legacy_listing`, plus
 * `legacy_keys` and a `warning` when leftovers were seen or the listing was
 * incomplete (describeLeftoverLegacyKeys).
 */
function poolStateFields(defaultOrg: string, pool: McpServerPool) {
  if (!pool.migrated) {
    return {
      migrated: false,
      code: 'MCP_POOL_NOT_MIGRATED',
      fallback_found: pool.fallbackFound,
      legacy_keys: pool.legacyKeys,
      legacy_listing: pool.legacyListing,
      stale_global_suspected: pool.staleGlobalSuspected,
      warning: `The '${MCP_GLOBAL_KEY}' key was not found by this read; this list is served from the legacy '${defaultOrg}' key (or is empty) and writes are refused. ${describeMigrationHint(pool)}`,
    };
  }
  const leftover = describeLeftoverLegacyKeys(pool);
  return leftover === null
    ? { migrated: true, legacy_listing: pool.legacyListing }
    : {
        migrated: true,
        legacy_keys: pool.legacyKeys,
        legacy_listing: pool.legacyListing,
        warning: leftover,
      };
}

/**
 * 409 for a write attempted while `__global__` does not exist. Writes never
 * create or merge from legacy data: with KV's eventual consistency a colo that
 * still sees `__global__` as missing could otherwise rebuild the pool from a
 * stale legacy view on top of a completed migration, and a first write could
 * seal off legacy keys of other orgs. The runbook on admin-portal#278 is the
 * single path that creates the key.
 *
 * Known residual (documented, not solved here): KV has no compare-and-swap,
 * so once migrated a colo holding a stale *hit* on `__global__` can still
 * overwrite a newer pool (last write wins) — the same read-modify-write
 * limitation every admin config route in this file has today, now with a
 * pool-wide blast radius. Closing it needs a version/generation guard or a
 * Durable Object single writer, tracked with the config-versioning work
 * (admin-portal#153/#154).
 */
function poolNotMigratedResponse(
  c: Context<AppEnv>,
  logger: RequestLogger,
  action: string,
  org: string,
  pool: McpServerPool
) {
  logger.warn('admin_action', {
    action,
    org,
    rejected: 'mcp_pool_not_migrated',
    global_key: MCP_GLOBAL_KEY,
    fallback_key: c.env.DEFAULT_ORG,
    fallback_found: pool.fallbackFound,
    legacy_keys: pool.legacyKeys,
    legacy_listing: pool.legacyListing,
    stale_global_suspected: pool.staleGlobalSuspected,
  });
  // Same field set as an unmigrated GET so one client parser serves both.
  return c.json(
    {
      error: `MCP server pool key '${MCP_GLOBAL_KEY}' does not exist in this namespace, so writes are refused. ${describeMigrationHint(pool)}`,
      ...poolStateFields(c.env.DEFAULT_ORG, pool),
    },
    409
  );
}

/**
 * Common guard for the three pool write routes: the reserved-org 400 and the
 * super-admin 403 (poolWriteAuthError). Today the global `/api/*` middleware
 * already accepts nothing but ENGINE_API_KEY, so the 403 is a second fence
 * rather than a live gate — it keeps the invariant next to the shared store in
 * case org-scoped admin keys are ever honoured upstream.
 */
function rejectMcpWrite(c: Context<AppEnv>, logger: RequestLogger, action: string, org: string) {
  const orgError = validateOrgNotReserved(org);
  if (orgError) {
    return c.json({ error: orgError }, 400);
  }
  const authError = poolWriteAuthError(c.req.header('Authorization'), c.env.ENGINE_API_KEY);
  if (authError === null) {
    return null;
  }
  logger.warn('admin_action', { action, org, rejected: 'mcp_pool_write_requires_super_admin' });
  return c.json({ error: authError }, 403);
}

app.put('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  const rejected = rejectMcpWrite(c, logger, 'replace_mcp_servers', org);
  if (rejected) {
    return rejected;
  }

  const parsed = await readJsonBody(c.req.raw, logger, { action: 'replace_mcp_servers', org });
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }
  const bodyError = validateServerListBody(parsed.body);
  if (bodyError) {
    return c.json(bodyError, 400);
  }
  const writes = parsed.body as MCPServerWrite[];

  try {
    // Replace-all for the list; authToken merged by id against the stored
    // pool (omitted → preserve, null/"" → clear, string → set).
    // NOTE: read-modify-write without compare-and-swap — a stale read can
    // overwrite a newer pool (last write wins); see poolNotMigratedResponse.
    const pool = await readMcpServerPool(c.env.MCP_SERVERS, c.env.DEFAULT_ORG, logger, 'admin');
    if (!pool.migrated) {
      return poolNotMigratedResponse(c, logger, 'replace_mcp_servers', org, pool);
    }
    const servers = mergeServerPool(writes, pool.servers, org);

    await c.env.MCP_SERVERS.put(MCP_GLOBAL_KEY, JSON.stringify(servers));
    logger.log('admin_action', {
      action: 'replace_mcp_servers',
      org,
      storage_key: MCP_GLOBAL_KEY,
      server_count: servers.length,
      server_ids: servers.map((s) => s.id),
    });
    return c.json({
      org,
      servers: toPublicServerConfigs(servers, c.env.DEFAULT_ORG),
      message: 'MCP servers updated',
    });
  } catch (error) {
    logger.error('admin_action', error, { action: 'replace_mcp_servers', org });
    return c.json({ error: 'Failed to write MCP servers to storage' }, 500);
  }
});

/**
 * Validate a PUT …/mcp-servers body: an array of at most MAX_SERVERS valid
 * server configs with unique ids. Returns the 400 body, or null when valid.
 */
function validateServerListBody(body: unknown): Record<string, unknown> | null {
  if (!Array.isArray(body)) {
    return { error: 'Request body must be an array of server configs' };
  }
  if (body.length > MAX_SERVERS) {
    return { error: `Cannot have more than ${MAX_SERVERS} servers in the global pool` };
  }
  for (const write of body) {
    const error = validateServerConfig(write);
    if (error) {
      const id =
        write !== null && typeof write === 'object' ? (write as { id?: unknown }).id : undefined;
      return id === undefined ? { error } : { error, server_id: id };
    }
  }
  const duplicates = findDuplicateServerIds(body as MCPServerWrite[]);
  if (duplicates.length > 0) {
    return { error: `Duplicate server id(s): ${duplicates.join(', ')}`, server_ids: duplicates };
  }
  return null;
}

/**
 * Parse + validate a single-server write body for POST …/mcp-servers.
 * Defaults `enabled` to true when absent (pre-#278 behaviour).
 */
async function readServerWriteBody(
  req: Request,
  logger: RequestLogger,
  org: string
): Promise<{ ok: true; write: MCPServerWrite } | { ok: false; error: string }> {
  const parsed = await readJsonBody(req, logger, { action: 'add_mcp_server', org });
  if (!parsed.ok) {
    return parsed;
  }
  const body = parsed.body as Partial<MCPServerWrite> | null;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a server config object' };
  }
  const write = { ...body, enabled: body.enabled ?? true } as MCPServerWrite;
  const error = validateServerConfig(write);
  return error ? { ok: false, error } : { ok: true, write };
}

app.post('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  const rejected = rejectMcpWrite(c, logger, 'add_mcp_server', org);
  if (rejected) {
    return rejected;
  }

  const parsed = await readServerWriteBody(c.req.raw, logger, org);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }
  const { write } = parsed;

  try {
    const pool = await readMcpServerPool(c.env.MCP_SERVERS, c.env.DEFAULT_ORG, logger, 'admin');
    if (!pool.migrated) {
      return poolNotMigratedResponse(c, logger, 'add_mcp_server', org, pool);
    }
    const existing = pool.servers;
    const isUpdate = existing.some((s) => s.id === write.id);
    if (!isUpdate && existing.length >= MAX_SERVERS) {
      return c.json(
        { error: `Cannot have more than ${MAX_SERVERS} servers in the global pool` },
        400
      );
    }

    // Upsert by id; authToken merged against the stored entry (omitted →
    // preserve, null/"" → clear, string → set).
    // NOTE: This read-modify-write pattern can race with concurrent requests (last write wins).
    // This is acceptable for admin endpoints which are low-volume and authenticated.
    const servers = upsertServer(write, existing, org);

    await c.env.MCP_SERVERS.put(MCP_GLOBAL_KEY, JSON.stringify(servers));
    logger.log('admin_action', {
      action: 'add_mcp_server',
      org,
      storage_key: MCP_GLOBAL_KEY,
      server_id: write.id,
      server_url: write.url,
      updated: isUpdate,
      server_count: servers.length,
    });
    return c.json({
      org,
      servers: toPublicServerConfigs(servers, c.env.DEFAULT_ORG),
      message: 'MCP server added',
    });
  } catch (error) {
    logger.error('admin_action', error, { action: 'add_mcp_server', org });
    return c.json({ error: 'Failed to update MCP servers in storage' }, 500);
  }
});

app.delete('/api/v1/admin/orgs/:org/mcp-servers/:serverId', async (c) => {
  const org = c.req.param('org');
  const serverId = c.req.param('serverId');
  const logger = createRequestLogger(crypto.randomUUID());

  const rejected = rejectMcpWrite(c, logger, 'remove_mcp_server', org);
  if (rejected) {
    return rejected;
  }

  const idError = validateServerId(serverId);
  if (idError) {
    return c.json({ error: idError }, 400);
  }

  try {
    const pool = await readMcpServerPool(c.env.MCP_SERVERS, c.env.DEFAULT_ORG, logger, 'admin');
    if (!pool.migrated) {
      return poolNotMigratedResponse(c, logger, 'remove_mcp_server', org, pool);
    }
    // NOTE: read-modify-write without compare-and-swap (last write wins); see
    // poolNotMigratedResponse.
    const filtered = pool.servers.filter((s) => s.id !== serverId);

    await c.env.MCP_SERVERS.put(MCP_GLOBAL_KEY, JSON.stringify(filtered));
    logger.log('admin_action', {
      action: 'remove_mcp_server',
      org,
      storage_key: MCP_GLOBAL_KEY,
      server_id: serverId,
      server_count: filtered.length,
    });
    return c.json({
      org,
      servers: toPublicServerConfigs(filtered, c.env.DEFAULT_ORG),
      message: 'MCP server removed',
    });
  } catch (error) {
    logger.error('admin_action', error, { action: 'remove_mcp_server', org });
    return c.json({ error: 'Failed to update MCP servers in storage' }, 500);
  }
});

// Admin endpoints for org config management.
// `ORG_CONFIG` also holds the model-route breaker (#403) under reserved
// `__route_health__:<route>` keys, and these routes take the org id straight
// from the path — so a `__`-prefixed "org" must never reach the KV calls.
app.use('/api/v1/admin/orgs/:org/config', async (c, next) => {
  if (c.req.param('org').startsWith('__')) {
    return c.json({ error: 'Org ids starting with "__" are reserved' }, 400);
  }
  return next();
});

app.get('/api/v1/admin/orgs/:org/config', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    const stored = (await c.env.ORG_CONFIG.get<OrgConfig>(org, 'json')) ?? {};
    const merged = { ...DEFAULT_ORG_CONFIG, ...stored };

    logger.log('admin_action', { action: 'get_org_config', org, config: merged });
    return c.json({ org, config: merged });
  } catch (error) {
    // Return defaults with warning on read failure (matches chat flow behavior)
    logger.error('admin_action', error, { action: 'get_org_config', org });
    return c.json({
      org,
      config: DEFAULT_ORG_CONFIG,
      warning: 'Failed to read org config from storage, returning defaults',
    });
  }
});

app.put('/api/v1/admin/orgs/:org/config', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());
  const updates = (await c.req.json()) as OrgConfig;

  const validationError = validateOrgConfig(updates);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  try {
    // Merge with existing config (upsert behavior)
    // NOTE: This read-modify-write pattern can race with concurrent requests (last write wins).
    // This is acceptable for admin endpoints which are low-volume and authenticated.
    const existing = (await c.env.ORG_CONFIG.get<OrgConfig>(org, 'json')) ?? {};
    const merged: OrgConfig = { ...existing };

    if (updates.max_history_storage !== undefined) {
      merged.max_history_storage = updates.max_history_storage;
    }
    if (updates.max_history_llm !== undefined) {
      merged.max_history_llm = updates.max_history_llm;
    }

    // Re-validate merged config for cross-field constraints
    const mergedValidationError = validateOrgConfig(merged);
    if (mergedValidationError) {
      return c.json({ error: mergedValidationError }, 400);
    }

    await c.env.ORG_CONFIG.put(org, JSON.stringify(merged));
    logger.log('admin_action', { action: 'update_org_config', org, config: merged });

    const withDefaults = { ...DEFAULT_ORG_CONFIG, ...merged };
    return c.json({ org, config: withDefaults, message: 'Org config updated' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'update_org_config', org });
    return c.json({ error: 'Failed to update org config in storage' }, 500);
  }
});

app.delete('/api/v1/admin/orgs/:org/config', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    await c.env.ORG_CONFIG.delete(org);
    logger.log('admin_action', { action: 'reset_org_config', org, config: DEFAULT_ORG_CONFIG });
    return c.json({ org, config: DEFAULT_ORG_CONFIG, message: 'Org config reset to defaults' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'reset_org_config', org });
    return c.json({ error: 'Failed to delete org config from storage' }, 500);
  }
});

// Admin endpoints for org-level prompt overrides
// NOTE: The admin GET endpoint intentionally returns raw template variables (e.g. {{version}})
// in the resolved preview so admins can see what placeholders are configured. Template variables
// are only substituted at runtime in the chat path (via applyTemplateVariables in user-session).
app.get('/api/v1/admin/orgs/:org/prompt-overrides', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    const overrides = (await c.env.PROMPT_OVERRIDES.get<PromptOverrides>(org, 'json')) ?? {};
    const resolved = resolvePromptOverrides(overrides, {}, {});

    logger.log('admin_action', {
      action: 'get_prompt_overrides',
      org,
      slots_set: Object.keys(overrides).length,
    });
    return c.json({ org, overrides, resolved });
  } catch (error) {
    logger.error('admin_action', error, { action: 'get_prompt_overrides', org });
    return c.json({ error: 'Failed to read prompt overrides from storage' }, 500);
  }
});

app.put('/api/v1/admin/orgs/:org/prompt-overrides', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());
  const updates = await c.req.json();

  const validationError = validatePromptOverrides(updates);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  try {
    // NOTE: This read-modify-write pattern can race with concurrent requests (last write wins).
    // This is acceptable for admin endpoints which are low-volume and authenticated.
    const existing = (await c.env.PROMPT_OVERRIDES.get<PromptOverrides>(org, 'json')) ?? {};
    const merged = mergePromptOverrides(existing, updates as PromptOverrides);

    await c.env.PROMPT_OVERRIDES.put(org, JSON.stringify(merged));
    const resolved = resolvePromptOverrides(merged, {}, {});

    logger.log('admin_action', {
      action: 'update_prompt_overrides',
      org,
      slots_set: Object.keys(merged).length,
    });
    return c.json({ org, overrides: merged, resolved, message: 'Prompt overrides updated' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'update_prompt_overrides', org });
    return c.json({ error: 'Failed to update prompt overrides in storage' }, 500);
  }
});

app.delete('/api/v1/admin/orgs/:org/prompt-overrides', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    await c.env.PROMPT_OVERRIDES.delete(org);
    logger.log('admin_action', { action: 'reset_prompt_overrides', org, slots_cleared: true });
    return c.json({
      org,
      overrides: {},
      resolved: DEFAULT_PROMPT_VALUES,
      message: 'Prompt overrides reset to defaults',
    });
  } catch (error) {
    logger.error('admin_action', error, { action: 'reset_prompt_overrides', org });
    return c.json({ error: 'Failed to delete prompt overrides from storage' }, 500);
  }
});

// Admin endpoints for org-level mode management
app.get('/api/v1/admin/orgs/:org/modes', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    const orgModes = (await c.env.PROMPT_OVERRIDES.get<OrgModes>(`${org}:modes`, 'json')) ?? {
      modes: [],
    };

    logger.log('admin_action', { action: 'list_modes', org, mode_count: orgModes.modes.length });
    return c.json({ org, modes: orgModes.modes.map(toMarkdownView) });
  } catch (error) {
    logger.error('admin_action', error, { action: 'list_modes', org });
    return c.json({ error: 'Failed to read modes from storage' }, 500);
  }
});

app.get('/api/v1/admin/orgs/:org/modes/:modeName', async (c) => {
  const org = c.req.param('org');
  const modeName = c.req.param('modeName');
  const logger = createRequestLogger(crypto.randomUUID());

  const nameError = validateModeName(modeName);
  if (nameError) {
    return c.json({ error: nameError }, 400);
  }

  try {
    const orgModes = (await c.env.PROMPT_OVERRIDES.get<OrgModes>(`${org}:modes`, 'json')) ?? {
      modes: [],
    };
    // findModeBySlug honors aliases (#284) so admin tooling can address a mode
    // by an old slug after a rename.
    const mode = findModeBySlug(orgModes.modes, modeName);
    if (!mode) {
      return c.json({ error: `Mode '${modeName}' not found` }, 404);
    }

    logger.log('admin_action', { action: 'get_mode', org, mode_name: mode.name });
    return c.json({ org, mode: toMarkdownView(mode) });
  } catch (error) {
    logger.error('admin_action', error, { action: 'get_mode', org });
    return c.json({ error: 'Failed to read mode from storage' }, 500);
  }
});

app.put('/api/v1/admin/orgs/:org/modes/:modeName', async (c) => {
  const org = c.req.param('org');
  const modeName = c.req.param('modeName');
  const logger = createRequestLogger(crypto.randomUUID());

  const nameError = validateModeName(modeName);
  if (nameError) {
    return c.json({ error: nameError }, 400);
  }

  const body = await c.req.json();
  const modeInput = { ...body, name: modeName };
  const modeError = validatePromptMode(modeInput);
  if (modeError) {
    return c.json({ error: modeError }, 400);
  }

  try {
    // NOTE: This read-modify-write pattern can race with concurrent requests (last write wins).
    // This is acceptable for admin endpoints which are low-volume and authenticated.
    const orgModes = (await c.env.PROMPT_OVERRIDES.get<OrgModes>(`${org}:modes`, 'json')) ?? {
      modes: [],
    };

    const result = upsertMode(orgModes, modeInput, org, logger);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    await c.env.PROMPT_OVERRIDES.put(`${org}:modes`, JSON.stringify(orgModes));
    logger.log('admin_action', {
      action: 'upsert_mode',
      org,
      mode_name: modeName,
      mode_count: orgModes.modes.length,
      saved_shape: result.savedMode.document !== undefined ? 'document' : 'overrides',
      published: result.savedMode.published === true,
    });
    return c.json({ org, mode: toMarkdownView(result.savedMode), message: 'Mode saved' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'upsert_mode', org });
    return c.json({ error: 'Failed to save mode to storage' }, 500);
  }
});

app.delete('/api/v1/admin/orgs/:org/modes/:modeName', async (c) => {
  const org = c.req.param('org');
  const modeName = c.req.param('modeName');
  const logger = createRequestLogger(crypto.randomUUID());

  const nameError = validateModeName(modeName);
  if (nameError) {
    return c.json({ error: nameError }, 400);
  }

  try {
    const orgModes = (await c.env.PROMPT_OVERRIDES.get<OrgModes>(`${org}:modes`, 'json')) ?? {
      modes: [],
    };

    const filtered = orgModes.modes.filter((m) => m.name !== modeName);
    if (filtered.length === orgModes.modes.length) {
      return c.json({ error: `Mode '${modeName}' not found` }, 404);
    }

    orgModes.modes = filtered;

    await c.env.PROMPT_OVERRIDES.put(`${org}:modes`, JSON.stringify(orgModes));
    logger.log('admin_action', {
      action: 'delete_mode',
      org,
      mode_name: modeName,
      mode_count: orgModes.modes.length,
    });
    return c.json({ org, modes: orgModes.modes.map(toMarkdownView), message: 'Mode deleted' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'delete_mode', org });
    return c.json({ error: 'Failed to delete mode from storage' }, 500);
  }
});

// ── Mode rename / clone / retire-and-forward (issue #284) ──────────────────────
// Alias-based cohort moves: rename/reslug a mode, clone one, or retire a mode
// and forward its subscribers — all without stranding users. Admin-gated by the
// `/api/v1/admin/orgs/:org/*` middleware above (covers POST). The leading `_`
// keeps these action routes from colliding with `/modes/:modeName`.

/** Map a ModeOpResult error code to an HTTP status. */
function modeOpStatus(code: 'not_found' | 'conflict' | 'invalid'): 404 | 409 | 400 {
  if (code === 'not_found') return 404;
  if (code === 'conflict') return 409;
  return 400;
}

app.post('/api/v1/admin/orgs/:org/modes/:modeName/_rename', async (c) => {
  const org = c.req.param('org');
  const modeName = c.req.param('modeName');
  const logger = createRequestLogger(crypto.randomUUID());

  const nameError = validateModeName(modeName);
  if (nameError) return c.json({ error: nameError }, 400);

  const body = (await c.req.json().catch(() => null)) as { newName?: unknown } | null;
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Request body must be a JSON object with { newName }' }, 400);
  }

  try {
    const orgModes = (await c.env.PROMPT_OVERRIDES.get<OrgModes>(`${org}:modes`, 'json')) ?? {
      modes: [],
    };
    const result = renameMode(orgModes, modeName, body.newName);
    if (!result.ok) return c.json({ error: result.error }, modeOpStatus(result.code));

    await c.env.PROMPT_OVERRIDES.put(`${org}:modes`, JSON.stringify(orgModes));
    logger.log('mode_renamed', { org, from: modeName, to: result.savedMode.name });
    return c.json({ org, mode: toMarkdownView(result.savedMode), message: 'Mode renamed' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'rename_mode', org });
    return c.json({ error: 'Failed to rename mode in storage' }, 500);
  }
});

app.post('/api/v1/admin/orgs/:org/modes/:modeName/_clone', async (c) => {
  const org = c.req.param('org');
  const modeName = c.req.param('modeName');
  const logger = createRequestLogger(crypto.randomUUID());

  const nameError = validateModeName(modeName);
  if (nameError) return c.json({ error: nameError }, 400);

  const body = (await c.req.json().catch(() => null)) as {
    newName?: unknown;
    newLabel?: unknown;
  } | null;
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Request body must be a JSON object with { newName, newLabel? }' }, 400);
  }
  if (body.newLabel !== undefined && typeof body.newLabel !== 'string') {
    return c.json({ error: 'newLabel must be a string' }, 400);
  }

  try {
    const orgModes = (await c.env.PROMPT_OVERRIDES.get<OrgModes>(`${org}:modes`, 'json')) ?? {
      modes: [],
    };
    const result = cloneMode(orgModes, modeName, body.newName, body.newLabel);
    if (!result.ok) return c.json({ error: result.error }, modeOpStatus(result.code));

    await c.env.PROMPT_OVERRIDES.put(`${org}:modes`, JSON.stringify(orgModes));
    logger.log('mode_cloned', { org, from: modeName, to: result.savedMode.name });
    return c.json({ org, mode: toMarkdownView(result.savedMode), message: 'Mode cloned' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'clone_mode', org });
    return c.json({ error: 'Failed to clone mode in storage' }, 500);
  }
});

app.post('/api/v1/admin/orgs/:org/modes/:modeName/_retire', async (c) => {
  const org = c.req.param('org');
  const modeName = c.req.param('modeName');
  const logger = createRequestLogger(crypto.randomUUID());

  const nameError = validateModeName(modeName);
  if (nameError) return c.json({ error: nameError }, 400);

  const body = (await c.req.json().catch(() => null)) as { forwardTo?: unknown } | null;
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Request body must be a JSON object with { forwardTo }' }, 400);
  }

  try {
    const orgModes = (await c.env.PROMPT_OVERRIDES.get<OrgModes>(`${org}:modes`, 'json')) ?? {
      modes: [],
    };
    const result = retireMode(orgModes, modeName, body.forwardTo);
    if (!result.ok) return c.json({ error: result.error }, modeOpStatus(result.code));

    await c.env.PROMPT_OVERRIDES.put(`${org}:modes`, JSON.stringify(orgModes));
    logger.log('mode_retired_forwarded', {
      org,
      retired: modeName,
      forward_to: result.savedMode.name,
    });
    return c.json({
      org,
      mode: toMarkdownView(result.savedMode),
      message: `Mode retired; subscribers forwarded to '${result.savedMode.name}'`,
    });
  } catch (error) {
    logger.error('admin_action', error, { action: 'retire_mode', org });
    return c.json({ error: 'Failed to retire mode in storage' }, 500);
  }
});

/**
 * Parse a JSON request body at an admin route boundary. A malformed body is a
 * client error: it must surface as a 400 with route-scoped logging, never
 * escape to Hono's default handler as a generic 500 (PR #357 review finding).
 */
async function readJsonBody(
  req: Request,
  logger: RequestLogger,
  logContext: Record<string, unknown>,
  options: { allowEmpty?: boolean } = {}
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    if (!options.allowEmpty) return { ok: true, body: await req.json() };
    // allowEmpty: an absent body is `undefined`; a present one must be JSON.
    const text = await req.text();
    return { ok: true, body: text.trim() === '' ? undefined : JSON.parse(text) };
  } catch (error) {
    logger.warn('admin_action', {
      ...logContext,
      rejected: 'invalid_json_body',
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: 'Request body must be valid JSON' };
  }
}

// Admin endpoints for org-level language management
app.get('/api/v1/admin/orgs/:org/languages', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    const orgLanguages = (await c.env.PROMPT_OVERRIDES.get<OrgLanguages>(
      `${org}:languages`,
      'json'
    )) ?? {
      languages: [],
    };

    logger.log('admin_action', {
      action: 'list_languages',
      org,
      language_count: orgLanguages.languages.length,
    });
    return c.json({ org, ...orgLanguages });
  } catch (error) {
    logger.error('admin_action', error, { action: 'list_languages', org });
    return c.json({ error: 'Failed to read languages from storage' }, 500);
  }
});

app.get('/api/v1/admin/orgs/:org/languages/:languageName', async (c) => {
  const org = c.req.param('org');
  const languageName = c.req.param('languageName');
  const logger = createRequestLogger(crypto.randomUUID());

  const nameError = validateLanguageName(languageName);
  if (nameError) {
    return c.json({ error: nameError }, 400);
  }

  try {
    const orgLanguages = (await c.env.PROMPT_OVERRIDES.get<OrgLanguages>(
      `${org}:languages`,
      'json'
    )) ?? {
      languages: [],
    };
    const language = orgLanguages.languages.find((l) => l.name === languageName);
    if (!language) {
      return c.json({ error: `Language '${languageName}' not found` }, 404);
    }

    logger.log('admin_action', { action: 'get_language', org, language_name: languageName });
    return c.json({ org, language });
  } catch (error) {
    logger.error('admin_action', error, { action: 'get_language', org });
    return c.json({ error: 'Failed to read language from storage' }, 500);
  }
});

app.put('/api/v1/admin/orgs/:org/languages/:languageName', async (c) => {
  const org = c.req.param('org');
  const languageName = c.req.param('languageName');
  const logger = createRequestLogger(crypto.randomUUID());

  const nameError = validateLanguageName(languageName);
  if (nameError) {
    return c.json({ error: nameError }, 400);
  }

  const parsed = await readJsonBody(c.req.raw, logger, {
    action: 'upsert_language',
    org,
    language_name: languageName,
  });
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }
  const languageInput = { ...(parsed.body as Record<string, unknown>), name: languageName };
  const languageError = validateLanguage(languageInput);
  if (languageError) {
    return c.json({ error: languageError }, 400);
  }

  try {
    // NOTE: This read-modify-write pattern can race with concurrent requests (last write wins).
    // This is acceptable for admin endpoints which are low-volume and authenticated.
    const orgLanguages = (await c.env.PROMPT_OVERRIDES.get<OrgLanguages>(
      `${org}:languages`,
      'json'
    )) ?? {
      languages: [],
    };

    const result = upsertLanguage(orgLanguages, languageInput as Language, org, logger);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    await c.env.PROMPT_OVERRIDES.put(`${org}:languages`, JSON.stringify(orgLanguages));
    logger.log('admin_action', {
      action: 'upsert_language',
      org,
      language_name: languageName,
      language_count: orgLanguages.languages.length,
      published: result.savedLanguage.published === true,
      document_length: result.savedLanguage.document.length,
    });
    return c.json({ org, language: result.savedLanguage, message: 'Language saved' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'upsert_language', org });
    return c.json({ error: 'Failed to save language to storage' }, 500);
  }
});

app.delete('/api/v1/admin/orgs/:org/languages/:languageName', async (c) => {
  const org = c.req.param('org');
  const languageName = c.req.param('languageName');
  const logger = createRequestLogger(crypto.randomUUID());

  const nameError = validateLanguageName(languageName);
  if (nameError) {
    return c.json({ error: nameError }, 400);
  }

  try {
    const orgLanguages = (await c.env.PROMPT_OVERRIDES.get<OrgLanguages>(
      `${org}:languages`,
      'json'
    )) ?? {
      languages: [],
    };

    if (orgLanguages.defaultLanguage === languageName) {
      logger.warn('admin_action', {
        action: 'delete_language',
        org,
        language_name: languageName,
        rejected: 'is_org_default',
      });
      return c.json(
        {
          error: `Language '${languageName}' is the org default language — unset or reassign the default first`,
        },
        409
      );
    }

    const filtered = orgLanguages.languages.filter((l) => l.name !== languageName);
    const removed = filtered.length !== orgLanguages.languages.length;

    if (removed) {
      orgLanguages.languages = filtered;
      await c.env.PROMPT_OVERRIDES.put(`${org}:languages`, JSON.stringify(orgLanguages));
    }

    logger.log('admin_action', {
      action: 'delete_language',
      org,
      language_name: languageName,
      language_count: orgLanguages.languages.length,
      already_absent: !removed,
    });
    return c.json({ org, languages: orgLanguages.languages, message: 'Language deleted' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'delete_language', org });
    return c.json({ error: 'Failed to delete language from storage' }, 500);
  }
});

// Org default language (worker#356): the chat-time fallback when a turn has
// no `@`-trigger and no per-user persisted selection. A sibling route rather
// than `/languages/default` because `default` is a legal language slug under
// LANGUAGE_NAME_PATTERN and would collide with `/languages/:languageName`.
app.get('/api/v1/admin/orgs/:org/languages-default', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    const orgLanguages = (await c.env.PROMPT_OVERRIDES.get<OrgLanguages>(
      `${org}:languages`,
      'json'
    )) ?? {
      languages: [],
    };

    const name = orgLanguages.defaultLanguage ?? null;
    logger.log('admin_action', { action: 'get_default_language', org, language_name: name });
    return c.json({ org, name });
  } catch (error) {
    logger.error('admin_action', error, { action: 'get_default_language', org });
    return c.json({ error: 'Failed to read default language from storage' }, 500);
  }
});

app.put('/api/v1/admin/orgs/:org/languages-default', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  const parsed = await readJsonBody(c.req.raw, logger, { action: 'set_default_language', org });
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  try {
    // NOTE: This read-modify-write pattern can race with concurrent requests (last write wins).
    // This is acceptable for admin endpoints which are low-volume and authenticated.
    const orgLanguages = (await c.env.PROMPT_OVERRIDES.get<OrgLanguages>(
      `${org}:languages`,
      'json'
    )) ?? {
      languages: [],
    };

    const result = validateDefaultLanguageUpdate(parsed.body, orgLanguages);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    if (result.name === null) {
      delete orgLanguages.defaultLanguage;
    } else {
      orgLanguages.defaultLanguage = result.name;
    }
    await c.env.PROMPT_OVERRIDES.put(`${org}:languages`, JSON.stringify(orgLanguages));

    logger.log('admin_action', {
      action: 'set_default_language',
      org,
      language_name: result.name,
      cleared: result.name === null,
    });
    return c.json({
      org,
      name: result.name,
      message: result.name === null ? 'Default language cleared' : 'Default language set',
    });
  } catch (error) {
    logger.error('admin_action', error, { action: 'set_default_language', org });
    return c.json({ error: 'Failed to save default language to storage' }, 500);
  }
});

/**
 * Aggregated resource listing across the global MCP server pool (worker#257
 * item 1; contract locked on admin-portal#230; pool made global by
 * admin-portal#278). Fans out to every enabled server, normalizes each
 * listing into canonical subjects, and reports per-server capability
 * honestly via `servers[]` (ok/unsupported/error).
 */
app.get('/api/v1/admin/orgs/:org/resources', async (c) => {
  const org = c.req.param('org');
  const language = c.req.query('language');
  const logger = createRequestLogger(crypto.randomUUID());

  const orgError = validateOrgNotReserved(org);
  if (orgError) {
    return c.json({ error: orgError }, 400);
  }

  const languageError = validateResourceLanguage(language);
  if (languageError) {
    return c.json({ error: languageError }, 400);
  }
  // validateResourceLanguage narrows: language is a non-empty string here
  const lang = language as string;

  try {
    const pool = await readMcpServerPool(c.env.MCP_SERVERS, c.env.DEFAULT_ORG, logger, 'admin');
    const { servers } = pool;
    const result = await listOrgResources(servers, lang, logger);

    logger.log('admin_action', {
      action: 'list_resources',
      org,
      language: lang,
      server_count: servers.length,
      ok_count: result.servers.filter((s) => s.status === 'ok').length,
      unsupported_count: result.servers.filter((s) => s.status === 'unsupported').length,
      error_count: result.servers.filter((s) => s.status === 'error').length,
      subject_count: Object.keys(result.resources).length,
    });
    return c.json({
      org,
      language: lang,
      ...poolStateFields(c.env.DEFAULT_ORG, pool),
      resources: result.resources,
      servers: result.servers,
    });
  } catch (error) {
    logger.error('admin_action', error, { action: 'list_resources', org, language: lang });
    return c.json({ error: 'Failed to aggregate resources from MCP servers' }, 500);
  }
});

// Admin endpoints for per-org language scaffold
app.get('/api/v1/admin/orgs/:org/language-scaffold', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    const stored = await c.env.PROMPT_OVERRIDES.get<LanguageScaffold>(
      `${org}:language-scaffold`,
      'json'
    );
    const scaffold = stored ?? DEFAULT_LANGUAGE_SCAFFOLD;

    logger.log('admin_action', {
      action: 'get_language_scaffold',
      org,
      is_default: stored === null,
      document_length: scaffold.document.length,
    });
    return c.json({ org, scaffold });
  } catch (error) {
    logger.error('admin_action', error, { action: 'get_language_scaffold', org });
    return c.json({ error: 'Failed to read language scaffold from storage' }, 500);
  }
});

app.put('/api/v1/admin/orgs/:org/language-scaffold', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());
  const body = await c.req.json();

  const validationError = validateLanguageScaffold(body);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const scaffold: LanguageScaffold = {
    document: sanitizeScaffoldDocument((body as LanguageScaffold).document),
  };

  try {
    await c.env.PROMPT_OVERRIDES.put(`${org}:language-scaffold`, JSON.stringify(scaffold));
    logger.log('admin_action', {
      action: 'update_language_scaffold',
      org,
      document_length: scaffold.document.length,
    });
    return c.json({ org, scaffold, message: 'Language scaffold updated' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'update_language_scaffold', org });
    return c.json({ error: 'Failed to update language scaffold in storage' }, 500);
  }
});

app.delete('/api/v1/admin/orgs/:org/language-scaffold', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    await c.env.PROMPT_OVERRIDES.delete(`${org}:language-scaffold`);
    logger.log('admin_action', { action: 'reset_language_scaffold', org });
    return c.json({
      org,
      scaffold: DEFAULT_LANGUAGE_SCAFFOLD,
      message: 'Language scaffold reset to default',
    });
  } catch (error) {
    logger.error('admin_action', error, { action: 'reset_language_scaffold', org });
    return c.json({ error: 'Failed to reset language scaffold in storage' }, 500);
  }
});

// Admin endpoints for user mode selection (routed to DO)
app.get('/api/v1/admin/orgs/:org/users/:userId/mode', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/mode');
});

app.put('/api/v1/admin/orgs/:org/users/:userId/mode', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/mode');
});

app.delete('/api/v1/admin/orgs/:org/users/:userId/mode', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/mode');
});

// Admin endpoints for user-level prompt overrides (routed to DO)
app.get('/api/v1/admin/orgs/:org/users/:userId/prompt-overrides', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/prompt-overrides');
});

app.put('/api/v1/admin/orgs/:org/users/:userId/prompt-overrides', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/prompt-overrides');
});

app.delete('/api/v1/admin/orgs/:org/users/:userId/prompt-overrides', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/prompt-overrides');
});

// Admin endpoints for user memory (routed to DO)
app.get('/api/v1/admin/orgs/:org/users/:userId/memory', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/memory');
});

app.delete('/api/v1/admin/orgs/:org/users/:userId/memory', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/memory');
});

// Admin endpoint for user history (routed to DO)
app.delete('/api/v1/admin/orgs/:org/users/:userId/history', async (c) => {
  const org = c.req.param('org');
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, org, userId, '/history');
});

// Admin endpoint: open a DO directly by the 64-hex object id the Cloudflare
// REST API's namespace object listing returns, and report its stored identity
// plus chat history. This is the only path into a DO whose
// `user:{org}:{user_id}` name is unknown — listing ids are one-way and
// `idFromName` is not reversible — which is what makes the DO population
// retroactively enumerable. Reaches the DO's own /identity and /history
// handlers; identity is null for DOs that predate identity persistence and
// have not chatted since. Super-admin only: the path sits outside
// /api/v1/admin/orgs/*, so the global /api/* middleware (ENGINE_API_KEY)
// is the sole gate.
app.get('/api/v1/admin/do/:hexId/snapshot', async (c) => {
  const hexId = c.req.param('hexId');
  const logger = createRequestLogger(crypto.randomUUID());
  if (!/^[0-9a-f]{64}$/.test(hexId)) {
    logger.warn('admin_do_snapshot_rejected', {
      reason: 'malformed_hex_id',
      hex_length: hexId.length,
    });
    return c.json({ error: 'hexId must be a 64-character lowercase hex Durable Object id' }, 400);
  }
  try {
    const stub = c.env.USER_DO.get(c.env.USER_DO.idFromString(hexId));
    const limit = c.req.query('limit') ?? '100';
    const [identityRes, historyRes] = await Promise.all([
      stub.fetch('http://do/identity'),
      stub.fetch(`http://do/history?limit=${encodeURIComponent(limit)}`),
    ]);

    // A non-2xx from either subrequest must NOT be decoded as a result — see
    // readDoSnapshot for why an incomplete snapshot must never look complete.
    const snapshot = await readDoSnapshot(identityRes, historyRes);
    if (!snapshot.ok) {
      logger.error('admin_action', new Error('do_snapshot_subrequest_failed'), {
        action: 'do_snapshot',
        do_id: hexId,
        identity_status: snapshot.identityStatus,
        history_status: snapshot.historyStatus,
      });
      return c.json(
        {
          error: 'Durable Object snapshot incomplete',
          identity_status: snapshot.identityStatus,
          history_status: snapshot.historyStatus,
        },
        502
      );
    }

    const { identity, history } = snapshot;
    logger.log('admin_action', {
      action: 'do_snapshot',
      do_id: hexId,
      has_identity: !!identity,
      history_count: history.entries?.length ?? 0,
    });
    return c.json({ do_id: hexId, identity, history });
  } catch (error) {
    logger.error('admin_action', error, { action: 'do_snapshot', do_id: hexId });
    return c.json({ error: 'Failed to snapshot Durable Object' }, 500);
  }
});

// ── Partner API keys (admin-portal#354) ──────────────────────────────────────
//
// ENGINE_API_KEY only (the /api/v1/admin/* guard above refuses partner keys).
// Org-agnostic paths, like the DO snapshot route, because a super admin lists
// across orgs; `?org=` filters. Responses go through toPublicPartnerKey, which
// never carries the hash; the plaintext appears only in the create and rotate
// responses, as `apiKey`, and cannot be fetched again.

const PARTNER_KEYS_BASE = '/api/v1/admin/api-keys';

/** On every response that carries a plaintext key: no cache may keep a copy. */
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

function unknownOrgMessage(org: string): string {
  return `Org '${org}' has no configuration in this worker (check the spelling). Pass "allow_new_org": true to create a key for an org that is not configured yet.`;
}

/** The PartnerKeyStoreDO client for this request (shares its request id). */
const keyStore = (c: Context<AppEnv>) =>
  partnerKeyStore(c.env.PARTNER_KEY_STORE, c.get('requestId'));

app.post(PARTNER_KEYS_BASE, async (c) => {
  const logger = c.get('logger');
  const parsed = await readJsonBody(c.req.raw, logger, { action: 'create_api_key' });
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const validated = validatePartnerKeyCreate(parsed.body);
  if (!validated.ok) return c.json({ error: validated.error }, 400);

  try {
    const { org } = validated.input;
    if (!validated.allowNewOrg && !(await orgHasConfig(c.env, org))) {
      logger.warn('admin_action', { action: 'create_api_key', org, rejected: 'unknown_org' });
      return c.json({ error: unknownOrgMessage(org), code: 'unknown_org' }, 400);
    }
    const { record, plaintext, warnings } = await keyStore(c).create(validated.input);
    logger.log('admin_action', {
      action: 'create_api_key',
      key_id: record.id,
      org: record.org,
      app: record.app,
      created_by: record.createdBy,
      warnings,
    });
    return c.json(
      { key: toPublicPartnerKey(record), warnings, apiKey: plaintext },
      201,
      NO_STORE_HEADERS
    );
  } catch (error) {
    logger.error('admin_action', error, { action: 'create_api_key', org: validated.input.org });
    return c.json({ error: 'Failed to create API key' }, 500);
  }
});

app.get(PARTNER_KEYS_BASE, async (c) => {
  const logger = c.get('logger');
  const org = c.req.query('org');
  if (org !== undefined) {
    const orgError = validatePartnerKeyOrg(org);
    if (orgError) return c.json({ error: orgError }, 400);
  }
  try {
    const { records } = await keyStore(c).list(org);
    logger.log('admin_action', {
      action: 'list_api_keys',
      org: org ?? null,
      count: records.length,
    });
    // The DO list is always complete; `truncated` stays (always false) for
    // contract stability with clients written against the KV-index list.
    return c.json({
      org: org ?? null,
      keys: records.map((r) => toPublicPartnerKey(r)),
      truncated: false,
    });
  } catch (error) {
    logger.error('admin_action', error, { action: 'list_api_keys', org: org ?? null });
    return c.json({ error: 'Failed to list API keys' }, 500);
  }
});

app.get(`${PARTNER_KEYS_BASE}/:keyId`, async (c) => {
  const keyId = c.req.param('keyId');
  const logger = c.get('logger');
  try {
    const record = await keyStore(c).get(keyId);
    if (!record) return c.json({ error: 'API key not found' }, 404);
    logger.log('admin_action', { action: 'get_api_key', key_id: keyId });
    return c.json({ key: toPublicPartnerKey(record) });
  } catch (error) {
    logger.error('admin_action', error, { action: 'get_api_key', key_id: keyId });
    return c.json({ error: 'Failed to read API key' }, 500);
  }
});

app.post(`${PARTNER_KEYS_BASE}/:keyId/_revoke`, async (c) => {
  const keyId = c.req.param('keyId');
  const logger = c.get('logger');
  const ctx = { action: 'revoke_api_key', key_id: keyId };
  const parsed = await readJsonBody(c.req.raw, logger, ctx, { allowEmpty: true });
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const actor = readRevokeBody(parsed.body);
  if (!actor.ok) return c.json({ error: actor.error }, 400);

  try {
    const result = await keyStore(c).revoke(keyId, actor.revokedBy);
    if (!result) return c.json({ error: 'API key not found' }, 404);
    logger.log('admin_action', {
      ...ctx,
      org: result.record.org,
      already_revoked: result.alreadyRevoked,
      revoked_ids: result.revokedIds,
      revoked_by: actor.revokedBy ?? null,
      warnings: result.warnings,
    });
    return c.json({
      key: toPublicPartnerKey(result.record),
      alreadyRevoked: result.alreadyRevoked,
      revokedIds: result.revokedIds,
      warnings: result.warnings,
    });
  } catch (error) {
    logger.error('admin_action', error, ctx);
    return c.json({ error: 'Failed to revoke API key' }, 500);
  }
});

app.post(`${PARTNER_KEYS_BASE}/:keyId/_rotate`, async (c) => {
  const keyId = c.req.param('keyId');
  const logger = c.get('logger');
  const ctx = { action: 'rotate_api_key', key_id: keyId };
  const parsed = await readJsonBody(c.req.raw, logger, ctx, { allowEmpty: true });
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = readRotateBody(parsed.body);
  if (!body.ok) return c.json({ error: body.error }, 400);

  try {
    const { ok: _ok, ...opts } = body;
    const result = await keyStore(c).rotate(keyId, opts);
    if (result.status !== 'ok') return rotateRefusal(c, result);
    logger.log('admin_action', {
      ...ctx,
      org: result.record.org,
      new_key_id: result.record.id,
      grace_seconds: body.graceSeconds,
      old_expires_at: result.previous.expiresAt ?? null,
      revoked_ids: result.revokedIds,
      warnings: result.warnings,
    });
    return c.json(
      {
        key: toPublicPartnerKey(result.record),
        previous: toPublicPartnerKey(result.previous),
        revokedIds: result.revokedIds,
        warnings: result.warnings,
        apiKey: result.plaintext,
      },
      200,
      NO_STORE_HEADERS
    );
  } catch (error) {
    logger.error('admin_action', error, ctx);
    return c.json({ error: 'Failed to rotate API key' }, 500);
  }
});

/** HTTP response for a rotation that did not happen. */
function rotateRefusal(c: Context<AppEnv>, result: Exclude<RotateOutcome, { status: 'ok' }>) {
  switch (result.status) {
    case 'not_found':
      return c.json({ error: 'API key not found' }, 404);
    case 'revoked':
      return c.json(
        { error: 'A revoked or expired API key cannot be rotated; create a new key' },
        409
      );
    case 'already_rotated':
      return c.json(
        { error: `This key was already rotated to ${result.rotatedTo}; rotate that key instead` },
        409
      );
  }
}

// ── Group/thread admin helpers ──────────────────────────────────────────────────

/** Handle a group admin request with chatId validation. */
function handleGroupRequest(
  c: { req: { raw: Request; param: (k: string) => string }; env: Env },
  doPath: string
) {
  const org = c.req.param('org');
  const chatId = c.req.param('chatId');
  const chatIdError = validateChatIdParam(chatId, 'chatId');
  if (chatIdError) return Promise.resolve(Response.json({ error: chatIdError }, { status: 400 }));
  return handleDORequest({
    request: c.req.raw,
    env: c.env,
    org,
    doKey: `group:${org}:${chatId}`,
    doPath,
  });
}

/** Handle a thread admin request with chatId + threadId validation. */
function handleThreadRequest(
  c: { req: { raw: Request; param: (k: string) => string }; env: Env },
  doPath: string
) {
  const org = c.req.param('org');
  const chatId = c.req.param('chatId');
  const threadId = c.req.param('threadId');
  const chatIdError = validateChatIdParam(chatId, 'chatId');
  if (chatIdError) return Promise.resolve(Response.json({ error: chatIdError }, { status: 400 }));
  const threadIdError = validateChatIdParam(threadId, 'threadId');
  if (threadIdError)
    return Promise.resolve(Response.json({ error: threadIdError }, { status: 400 }));
  return handleDORequest({
    request: c.req.raw,
    env: c.env,
    org,
    doKey: `group:${org}:${chatId}:${threadId}`,
    doPath,
  });
}

// ── Group admin endpoints (routed to group DO) ─────────────────────────────────

app.get('/api/v1/admin/orgs/:org/groups/:chatId/preferences', (c) =>
  handleGroupRequest(c, '/preferences')
);
app.put('/api/v1/admin/orgs/:org/groups/:chatId/preferences', (c) =>
  handleGroupRequest(c, '/preferences')
);
app.get('/api/v1/admin/orgs/:org/groups/:chatId/history', (c) => handleGroupRequest(c, '/history'));
app.delete('/api/v1/admin/orgs/:org/groups/:chatId/history', (c) =>
  handleGroupRequest(c, '/history')
);
app.get('/api/v1/admin/orgs/:org/groups/:chatId/memory', (c) => handleGroupRequest(c, '/memory'));
app.delete('/api/v1/admin/orgs/:org/groups/:chatId/memory', (c) =>
  handleGroupRequest(c, '/memory')
);
app.get('/api/v1/admin/orgs/:org/groups/:chatId/mode', (c) => handleGroupRequest(c, '/mode'));
app.put('/api/v1/admin/orgs/:org/groups/:chatId/mode', (c) => handleGroupRequest(c, '/mode'));
app.delete('/api/v1/admin/orgs/:org/groups/:chatId/mode', (c) => handleGroupRequest(c, '/mode'));

// ── Thread admin endpoints (routed to thread-specific DO) ───────────────────────

app.get('/api/v1/admin/orgs/:org/groups/:chatId/threads/:threadId/preferences', (c) =>
  handleThreadRequest(c, '/preferences')
);
app.put('/api/v1/admin/orgs/:org/groups/:chatId/threads/:threadId/preferences', (c) =>
  handleThreadRequest(c, '/preferences')
);
app.get('/api/v1/admin/orgs/:org/groups/:chatId/threads/:threadId/history', (c) =>
  handleThreadRequest(c, '/history')
);
app.delete('/api/v1/admin/orgs/:org/groups/:chatId/threads/:threadId/history', (c) =>
  handleThreadRequest(c, '/history')
);
app.get('/api/v1/admin/orgs/:org/groups/:chatId/threads/:threadId/memory', (c) =>
  handleThreadRequest(c, '/memory')
);
app.delete('/api/v1/admin/orgs/:org/groups/:chatId/threads/:threadId/memory', (c) =>
  handleThreadRequest(c, '/memory')
);

// Instrument the worker fetch handler: every invocation gets a request root span
// and all outbound fetch hops (Anthropic, MCP, TTS, webhooks) auto-nest under it.
// Additive + feature-flagged — a true no-op until OTEL_EXPORTER_OTLP_ENDPOINT +
// OTEL_COLLECTOR_TOKEN are set.
export default instrument(app, resolveTelemetryConfig);

/** Storage shape tag for log/diagnostic clarity. */
type ModeShape = 'overrides' | 'document';

function modeShape(mode: PromptMode): ModeShape {
  return mode.document !== undefined ? 'document' : 'overrides';
}

/** Normalize an aliases field: an empty/absent array collapses to undefined. */
function normalizeAliases(aliases: string[] | undefined): string[] | undefined {
  return aliases && aliases.length > 0 ? aliases : undefined;
}

/**
 * Strip keys whose value is `undefined` or `''` (the optional-field omission
 * convention used across mode/language admin views). Booleans like `false` and
 * objects like `{}` are kept, so `published: false` survives. Lets callers
 * build a flat object and drop empties in one pass instead of N conditional
 * spreads (which each add cyclomatic complexity).
 */
function compactOptional<T extends Record<string, unknown>>(
  obj: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined && value !== '')
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/**
 * Project a stored mode to the markdown-document admin response shape
 * (Phase 1 of #200). Legacy modes carry their original overrides as
 * `originalSlots` for one release — diagnostics + rollback safety net.
 * Modes already stored as markdown pass their `document` through unchanged
 * and omit `originalSlots`.
 */
export function toMarkdownView(mode: PromptMode): {
  name: string;
  aliases?: string[];
  label?: string;
  description?: string;
  welcome_message?: string;
  published?: boolean;
  requires_group?: boolean;
  document: string;
  format: 'markdown';
  originalSlots?: PromptOverrides;
} {
  const isLegacy = mode.document === undefined;
  const document = isLegacy ? synthesizeModeDocument(mode.overrides ?? {}) : mode.document!;
  return {
    name: mode.name,
    ...compactOptional({
      aliases: normalizeAliases(mode.aliases),
      label: mode.label,
      description: mode.description,
      // #311: first-contact welcome copy is an authored scalar that must
      // survive the round-trip to the portal editor, or a re-save silently
      // drops it (mergeExistingMode reads it back off this view's PUT).
      welcome_message: mode.welcome_message,
      published: mode.published,
      requires_group: mode.requires_group,
      originalSlots: isLegacy ? (mode.overrides ?? {}) : undefined,
    }),
    document,
    format: 'markdown' as const,
  };
}

/**
 * Compute the merged content field(s) for a mode upsert (Phase 1 of #200).
 *
 * Same-shape merge:
 *  - both have `overrides` → slot-level merge (partial PUTs supported).
 *  - both have `document` → wholesale replace document.
 *
 * Mismatched-shape merge: incoming wins wholesale. The stored
 * counterpart-shape field is cleared.
 */
function mergeContentFields(
  existing: PromptMode,
  incoming: PromptMode
): { overrides: PromptOverrides } | { document: string } {
  if (incoming.document !== undefined) {
    return { document: stripControlChars(incoming.document) };
  }
  // incoming has overrides (validated upstream). If existing had a document
  // we drop it; if existing had overrides we slot-merge.
  if (existing.document !== undefined) {
    return { overrides: incoming.overrides ?? {} };
  }
  return { overrides: mergePromptOverrides(existing.overrides ?? {}, incoming.overrides ?? {}) };
}

/**
 * Resolve a nullable, clearable authored scalar on mode upsert (#311, FIX 4).
 * `welcome_message` is the one field an author must be able to turn OFF, so it
 * departs from the plain `incoming ?? existing` rule with three cases:
 *
 *  - OMITTED (`undefined`) ⇒ UNCHANGED — the existing value carries through
 *    (the portal editor's normal save omits the field).
 *  - explicit `null` OR empty string `''` ⇒ CLEARED — returns `undefined` so
 *    `compactOptional` drops the key and the stored mode loses the field.
 *  - a non-empty string ⇒ SET to that value.
 *
 * `null` reaches here because `validateOptionalString` accepts it (JSON has no
 * `undefined`, so a portal "clear" sends `null`); a plain `?? existing` would
 * treat it as a no-op. `''` already opted out via `compactOptional` dropping
 * empty strings — this makes both explicit. Mirrors the prompt-slot tombstone
 * convention (`mergePromptOverrides`: `null` deletes a slot).
 */
function resolveClearableModeField(
  incoming: string | null | undefined,
  existing: string | undefined
): string | undefined {
  if (incoming === undefined) return existing;
  return incoming === null || incoming === '' ? undefined : incoming;
}

/**
 * Merge an incoming mode with an existing one (Phase 1 of #200).
 *
 * Scalar fields (label/description/published) follow the prior "incoming
 * wins if present, otherwise existing carries through" rule unchanged.
 * Content fields are resolved by `mergeContentFields` above.
 */
function mergeExistingMode(existing: PromptMode, incoming: PromptMode): PromptMode {
  // Aliases (issue #284) are managed by the rename/retire endpoints, not the
  // portal editor. A normal PUT omits them, so preserve the existing set;
  // an explicit incoming array (already format-validated) replaces it.
  return {
    name: incoming.name,
    ...compactOptional({
      aliases: normalizeAliases(incoming.aliases ?? existing.aliases),
      label: incoming.label ?? existing.label,
      description: incoming.description ?? existing.description,
      // #311 FIX 4: omit ⇒ unchanged, explicit null/'' ⇒ cleared, string ⇒ set.
      // (A plain `?? existing` made null a no-op, so a welcome could never be
      // turned off.) The cast reflects that JSON can deliver null even though
      // the PromptMode type declares `welcome_message?: string`.
      welcome_message: resolveClearableModeField(
        incoming.welcome_message as string | null | undefined,
        existing.welcome_message
      ),
      published: incoming.published ?? existing.published,
      requires_group: incoming.requires_group ?? existing.requires_group,
    }),
    ...mergeContentFields(existing, incoming),
  };
}

/**
 * Build the stored record for a BRAND-NEW mode. Strips control characters from
 * `document` (mirroring the language scaffold pattern) and normalizes
 * `welcome_message` exactly as `mergeExistingMode` does on the update path
 * (#311 FIX 3): an explicit `null` or `''` means "no welcome", so store NO field
 * rather than persisting `null` (which violates the `string | undefined` shape
 * and returns null to clients). A non-empty string is kept; an omitted field is
 * absent. Returns a fresh object so the caller never mutates `modeInput`.
 */
function buildNewMode(modeInput: PromptMode): PromptMode {
  const newMode: PromptMode = { ...modeInput };
  if (newMode.document !== undefined) {
    newMode.document = stripControlChars(newMode.document);
  }
  const resolvedWelcome = resolveClearableModeField(
    newMode.welcome_message as string | null | undefined,
    undefined
  );
  if (resolvedWelcome === undefined) {
    delete newMode.welcome_message;
  } else {
    newMode.welcome_message = resolvedWelcome;
  }
  return newMode;
}

/**
 * Upsert a mode into an OrgModes array, merging with any existing mode.
 * Mutates orgModes.modes in-place (splice/push) and returns the result.
 *
 * Sanitizes the incoming document field (if any) by stripping control
 * characters before persistence, mirroring the language scaffold pattern.
 */
export function upsertMode(
  orgModes: OrgModes,
  modeInput: PromptMode,
  org: string,
  logger?: ReturnType<typeof createRequestLogger>
): { ok: true; savedMode: PromptMode } | { ok: false; error: string } {
  const existingIdx = orgModes.modes.findIndex((m) => m.name === modeInput.name);
  if (existingIdx >= 0) {
    const savedMode = mergeExistingMode(orgModes.modes[existingIdx]!, modeInput);
    // Enforce the org-wide slug invariant (#284): the saved mode's name + any
    // aliases must not collide with another mode's name/aliases.
    const collision = checkModeSlugUniqueness(
      orgModes.modes,
      [savedMode.name, ...(savedMode.aliases ?? [])],
      [savedMode.name]
    );
    if (collision) return { ok: false, error: collision };
    logger?.log('admin_action', {
      action: 'upsert_mode_before',
      org,
      mode_name: modeInput.name,
      existing_shape: modeShape(orgModes.modes[existingIdx]!),
      incoming_shape: modeShape(modeInput),
    });
    orgModes.modes.splice(existingIdx, 1, savedMode);
    return { ok: true, savedMode };
  }

  if (orgModes.modes.length >= MAX_MODES_PER_ORG) {
    return { ok: false, error: `Cannot have more than ${MAX_MODES_PER_ORG} modes per org` };
  }

  // New mode: a name colliding with another mode's alias is rejected loudly.
  const collision = checkModeSlugUniqueness(orgModes.modes, [
    modeInput.name,
    ...(modeInput.aliases ?? []),
  ]);
  if (collision) return { ok: false, error: collision };

  // New mode: sanitize the document field and normalize welcome_message.
  const newMode = buildNewMode(modeInput);

  logger?.log('admin_action', {
    action: 'upsert_mode_before',
    org,
    mode_name: modeInput.name,
    existing_shape: null,
    incoming_shape: modeShape(modeInput),
  });
  orgModes.modes.push(newMode);
  return { ok: true, savedMode: newMode };
}

/**
 * Result of a rename/clone/retire mode operation (issue #284). `code` lets the
 * thin HTTP handler map failures to the right status: `not_found` → 404,
 * `conflict` (slug collision) → 409, `invalid` (bad input / limit) → 400.
 */
type ModeOpResult =
  | { ok: true; savedMode: PromptMode }
  | { ok: false; error: string; code: 'not_found' | 'conflict' | 'invalid' };

/** Dedup a slug list, preserving order. */
function dedupeSlugs(slugs: string[]): string[] {
  return [...new Set(slugs)];
}

/**
 * Rename/reslug a mode in place (issue #284). The old slug is retained as an
 * alias so every subscriber whose persisted `selected_mode` still holds it is
 * rerouted at lookup time instead of being stranded. Mutates `orgModes` in
 * place. Label/description/content/published are untouched.
 *
 * `newName` may be one of the mode's OWN existing aliases — this "promotes" the
 * alias back to canonical and demotes the prior name to an alias (an
 * un-rename). It is rejected (409) only when `newName` collides with a
 * DIFFERENT mode's name or alias; the uniqueness check excludes the source.
 */
export function renameMode(orgModes: OrgModes, fromSlug: string, newName: unknown): ModeOpResult {
  const source = findModeBySlug(orgModes.modes, fromSlug);
  if (!source) {
    return { ok: false, error: `Mode '${fromSlug}' not found`, code: 'not_found' };
  }
  const nameError = validateModeName(newName);
  if (nameError) return { ok: false, error: nameError, code: 'invalid' };
  const target = newName as string;
  if (target === source.name) {
    return { ok: false, error: 'newName must differ from the current name', code: 'invalid' };
  }

  // Old canonical slug (and any prior aliases) keep resolving; newName must not
  // appear among them.
  const newAliases = dedupeSlugs([...(source.aliases ?? []), source.name]).filter(
    (a) => a !== target
  );
  const aliasError = validateModeAliases(newAliases);
  if (aliasError) return { ok: false, error: aliasError, code: 'invalid' };

  const collision = checkModeSlugUniqueness(orgModes.modes, [target, ...newAliases], [source.name]);
  if (collision) return { ok: false, error: collision, code: 'conflict' };

  source.name = target;
  if (newAliases.length > 0) source.aliases = newAliases;
  else delete source.aliases;
  return { ok: true, savedMode: source };
}

/**
 * Clone a mode under a new slug (issue #284). A clone is a NEW identity:
 * content/description/requires_group are deep-copied, the clone is forced
 * unpublished, and aliases are deliberately NOT copied. Mutates `orgModes`.
 */
export function cloneMode(
  orgModes: OrgModes,
  fromSlug: string,
  newName: unknown,
  newLabel?: string
): ModeOpResult {
  const source = findModeBySlug(orgModes.modes, fromSlug);
  if (!source) {
    return { ok: false, error: `Mode '${fromSlug}' not found`, code: 'not_found' };
  }
  const nameError = validateModeName(newName);
  if (nameError) return { ok: false, error: nameError, code: 'invalid' };
  const target = newName as string;

  if (orgModes.modes.length >= MAX_MODES_PER_ORG) {
    return {
      ok: false,
      error: `Cannot have more than ${MAX_MODES_PER_ORG} modes per org`,
      code: 'invalid',
    };
  }
  const collision = checkModeSlugUniqueness(orgModes.modes, [target]);
  if (collision) return { ok: false, error: collision, code: 'conflict' };

  const clone: PromptMode = {
    name: target,
    ...compactOptional({
      label: newLabel ?? source.label,
      description: source.description,
      // #311: welcome copy is content the author wrote, so a clone carries it
      // (aliases are the deliberate exception — a clone is a new identity).
      welcome_message: source.welcome_message,
      requires_group: source.requires_group,
    }),
    published: false,
    // Copy exactly one content shape, mirroring the stored mode (#200).
    ...(source.document !== undefined
      ? { document: source.document }
      : { overrides: { ...(source.overrides ?? {}) } }),
  };
  orgModes.modes.push(clone);
  return { ok: true, savedMode: clone };
}

/**
 * Retire a mode and forward its subscribers to another mode (issue #284,
 * scenario B). The retired mode's slug and any of its existing aliases are
 * moved into `forwardTo`'s aliases, then the source mode is deleted — so every
 * retired-mode subscriber silently resolves to `forwardTo`. Mutates `orgModes`.
 */
export function retireMode(orgModes: OrgModes, fromSlug: string, forwardTo: unknown): ModeOpResult {
  const source = findModeBySlug(orgModes.modes, fromSlug);
  if (!source) {
    return { ok: false, error: `Mode '${fromSlug}' not found`, code: 'not_found' };
  }
  if (typeof forwardTo !== 'string') {
    return { ok: false, error: 'forwardTo must be a string', code: 'invalid' };
  }
  const target = findModeBySlug(orgModes.modes, forwardTo);
  if (!target) {
    return { ok: false, error: `forwardTo mode '${forwardTo}' not found`, code: 'not_found' };
  }
  if (target.name === source.name) {
    return { ok: false, error: 'Cannot forward a mode to itself', code: 'invalid' };
  }

  // The source's slugs (canonical + aliases) move onto the target.
  const movedSlugs = dedupeSlugs([source.name, ...(source.aliases ?? [])]);
  const newAliases = dedupeSlugs([...(target.aliases ?? []), ...movedSlugs]).filter(
    (a) => a !== target.name
  );
  const aliasError = validateModeAliases(newAliases);
  if (aliasError) return { ok: false, error: aliasError, code: 'invalid' };

  // Defensive: moved slugs must not collide with any OTHER mode (source +
  // target excluded — source is being deleted, target is the destination).
  const collision = checkModeSlugUniqueness(orgModes.modes, movedSlugs, [source.name, target.name]);
  if (collision) return { ok: false, error: collision, code: 'conflict' };

  target.aliases = newAliases;
  orgModes.modes = orgModes.modes.filter((m) => m.name !== source.name);
  return { ok: true, savedMode: target };
}

/** Merge an incoming language with an existing one. Document is replaced wholesale. */
function mergeExistingLanguage(existing: Language, incoming: Language): Language {
  // published is rebuilt explicitly: incoming wins if present (publish/unpublish action),
  // otherwise existing carries through. Mirrors mergeExistingMode semantics.
  const publishedResolved = incoming.published ?? existing.published;
  return {
    name: incoming.name,
    document: sanitizeLanguageDocument(incoming.document),
    ...((incoming.label ?? existing.label) ? { label: incoming.label ?? existing.label } : {}),
    ...(publishedResolved !== undefined ? { published: publishedResolved } : {}),
  };
}

/**
 * Upsert a language into an OrgLanguages collection.
 * Mutates orgLanguages.languages in-place (splice/push) and returns the result.
 */
export function upsertLanguage(
  orgLanguages: OrgLanguages,
  languageInput: Language,
  org: string,
  logger?: ReturnType<typeof createRequestLogger>
): { ok: true; savedLanguage: Language } | { ok: false; error: string } {
  const existingIdx = orgLanguages.languages.findIndex((l) => l.name === languageInput.name);
  if (existingIdx >= 0) {
    const savedLanguage = mergeExistingLanguage(
      orgLanguages.languages[existingIdx]!,
      languageInput
    );
    logger?.log('admin_action', {
      action: 'upsert_language_before',
      org,
      language_name: languageInput.name,
      existing_document_length: orgLanguages.languages[existingIdx]!.document.length,
      incoming_document_length: languageInput.document.length,
    });
    orgLanguages.languages.splice(existingIdx, 1, savedLanguage);
    return { ok: true, savedLanguage };
  }

  if (orgLanguages.languages.length >= MAX_LANGUAGES_PER_ORG) {
    return {
      ok: false,
      error: `Cannot have more than ${MAX_LANGUAGES_PER_ORG} languages per org`,
    };
  }
  const sanitized: Language = {
    ...languageInput,
    document: sanitizeLanguageDocument(languageInput.document),
  };
  logger?.log('admin_action', {
    action: 'upsert_language_before',
    org,
    language_name: languageInput.name,
    existing_document_length: null,
    incoming_document_length: languageInput.document.length,
  });
  orgLanguages.languages.push(sanitized);
  return { ok: true, savedLanguage: sanitized };
}

/**
 * Read a value from KV by org key, returning a fallback on error.
 * All KV reads are non-critical — chat can proceed with defaults if KV is unavailable.
 */
async function readOrgKV<T>(
  kv: KVNamespace,
  org: string,
  fallback: T,
  errorEvent: string,
  logger: ReturnType<typeof createRequestLogger>
): Promise<T> {
  try {
    return (await kv.get<T>(org, 'json')) ?? fallback;
  } catch (error) {
    logger.error(errorEvent, error);
    return fallback;
  }
}

/** Read all org-level KV data needed for chat requests. */
async function readAllOrgKV(env: Env, org: string, logger: ReturnType<typeof createRequestLogger>) {
  return Promise.all([
    // MCP servers are a global pool, not per org (admin-portal#278).
    readMcpServerPoolOrEmpty(env.MCP_SERVERS, env.DEFAULT_ORG, logger),
    readOrgKV<OrgConfig>(env.ORG_CONFIG, org, {}, 'org_config_kv_read_error', logger),
    readOrgKV<PromptOverrides>(
      env.PROMPT_OVERRIDES,
      org,
      {},
      'prompt_overrides_kv_read_error',
      logger
    ),
    // Home org modes plus every other org's published modes (admin-portal#336).
    readAllPublishedModes(env.PROMPT_OVERRIDES, org, logger),
    readOrgKV<OrgLanguages>(
      env.PROMPT_OVERRIDES,
      `${org}:languages`,
      { languages: [] },
      'org_languages_kv_read_error',
      logger
    ),
  ]);
}

/** DO internal pathname for each chat transport. */
function doChatPathForTransport(transport: ChatTransport): string {
  switch (transport) {
    case 'final':
      return '/chat/final';
    case 'stream':
      return '/chat/stream';
    case 'callback':
      return '/chat/callback';
  }
}

/** Max length for chat_id and thread_id path parameters. */
const MAX_CHAT_ID_LENGTH = 256;
/** Pattern: alphanumeric, hyphens, underscores, dots, colons (Telegram IDs are typically numeric). */
const CHAT_ID_PATTERN = /^[\w.:-]+$/;

/** Validate a chat_id or thread_id path parameter. Returns an error string or null. */
function validateChatIdParam(value: string, paramName: string): string | null {
  if (!value) return `${paramName} is required`;
  if (value.length > MAX_CHAT_ID_LENGTH)
    return `${paramName} must be <= ${MAX_CHAT_ID_LENGTH} characters`;
  if (!CHAT_ID_PATTERN.test(value)) return `${paramName} contains invalid characters`;
  return null;
}

/**
 * Resolve the DO ID based on chat type and routing fields.
 *
 * Private: user:{org}:{user_id}
 * Group (no topics): group:{org}:{chat_id}
 * Supergroup thread: group:{org}:{chat_id}:{thread_id}
 */
function resolveDOId(env: Env, org: string, body: ChatRequest): DurableObjectId {
  const chatType: ChatType = body.chat_type ?? 'private';

  if (chatType === 'group' || chatType === 'supergroup') {
    if (!body.chat_id) {
      throw new ValidationError('chat_id is required for group/supergroup chats');
    }
    const key = body.thread_id
      ? `group:${org}:${body.chat_id}:${body.thread_id}`
      : `group:${org}:${body.chat_id}`;
    return env.USER_DO.idFromName(key);
  }

  return env.USER_DO.idFromName(`user:${org}:${body.user_id}`);
}

/**
 * Build a DO request with org-level KV data injected into the body.
 */
async function buildDOChatRequest(
  request: Request,
  env: Env,
  opts: {
    body: ChatRequest;
    org: string;
    transport: ChatTransport;
    logger: ReturnType<typeof createRequestLogger>;
    requestId?: string;
    caller: ChatCaller;
  }
): Promise<{ stub: DurableObjectStub; doRequest: Request }> {
  const { body, org, transport, logger } = opts;

  const [mcpServers, orgConfig, promptOverrides, orgModes, orgLanguages] = await readAllOrgKV(
    env,
    org,
    logger
  );

  const doId = resolveDOId(env, org, body);
  const stub = env.USER_DO.get(doId);

  logger.log('do_routed', {
    do_id: doId.toString(),
    transport,
    mcp_server_count: mcpServers.length,
    org_config: orgConfig,
  });

  const doUrl = new URL(request.url);
  doUrl.pathname = doChatPathForTransport(transport);

  const headers = new Headers(request.headers);
  if (opts.requestId) {
    headers.set('X-Request-ID', opts.requestId);
  }
  // Pass the real worker origin so the DO can build public-facing audio URLs
  headers.set('X-Worker-Origin', new URL(request.url).origin);

  const doRequest = new Request(doUrl.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...body,
      _mcp_servers: mcpServers,
      _org_config: orgConfig,
      _org_prompt_overrides: promptOverrides,
      _org_modes: orgModes,
      _org_languages: orgLanguages,
      // Edge country of the ORIGINAL request — the DO cannot see request.cf
      // across the stub boundary, so it rides in the body. This key is set
      // AFTER the spread, so a client-supplied `_edge_country` in the inbound
      // body is always overwritten and can never reach telemetry.
      _edge_country: (request.cf as { country?: string } | undefined)?.country,
      // Who authenticated (#354). Also set AFTER the spread, so it always comes
      // from the auth middleware's principal, never from the client body.
      _caller: opts.caller,
    }),
  });

  return { stub, doRequest };
}

/**
 * Apply the partner-key rules (org forcing, refusals, user namespacing) to a
 * parsed chat body. Internal callers pass through untouched. Returns the body
 * to dispatch, or the rejection response (already logged and counted).
 */
function scopeChatBodyForPrincipal(
  body: Record<string, unknown>,
  principal: Principal,
  transport: ChatTransport,
  logger: RequestLogger
): { ok: true; body: ChatRequest } | { ok: false; response: Response } {
  if (principal.kind !== 'partner') {
    return { ok: true, body: dropNonStringSpeaker(body, logger) as unknown as ChatRequest };
  }
  const result = applyPartnerChatPolicy(body, principal.key);
  if (result.ok) return result;
  const { status, reason, error } = result.rejection;
  logger.warn('partner_request_rejected', { key_id: principal.key.id, reason, transport, status });
  countMetric('requests_total', {
    transport,
    status: 'partner_policy_rejected',
    status_code: status,
  });
  return { ok: false, response: Response.json({ error }, { status }) };
}

/**
 * Internal callers: a `speaker` that is present but not a string cannot be
 * rendered (sanitizeSpeaker takes text), so it is dropped and noted, never a
 * 400 — ENGINE_API_KEY callers are not refused anything new. (Partners get a
 * 400 instead; see applyPartnerChatPolicy.)
 */
function dropNonStringSpeaker(
  body: Record<string, unknown>,
  logger: RequestLogger
): Record<string, unknown> {
  const { speaker, ...rest } = body;
  if (speaker === undefined || speaker === null || typeof speaker === 'string') return body;
  logger.log('chat_speaker_ignored', { reason: 'not_a_string', type: typeof speaker });
  return rest;
}

/**
 * Parse a chat body. Malformed JSON throws SyntaxError; valid JSON that is not
 * an object (`null`, arrays, scalars) throws ValidationError — for every
 * caller, before anything dereferences a field. Both map to 400.
 */
async function readChatBodyObject(request: Request): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.clone().json();
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function handleChatRequest(
  request: Request,
  env: Env,
  transport: ChatTransport,
  context: ChatRequestContext
): Promise<Response> {
  const { principal, requestId, logger } = context;
  const timing = createTimingContext();

  let parsed: Record<string, unknown>;
  try {
    parsed = await readChatBodyObject(request);
  } catch (error) {
    // A malformed body has no identifiers to hash, so there is no scope to be inside.
    return respondToChatRequestError(error, transport, timing, logger);
  }
  // Partner bodies are rewritten (org forced, user_id namespaced) BEFORE the
  // pseudonym scope so telemetry hashes the namespaced id, not the raw one.
  const scoped = scopeChatBodyForPrincipal(parsed, principal, transport, logger);
  if (!scoped.ok) return scoped.response;
  const { body } = scoped;

  // Establish the OTLP user pseudonym for this request's ENTIRE async call tree before
  // anything logs, so every record and span it produces can carry `user_hash` without
  // re-hashing on the sync logging path. The console.log branch is untouched — it still
  // emits raw `user_id`, which is what bt-servant-telemetry's tail ingest depends on.
  return withUserPseudonym(
    env,
    body.client_id,
    body.user_id,
    async () => {
      // The catch MUST live inside the scope. If it sat outside, a rejected promise would
      // resume only after `AsyncLocalStorage.run` restored the outer context, and
      // `request_error` — the record where correlation matters most — would lose its
      // `user_hash`.
      try {
        return await dispatchChatRequest({
          request,
          env,
          transport,
          body,
          logger,
          timing,
          requestId,
          principal,
        });
      } catch (error) {
        return respondToChatRequestError(error, transport, timing, logger);
      }
    },
    (error: unknown) =>
      logger.warn('user_pseudonym_failed', {
        error: error instanceof Error ? error.message : String(error),
        transport,
        client_id: body.client_id,
      })
  );
}

/** Params for {@link dispatchChatRequest} — the chat flow inside the pseudonym scope. */
type ChatDispatchParams = {
  request: Request;
  env: Env;
  transport: ChatTransport;
  body: ChatRequest;
  logger: RequestLogger;
  timing: TimingContext;
  requestId: string;
  /** The auth principal: source of key_id (telemetry) and of `_caller` (partner rules downstream). */
  principal: Principal;
};

/**
 * The chat request flow proper, run inside `withUserPseudonym` so its logs and spans are
 * user-correlatable in OpenObserve. Split out of `handleChatRequest` only to give that
 * scope a callback boundary; the behavior is unchanged.
 */
async function dispatchChatRequest(params: ChatDispatchParams): Promise<Response> {
  const { request, env, transport, body, logger, timing, requestId, principal } = params;
  const caller: ChatCaller = principal.kind;
  const keyId = principalKeyId(principal);
  const validationError = validateChatBody(body, transport, {
    callbackAvailable: caller !== 'partner',
  });
  if (validationError) {
    logger.warn('chat_validation_failed', {
      transport,
      error: validationError,
      user_id: body.user_id,
      client_id: body.client_id,
    });
    countMetric('requests_total', { transport, status: 'validation_failed', status_code: 400 });
    return Response.json({ error: validationError }, { status: 400 });
  }

  const org = resolveOrgFromBody(body, env.DEFAULT_ORG);
  // prettier-ignore
  logger.log('request_received', { user_id: body.user_id, client_id: body.client_id, key_id: keyId, org, transport, chat_type: body.chat_type ?? 'private', chat_id: body.chat_id, thread_id: body.thread_id });

  const { stub, doRequest } = await timePhase(timing, 'kv_and_routing', () =>
    buildDOChatRequest(request, env, { body, org, transport, logger, requestId, caller })
  );
  const response = await timePhase(timing, 'do_fetch', () => stub.fetch(doRequest));

  logger.log('request_timing_summary', {
    user_id: body.user_id,
    org,
    transport,
    total_ms: Date.now() - timing.start,
    phases: timing.phases,
  });

  countMetric('requests_total', {
    transport,
    chat_type: body.chat_type ?? 'private',
    status_code: response.status,
  });
  return response;
}

/** Log + count a failed chat request, then map the error to its HTTP response. */
function respondToChatRequestError(
  error: unknown,
  transport: ChatTransport,
  timing: TimingContext,
  logger: RequestLogger
): Response {
  logger.error('request_error', error, {
    transport,
    total_ms: Date.now() - timing.start,
    phases: timing.phases,
  });
  countMetric('requests_total', {
    transport,
    status: 'error',
    error_name: error instanceof Error ? error.name : 'Error',
  });
  if (error instanceof SyntaxError)
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  if (error instanceof ValidationError)
    return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ error: 'Internal server error' }, { status: 500 });
}

interface DORequestParams {
  request: Request;
  env: Env;
  org: string;
  doKey: string;
  doPath: string;
  userId?: string;
}

/**
 * Handle DO requests (preferences, history, memory).
 *
 * Routes to the DO identified by doKey (e.g. "user:org:userId" or "group:org:chatId").
 */
async function handleDORequest(params: DORequestParams): Promise<Response> {
  const { request, env, org, doKey, doPath, userId } = params;
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId, userId);
  const start = Date.now();

  if (!org) {
    return Response.json({ error: 'org is required in path' }, { status: 400 });
  }

  logger.log('do_request_received', { do_key: doKey, org, path: doPath, method: request.method });

  const doId = env.USER_DO.idFromName(doKey);
  const stub = env.USER_DO.get(doId);

  const doUrl = new URL(request.url);
  doUrl.pathname = doPath;
  if (doPath === '/history' && userId) {
    doUrl.searchParams.set('user_id', userId);
  }

  const doRequest = new Request(doUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' ? request.body : null,
  });

  const response = await stub.fetch(doRequest);
  logger.log('do_request_complete', {
    path: doPath,
    status: response.status,
    duration_ms: Date.now() - start,
  });
  return response;
}

const ALLOWED_PUBLIC_PTXPRINT_PREFIXES = ['usfm/', 'pdfs/', 'fonts/'];

function isAllowedPublicPtxprintKey(key: string): boolean {
  return ALLOWED_PUBLIC_PTXPRINT_PREFIXES.some((p) => key.startsWith(p));
}

async function servePublicPtxprintObject(path: string, env: Env): Promise<Response> {
  const start = Date.now();
  const key = path.replace('/public/ptxprint/', '');
  const logger = createRequestLogger(crypto.randomUUID());
  if (!key) {
    logger.warn('public_ptxprint_invalid_key', { path });
    return Response.json({ error: 'Invalid key' }, { status: 400 });
  }
  if (!isAllowedPublicPtxprintKey(key)) {
    logger.warn('public_ptxprint_disallowed_prefix', { key });
    return Response.json({ error: 'Key not in an allowed prefix' }, { status: 400 });
  }
  let object: R2ObjectBody | null;
  try {
    object = await env.PTXPRINT_BUCKET.get(key);
  } catch (error) {
    logger.error('public_ptxprint_r2_get_error', error, { key, total_ms: Date.now() - start });
    return Response.json({ error: 'Failed to retrieve object' }, { status: 500 });
  }
  if (!object) {
    logger.log('public_ptxprint_miss', { key, total_ms: Date.now() - start });
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  logger.log('public_ptxprint_hit', {
    key,
    size_bytes: object.size,
    content_type: object.httpMetadata?.contentType ?? null,
    total_ms: Date.now() - start,
  });
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

/** Convenience wrapper for user-scoped DO requests. */
async function handleUserRequest(
  request: Request,
  env: Env,
  org: string,
  userId: string,
  doPath: string
): Promise<Response> {
  if (!userId) {
    return Response.json({ error: 'user_id is required in path' }, { status: 400 });
  }
  return handleDORequest({ request, env, org, doKey: `user:${org}:${userId}`, doPath, userId });
}
