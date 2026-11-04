/**
 * Call the worker under the production auth configuration (worker #479/#485):
 * ADMIN_API_KEY set and ADMIN_KEY_REQUIRED="true", so only the admin key is
 * super-admin and ENGINE_API_KEY is a chat/user key. The test pool's own
 * bindings carry only ENGINE_API_KEY (see tests/e2e/admin-key.test.ts), so
 * this calls the worker's default export with the env overridden; it runs the
 * same Hono app and middleware against the same KV / DO / R2 bindings.
 */
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/index';
import type { Env } from '../../src/config/types';

export const ADMIN_TOKEN = 'test-admin-key';
export const ENGINE_TOKEN = 'test-api-key'; // vitest.config.ts binding

export const ADMIN = { Authorization: `Bearer ${ADMIN_TOKEN}` };
export const JSON_ADMIN = { ...ADMIN, 'Content-Type': 'application/json' };
export const ENGINE = { Authorization: `Bearer ${ENGINE_TOKEN}` };
export const JSON_ENGINE = { ...ENGINE, 'Content-Type': 'application/json' };

type Handler = { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> };

/** `fetch` against the worker with the production auth configuration. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const enforced: Env = { ...env, ADMIN_API_KEY: ADMIN_TOKEN, ADMIN_KEY_REQUIRED: 'true' };
  // The execution context's waitUntil work runs on its own; it is not awaited
  // here, so a streamed (SSE) body can still be read by the caller.
  return (worker as unknown as Handler).fetch(
    new Request(input, init),
    enforced,
    createExecutionContext()
  );
}
