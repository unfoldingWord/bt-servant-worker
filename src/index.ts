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

    logger.log('request_received', {
      user_id: body.user_id,
      client_id: body.client_id,
      path: doPath,
    });

    const doId = env.USER_SESSION.idFromName(body.user_id);
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
