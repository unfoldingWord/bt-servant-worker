/**
 * bt-servant-worker entry point
 *
 * Routes requests to Durable Objects for per-user serialization.
 * MCP server config is stored in KV and passed to DOs via request body.
 */

import { Hono } from 'hono';
import { Env } from './config/types.js';
import { APP_VERSION } from './generated/version.js';
import { UserDO } from './durable-objects/index.js';
import { discoverAllTools } from './services/mcp/index.js';
import { MCPServerConfig } from './services/mcp/types.js';
import { ChatRequest, ChatTransport, ChatType } from './types/engine.js';
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
  validateLanguage,
  validateLanguageName,
} from './types/languages.js';
import {
  DEFAULT_LANGUAGE_SCAFFOLD,
  LanguageScaffold,
  sanitizeScaffoldDocument,
  validateLanguageScaffold,
} from './types/language-scaffold.js';
import { synthesizeModeDocument } from './types/mode-markdown.js';
import { stripControlChars } from './types/prompt-overrides.js';
import { constantTimeCompare } from './utils/crypto.js';
import { ValidationError } from './utils/errors.js';
import { getAudio, VOICE_SUBMISSION_PREFIX } from './services/audio/index.js';
import { createRequestLogger } from './utils/logger.js';
import { createTimingContext, timePhase } from './utils/timing.js';
import {
  MAX_SERVERS_PER_ORG,
  validateServerConfig,
  validateServerId,
} from './utils/mcp-validation.js';
import { resolveOrgFromBody } from './utils/org.js';
import { validateChatBody } from './utils/chat-validation.js';

// Re-export so tests and consumers can import from './src/index.js'
export { validateChatBody };

export { UserDO };

const app = new Hono<{ Bindings: Env }>();

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

// Auth middleware for all /api routes
app.use('/api/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    // Observable rejection: never silently drop a 401. Token value is never logged.
    createRequestLogger(crypto.randomUUID()).warn('auth_rejected', {
      reason: 'missing_bearer',
      status: 401,
      path: c.req.path,
      method: c.req.method,
    });
    return c.json({ error: 'Authorization header with Bearer token required' }, 401);
  }

  const token = authHeader.slice(7);
  if (!constantTimeCompare(token, c.env.ENGINE_API_KEY)) {
    createRequestLogger(crypto.randomUUID()).warn('auth_rejected', {
      reason: 'invalid_token',
      status: 403,
      path: c.req.path,
      method: c.req.method,
    });
    return c.json({ error: 'Invalid API key' }, 403);
  }

  return next();
});

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
  return handleChatRequest(c.req.raw, c.env, 'final');
});

app.post('/api/v1/chat/stream', async (c) => {
  return handleChatRequest(c.req.raw, c.env, 'stream');
});

app.post('/api/v1/chat/callback', async (c) => {
  return handleChatRequest(c.req.raw, c.env, 'callback');
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

// Admin endpoints for MCP server management - now using KV directly
app.get('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
  const discover = c.req.query('discover') === 'true';
  const logger = createRequestLogger(crypto.randomUUID());

  try {
    const servers = (await c.env.MCP_SERVERS.get<MCPServerConfig[]>(org, 'json')) ?? [];

    logger.log('admin_action', {
      action: 'list_mcp_servers',
      org,
      server_count: servers.length,
      discover,
    });

    // If discover=true, run discovery and include status/errors in response
    if (discover && servers.length > 0) {
      const enabledServers = servers.filter((s) => s.enabled);
      const manifests = await discoverAllTools(enabledServers, logger);

      const serverStatuses = servers.map((server) => {
        const manifest = manifests.find((m) => m.serverId === server.id);
        return {
          ...server,
          discovery_status: manifest ? (manifest.error ? 'error' : 'ok') : 'skipped',
          discovery_error: manifest?.error ?? null,
          tools_count: manifest?.tools.length ?? 0,
        };
      });

      return c.json({ org, servers: serverStatuses });
    }

    return c.json({ org, servers });
  } catch (error) {
    logger.error('admin_action', error, { action: 'list_mcp_servers', org });
    return c.json({ error: 'Failed to read MCP servers from storage' }, 500);
  }
});

app.put('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());
  const servers = (await c.req.json()) as MCPServerConfig[];

  if (!Array.isArray(servers)) {
    return c.json({ error: 'Request body must be an array of server configs' }, 400);
  }

  if (servers.length > MAX_SERVERS_PER_ORG) {
    return c.json({ error: `Cannot have more than ${MAX_SERVERS_PER_ORG} servers per org` }, 400);
  }

  for (const server of servers) {
    const error = validateServerConfig(server);
    if (error) {
      return c.json({ error, server_id: server.id }, 400);
    }
  }

  try {
    await c.env.MCP_SERVERS.put(org, JSON.stringify(servers));
    logger.log('admin_action', {
      action: 'replace_mcp_servers',
      org,
      server_count: servers.length,
      server_ids: servers.map((s) => s.id),
    });
    return c.json({ org, servers, message: 'MCP servers updated' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'replace_mcp_servers', org });
    return c.json({ error: 'Failed to write MCP servers to storage' }, 500);
  }
});

app.post('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
  const logger = createRequestLogger(crypto.randomUUID());
  const body = (await c.req.json()) as Partial<MCPServerConfig>;

  // Default enabled to true if not specified
  const server: MCPServerConfig = {
    ...body,
    enabled: body.enabled ?? true,
  } as MCPServerConfig;

  const error = validateServerConfig(server);
  if (error) {
    return c.json({ error }, 400);
  }

  try {
    const existing = (await c.env.MCP_SERVERS.get<MCPServerConfig[]>(org, 'json')) ?? [];
    if (existing.length >= MAX_SERVERS_PER_ORG) {
      return c.json({ error: `Cannot have more than ${MAX_SERVERS_PER_ORG} servers per org` }, 400);
    }

    // Check for duplicate ID and update if exists
    // NOTE: This read-modify-write pattern can race with concurrent requests (last write wins).
    // This is acceptable for admin endpoints which are low-volume and authenticated.
    const existingIdx = existing.findIndex((s) => s.id === server.id);
    if (existingIdx >= 0) {
      existing.splice(existingIdx, 1, server);
    } else {
      existing.push(server);
    }

    await c.env.MCP_SERVERS.put(org, JSON.stringify(existing));
    logger.log('admin_action', {
      action: 'add_mcp_server',
      org,
      server_id: server.id,
      server_url: server.url,
      server_count: existing.length,
    });
    return c.json({ org, servers: existing, message: 'MCP server added' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'add_mcp_server', org });
    return c.json({ error: 'Failed to update MCP servers in storage' }, 500);
  }
});

app.delete('/api/v1/admin/orgs/:org/mcp-servers/:serverId', async (c) => {
  const org = c.req.param('org');
  const serverId = c.req.param('serverId');
  const logger = createRequestLogger(crypto.randomUUID());

  const idError = validateServerId(serverId);
  if (idError) {
    return c.json({ error: idError }, 400);
  }

  try {
    const existing = (await c.env.MCP_SERVERS.get<MCPServerConfig[]>(org, 'json')) ?? [];
    const filtered = existing.filter((s) => s.id !== serverId);

    await c.env.MCP_SERVERS.put(org, JSON.stringify(filtered));
    logger.log('admin_action', {
      action: 'remove_mcp_server',
      org,
      server_id: serverId,
      server_count: filtered.length,
    });
    return c.json({ org, servers: filtered, message: 'MCP server removed' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'remove_mcp_server', org });
    return c.json({ error: 'Failed to update MCP servers in storage' }, 500);
  }
});

// Admin endpoints for org config management
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

  const body = await c.req.json();
  const languageInput = { ...body, name: languageName };
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

export default app;

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
function toMarkdownView(mode: PromptMode): {
  name: string;
  aliases?: string[];
  label?: string;
  description?: string;
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
      published: incoming.published ?? existing.published,
      requires_group: incoming.requires_group ?? existing.requires_group,
    }),
    ...mergeContentFields(existing, incoming),
  };
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

  // New mode: sanitize document field if present.
  const newMode: PromptMode =
    modeInput.document !== undefined
      ? { ...modeInput, document: stripControlChars(modeInput.document) }
      : modeInput;

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
    readOrgKV<MCPServerConfig[]>(env.MCP_SERVERS, org, [], 'mcp_kv_read_error', logger),
    readOrgKV<OrgConfig>(env.ORG_CONFIG, org, {}, 'org_config_kv_read_error', logger),
    readOrgKV<PromptOverrides>(
      env.PROMPT_OVERRIDES,
      org,
      {},
      'prompt_overrides_kv_read_error',
      logger
    ),
    readOrgKV<OrgModes>(
      env.PROMPT_OVERRIDES,
      `${org}:modes`,
      { modes: [] },
      'org_modes_kv_read_error',
      logger
    ),
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
    }),
  });

  return { stub, doRequest };
}

async function handleChatRequest(
  request: Request,
  env: Env,
  transport: ChatTransport
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId);
  const timing = createTimingContext();

  try {
    const body = (await request.clone().json()) as ChatRequest;
    const validationError = validateChatBody(body, transport);
    if (validationError) {
      logger.warn('chat_validation_failed', {
        transport,
        error: validationError,
        user_id: body.user_id,
        client_id: body.client_id,
      });
      return Response.json({ error: validationError }, { status: 400 });
    }

    const org = resolveOrgFromBody(body, env.DEFAULT_ORG);
    // prettier-ignore
    logger.log('request_received', { user_id: body.user_id, client_id: body.client_id, org, transport, chat_type: body.chat_type ?? 'private', chat_id: body.chat_id, thread_id: body.thread_id });

    const { stub, doRequest } = await timePhase(timing, 'kv_and_routing', () =>
      buildDOChatRequest(request, env, { body, org, transport, logger, requestId })
    );
    const response = await timePhase(timing, 'do_fetch', () => stub.fetch(doRequest));

    logger.log('request_timing_summary', {
      user_id: body.user_id,
      org,
      transport,
      total_ms: Date.now() - timing.start,
      phases: timing.phases,
    });

    return response;
  } catch (error) {
    logger.error('request_error', error, {
      transport,
      total_ms: Date.now() - timing.start,
      phases: timing.phases,
    });
    if (error instanceof SyntaxError)
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    if (error instanceof ValidationError)
      return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
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
