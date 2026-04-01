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
import { ChatRequest } from './types/engine.js';
import { DEFAULT_ORG_CONFIG, OrgConfig, validateOrgConfig } from './types/org-config.js';
import {
  DEFAULT_PROMPT_VALUES,
  MAX_MODES_PER_ORG,
  mergePromptOverrides,
  OrgModes,
  PromptMode,
  PromptOverrides,
  resolvePromptOverrides,
  validateModeName,
  validatePromptMode,
  validatePromptOverrides,
} from './types/prompt-overrides.js';
import { constantTimeCompare } from './utils/crypto.js';
import { getAudio } from './services/audio/index.js';
import { createRequestLogger } from './utils/logger.js';
import { createTimingContext, timePhase } from './utils/timing.js';
import {
  MAX_SERVERS_PER_ORG,
  validateServerConfig,
  validateServerId,
} from './utils/mcp-validation.js';
import { resolveOrgFromBody } from './utils/org.js';

export { UserDO };

const app = new Hono<{ Bindings: Env }>();

// Health check - no auth required
app.get('/health', (c) => c.json({ status: 'healthy', version: APP_VERSION }));

// Auth middleware for all /api routes
app.use('/api/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header with Bearer token required' }, 401);
  }

  const token = authHeader.slice(7);
  if (!constantTimeCompare(token, c.env.ENGINE_API_KEY)) {
    return c.json({ error: 'Invalid API key' }, 403);
  }

  return next();
});

// Unified chat endpoint — routes all chat to UserDO
app.post('/api/v1/chat', async (c) => {
  return handleChatRequest(c.req.raw, c.env);
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

// Admin auth middleware - validates org-specific or super admin access
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
    return c.json({ org, ...orgModes });
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
    const mode = orgModes.modes.find((m) => m.name === modeName);
    if (!mode) {
      return c.json({ error: `Mode '${modeName}' not found` }, 404);
    }

    logger.log('admin_action', { action: 'get_mode', org, mode_name: modeName });
    return c.json({ org, mode });
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
      saved_overrides: result.savedMode.overrides,
    });
    return c.json({ org, mode: result.savedMode, message: 'Mode saved' });
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
    return c.json({ org, modes: orgModes.modes, message: 'Mode deleted' });
  } catch (error) {
    logger.error('admin_action', error, { action: 'delete_mode', org });
    return c.json({ error: 'Failed to delete mode from storage' }, 500);
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

export default app;

/** Merge an incoming mode with an existing one, combining overrides and optional fields. */
function mergeExistingMode(existing: PromptMode, incoming: PromptMode): PromptMode {
  return {
    name: incoming.name,
    overrides: mergePromptOverrides(existing.overrides, incoming.overrides),
    ...((incoming.label ?? existing.label) ? { label: incoming.label ?? existing.label } : {}),
    ...((incoming.description ?? existing.description)
      ? { description: incoming.description ?? existing.description }
      : {}),
  };
}

/**
 * Upsert a mode into an OrgModes array, merging overrides with any existing mode.
 * Mutates orgModes.modes in-place (splice/push) and returns the result.
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
    logger?.log('admin_action', {
      action: 'upsert_mode_before',
      org,
      mode_name: modeInput.name,
      existing_overrides: orgModes.modes[existingIdx]!.overrides,
      incoming_overrides: modeInput.overrides,
    });
    orgModes.modes.splice(existingIdx, 1, savedMode);
    return { ok: true, savedMode };
  }

  if (orgModes.modes.length >= MAX_MODES_PER_ORG) {
    return { ok: false, error: `Cannot have more than ${MAX_MODES_PER_ORG} modes per org` };
  }
  logger?.log('admin_action', {
    action: 'upsert_mode_before',
    org,
    mode_name: modeInput.name,
    existing_overrides: null,
    incoming_overrides: modeInput.overrides,
  });
  orgModes.modes.push(modeInput);
  return { ok: true, savedMode: modeInput };
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
  ]);
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
    logger: ReturnType<typeof createRequestLogger>;
    requestId?: string;
  }
): Promise<{ stub: DurableObjectStub; doRequest: Request }> {
  const { body, org, logger } = opts;

  const [mcpServers, orgConfig, promptOverrides, orgModes] = await readAllOrgKV(env, org, logger);

  const doId = env.USER_DO.idFromName(`user:${org}:${body.user_id}`);
  const stub = env.USER_DO.get(doId);

  logger.log('do_routed', {
    do_id: doId.toString(),
    mcp_server_count: mcpServers.length,
    org_config: orgConfig,
  });

  const doUrl = new URL(request.url);
  doUrl.pathname = '/chat';

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
    }),
  });

  return { stub, doRequest };
}

/**
 * Handle chat requests
 *
 * Routes to user-scoped DO (user:org:userId) and passes MCP config from KV.
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId);
  const timing = createTimingContext();

  try {
    const body = (await request.clone().json()) as ChatRequest;

    if (!body.user_id) {
      return Response.json({ error: 'user_id is required' }, { status: 400 });
    }
    if (!body.client_id) {
      return Response.json({ error: 'client_id is required' }, { status: 400 });
    }

    const org = resolveOrgFromBody(body, env.DEFAULT_ORG);
    logger.log('request_received', {
      user_id: body.user_id,
      client_id: body.client_id,
      org,
    });

    const { stub, doRequest } = await timePhase(timing, 'kv_and_routing', () =>
      buildDOChatRequest(request, env, { body, org, logger, requestId })
    );
    const response = await timePhase(timing, 'do_fetch', () => stub.fetch(doRequest));

    logger.log('request_timing_summary', {
      user_id: body.user_id,
      org,
      total_ms: Date.now() - timing.start,
      phases: timing.phases,
    });

    return response;
  } catch (error) {
    logger.error('request_error', error, {
      total_ms: Date.now() - timing.start,
      phases: timing.phases,
    });
    if (error instanceof SyntaxError) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Handle user requests (preferences, history)
 *
 * Routes to user-scoped DO (user:org:userId).
 */
async function handleUserRequest(
  request: Request,
  env: Env,
  org: string,
  userId: string,
  doPath: string
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId, userId);
  const start = Date.now();

  if (!org) {
    return Response.json({ error: 'org is required in path' }, { status: 400 });
  }
  if (!userId) {
    return Response.json({ error: 'user_id is required in path' }, { status: 400 });
  }

  logger.log('user_request_received', {
    user_id: userId,
    org,
    path: doPath,
    method: request.method,
  });

  // Route to user-scoped DO (same ID format as chat)
  const doId = env.USER_DO.idFromName(`user:${org}:${userId}`);
  const stub = env.USER_DO.get(doId);

  // Build DO URL with query params for history
  const doUrl = new URL(request.url);
  doUrl.pathname = doPath;
  if (doPath === '/history') {
    doUrl.searchParams.set('user_id', userId);
  }

  const doRequest = new Request(doUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' ? request.body : null,
  });

  const response = await stub.fetch(doRequest);
  logger.log('user_request_complete', {
    path: doPath,
    status: response.status,
    duration_ms: Date.now() - start,
  });
  return response;
}
