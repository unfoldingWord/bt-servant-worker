/**
 * bt-servant-worker entry point
 *
 * Routes requests to Durable Objects for per-user serialization.
 * MCP server config is stored in KV and passed to DOs via request body.
 */

import { Hono } from 'hono';
import { Env } from './config/types.js';
import { UserSession } from './durable-objects/index.js';
import { discoverAllTools } from './services/mcp/index.js';
import { MCPServerConfig } from './services/mcp/types.js';
import { ChatRequest } from './types/engine.js';
import { constantTimeCompare } from './utils/crypto.js';
import { createRequestLogger } from './utils/logger.js';
import {
  MAX_SERVERS_PER_ORG,
  validateServerConfig,
  validateServerId,
} from './utils/mcp-validation.js';

export { UserSession };

const app = new Hono<{ Bindings: Env }>();

// Health check - no auth required
app.get('/health', (c) => c.json({ status: 'healthy', version: '0.2.0' }));

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

// Chat endpoints
app.post('/api/v1/chat', async (c) => {
  return handleChatRequest(c.req.raw, c.env, '/chat');
});

app.post('/api/v1/chat/stream', async (c) => {
  return handleChatRequest(c.req.raw, c.env, '/stream');
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

  const servers = (await c.env.MCP_SERVERS.get<MCPServerConfig[]>(org, 'json')) ?? [];

  logAdminAction('list_mcp_servers', org, { server_count: servers.length, discover });

  // If discover=true, run discovery and include status/errors in response
  if (discover && servers.length > 0) {
    const enabledServers = servers.filter((s) => s.enabled);
    const logger = createRequestLogger(crypto.randomUUID());
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
});

app.put('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
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

  await c.env.MCP_SERVERS.put(org, JSON.stringify(servers));
  logAdminAction('replace_mcp_servers', org, {
    server_count: servers.length,
    server_ids: servers.map((s) => s.id),
  });
  return c.json({ org, servers, message: 'MCP servers updated' });
});

app.post('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
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

  const existing = (await c.env.MCP_SERVERS.get<MCPServerConfig[]>(org, 'json')) ?? [];
  if (existing.length >= MAX_SERVERS_PER_ORG) {
    return c.json({ error: `Cannot have more than ${MAX_SERVERS_PER_ORG} servers per org` }, 400);
  }

  // Check for duplicate ID and update if exists
  const existingIndex = existing.findIndex((s) => s.id === server.id);
  if (existingIndex >= 0) {
    // eslint-disable-next-line security/detect-object-injection -- existingIndex is from findIndex
    existing[existingIndex] = server;
  } else {
    existing.push(server);
  }

  await c.env.MCP_SERVERS.put(org, JSON.stringify(existing));
  logAdminAction('add_mcp_server', org, { server_id: server.id, server_url: server.url });
  return c.json({ org, servers: existing, message: 'MCP server added' });
});

app.delete('/api/v1/admin/orgs/:org/mcp-servers/:serverId', async (c) => {
  const org = c.req.param('org');
  const serverId = c.req.param('serverId');

  const idError = validateServerId(serverId);
  if (idError) {
    return c.json({ error: idError }, 400);
  }

  const existing = (await c.env.MCP_SERVERS.get<MCPServerConfig[]>(org, 'json')) ?? [];
  const filtered = existing.filter((s) => s.id !== serverId);

  await c.env.MCP_SERVERS.put(org, JSON.stringify(filtered));
  logAdminAction('remove_mcp_server', org, { server_id: serverId });
  return c.json({ org, servers: filtered, message: 'MCP server removed' });
});

// Migration endpoint - temporary, remove after migration
app.post('/api/v1/admin/migrate-mcp-to-kv', async (c) => {
  // Super admin only (ENGINE_API_KEY check already done by middleware)
  const org = 'unfoldingWord'; // Hardcode for safety

  // Read from org DO
  const orgDoId = c.env.USER_SESSION.idFromName(`org:${org}`);
  const orgStub = c.env.USER_SESSION.get(orgDoId);
  const response = await orgStub.fetch(new Request(`https://internal/mcp-servers?org=${org}`));
  const data = (await response.json()) as { servers: MCPServerConfig[] };

  // Write to KV
  await c.env.MCP_SERVERS.put(org, JSON.stringify(data.servers));
  logAdminAction('migrate_mcp_to_kv', org, { server_count: data.servers.length });

  return c.json({ migrated: org, server_count: data.servers.length });
});

// Cleanup endpoint - temporary, remove after cleanup
app.post('/api/v1/admin/cleanup-org-do', async (c) => {
  // Super admin only
  const org = 'unfoldingWord'; // Hardcode for safety
  const orgDoId = c.env.USER_SESSION.idFromName(`org:${org}`);
  const orgStub = c.env.USER_SESSION.get(orgDoId);

  // Call DO to delete its storage
  await orgStub.fetch(new Request('https://internal/cleanup', { method: 'POST' }));
  logAdminAction('cleanup_org_do', org);

  return c.json({ cleaned: `org:${org}` });
});

export default app;

/**
 * Log admin actions for audit trail
 */
function logAdminAction(action: string, org: string, details: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({ event: 'admin_action', timestamp: Date.now(), action, org, ...details })
  );
}

/**
 * Handle chat requests
 *
 * Routes to user-scoped DO (user:org:userId) and passes MCP config from KV.
 */
async function handleChatRequest(request: Request, env: Env, doPath: string): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId);

  try {
    const body = (await request.clone().json()) as ChatRequest;

    if (!body.user_id) {
      return Response.json({ error: 'user_id is required' }, { status: 400 });
    }
    if (!body.client_id) {
      return Response.json({ error: 'client_id is required' }, { status: 400 });
    }

    const org = body.org ?? env.DEFAULT_ORG;

    logger.log('request_received', {
      user_id: body.user_id,
      client_id: body.client_id,
      org,
      path: doPath,
    });

    // Read MCP config from KV
    const mcpServers = (await env.MCP_SERVERS.get<MCPServerConfig[]>(org, 'json')) ?? [];

    // Route to user-scoped DO (instead of org-scoped)
    const doId = env.USER_SESSION.idFromName(`user:${org}:${body.user_id}`);
    const stub = env.USER_SESSION.get(doId);

    logger.log('do_routed', { do_id: doId.toString(), mcp_server_count: mcpServers.length });

    const doUrl = new URL(request.url);
    doUrl.pathname = doPath;

    // Pass MCP config in request body
    const enrichedBody: ChatRequest = { ...body, _mcp_servers: mcpServers };

    const doRequest = new Request(doUrl.toString(), {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(enrichedBody),
    });

    return stub.fetch(doRequest);
  } catch (error) {
    logger.error('request_error', error);
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
  const doId = env.USER_SESSION.idFromName(`user:${org}:${userId}`);
  const stub = env.USER_SESSION.get(doId);

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

  return stub.fetch(doRequest);
}
