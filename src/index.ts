/**
 * bt-servant-worker entry point
 *
 * Routes requests to Durable Objects for per-user serialization
 */

import { Hono } from 'hono';
import { Env } from './config/types.js';
import { UserSession } from './durable-objects/index.js';
import { ChatRequest } from './types/engine.js';
import { constantTimeCompare } from './utils/crypto.js';
import { createRequestLogger } from './utils/logger.js';

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

// User endpoints with path params
app.get('/api/v1/users/:userId/preferences', async (c) => {
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, userId, '/preferences');
});

app.put('/api/v1/users/:userId/preferences', async (c) => {
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, userId, '/preferences');
});

app.get('/api/v1/users/:userId/history', async (c) => {
  const userId = c.req.param('userId');
  return handleUserRequest(c.req.raw, c.env, userId, '/history');
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

// Admin endpoints for MCP server management (org-scoped)
app.get('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
  return handleOrgRequest(c.req.raw, c.env, org, '/mcp-servers');
});

app.put('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
  return handleOrgRequest(c.req.raw, c.env, org, '/mcp-servers');
});

app.post('/api/v1/admin/orgs/:org/mcp-servers', async (c) => {
  const org = c.req.param('org');
  return handleOrgRequest(c.req.raw, c.env, org, '/mcp-servers');
});

app.delete('/api/v1/admin/orgs/:org/mcp-servers/:serverId', async (c) => {
  const org = c.req.param('org');
  const serverId = c.req.param('serverId');
  return handleOrgRequest(c.req.raw, c.env, org, `/mcp-servers/${serverId}`);
});

export default app;

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

    const doId = env.USER_SESSION.idFromName(`org:${org}`);
    const stub = env.USER_SESSION.get(doId);

    logger.log('do_routed', { do_id: doId.toString() });

    const doUrl = new URL(request.url);
    doUrl.pathname = doPath;

    const doRequest = new Request(doUrl.toString(), {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(body),
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

async function handleUserRequest(
  request: Request,
  env: Env,
  userId: string,
  doPath: string
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId, userId);

  if (!userId) {
    return Response.json({ error: 'user_id is required in path' }, { status: 400 });
  }

  logger.log('user_request_received', { user_id: userId, path: doPath, method: request.method });

  const doId = env.USER_SESSION.idFromName(userId);
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

/**
 * Handle org-scoped admin requests (MCP server management)
 *
 * Routes to a DO instance using `org:${org}` as the ID.
 * This ensures all users in the same org share the same MCP server config.
 */
async function handleOrgRequest(
  request: Request,
  env: Env,
  org: string,
  doPath: string
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId);

  if (!org) {
    return Response.json({ error: 'org is required in path' }, { status: 400 });
  }

  logger.log('admin_request_received', { org, path: doPath, method: request.method });

  // Use org-prefixed ID so all users in an org share config
  const doId = env.USER_SESSION.idFromName(`org:${org}`);
  const stub = env.USER_SESSION.get(doId);

  const doUrl = new URL(request.url);
  doUrl.pathname = doPath;
  doUrl.searchParams.set('org', org);

  const doRequest = new Request(doUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' && request.method !== 'DELETE' ? request.body : null,
  });

  return stub.fetch(doRequest);
}
