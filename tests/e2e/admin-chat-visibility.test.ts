/**
 * E2E tests for how the worker decides chat admin visibility (`_is_admin`) and
 * for the ADMIN_KEY_REQUIRED value warning.
 *
 * `_is_admin` is set by the worker from client_id AND the authenticated key
 * class, after the body spread, and is the only admin signal the UserDO reads.
 * These tests swap the USER_DO binding for a capturing stub so the exact body
 * handed to the DO can be asserted without running a chat turn.
 *
 * Skipped on Windows (SQLite/workerd incompatibility). Runs in CI on Linux.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import type { Env } from '../../src/config/types';

const ENGINE = 'test-api-key'; // vitest.config.ts binding
const ADMIN = 'test-admin-key';
const CHAT = 'https://worker/api/v1/chat';
const ADMIN_CONFIG = 'https://worker/api/v1/admin/orgs/test-org-admin-chat/config';

type Handler = { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> };

async function run(overrides: Partial<Env>, req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await (worker as unknown as Handler).fetch(req, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Post a chat turn and return the JSON body the worker sent to the DO (or null). */
async function doBodyFor(
  overrides: Partial<Env>,
  key: string,
  body: Record<string, unknown>
): Promise<{ status: number; doBody: Record<string, unknown> | null }> {
  let doBody: Record<string, unknown> | null = null;
  const capturingDO = {
    idFromName: (name: string) => env.USER_DO.idFromName(name),
    // `id` is read by the telemetry DO-binding wrapper around get().
    get: (id: DurableObjectId) => ({
      id,
      fetch: async (req: Request) => {
        doBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ responses: [] });
      },
    }),
  } as unknown as DurableObjectNamespace;
  const res = await run(
    { ...overrides, USER_DO: capturingDO },
    new Request(CHAT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 'admin-chat-user',
        message: 'hi',
        message_type: 'text',
        ...body,
      }),
    })
  );
  return { status: res.status, doBody };
}

const transition = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'false' };
const enforced = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'true' };

describe('chat _is_admin is set server-side', () => {
  it('admin client_id + engine key, admin key unset: admin (as today)', async () => {
    const { doBody } = await doBodyFor({}, ENGINE, { client_id: 'admin-portal' });
    expect(doBody?._is_admin).toBe(true);
  });

  it('admin client_id + engine key during the transition: admin (as today)', async () => {
    const { doBody } = await doBodyFor(transition, ENGINE, { client_id: 'admin-portal' });
    expect(doBody?._is_admin).toBe(true);
  });

  it('admin client_id + admin key, enforced: admin', async () => {
    const { doBody } = await doBodyFor(enforced, ADMIN, { client_id: 'admin-portal' });
    expect(doBody?._is_admin).toBe(true);
  });

  it('admin client_id + engine key, enforced: 403 before the DO', async () => {
    const { status, doBody } = await doBodyFor(enforced, ENGINE, { client_id: 'admin-portal' });
    expect(status).toBe(403);
    expect(doBody).toBeNull();
  });

  it.each([
    ['engine key', ENGINE, transition],
    ['engine key, no admin key configured', ENGINE, {}],
    ['admin key', ADMIN, enforced],
  ])('a non-admin client_id is never admin (%s)', async (_label, key, cfg) => {
    const { doBody } = await doBodyFor(cfg, key, { client_id: 'web-client' });
    expect(doBody?._is_admin).toBe(false);
  });

  it('a client-supplied _is_admin is overwritten', async () => {
    const { doBody } = await doBodyFor(transition, ENGINE, {
      client_id: 'web-client',
      _is_admin: true,
    });
    expect(doBody?._is_admin).toBe(false);
  });
});

describe('ADMIN_KEY_REQUIRED value warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an invalid value fails closed (enforces) and is logged once per isolate', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const cfg = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'yes' };
    for (let i = 0; i < 3; i++) {
      const engine = await run(
        cfg,
        new Request(ADMIN_CONFIG, { headers: { Authorization: `Bearer ${ENGINE}` } })
      );
      expect(engine.status).toBe(403);
      const admin = await run(
        cfg,
        new Request(ADMIN_CONFIG, { headers: { Authorization: `Bearer ${ADMIN}` } })
      );
      expect(admin.status).toBe(200);
    }
    const logged = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.startsWith('{"event":"admin_key_required_invalid_value"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.value).toBe('yes');
  });
});

describe('ADMIN_API_KEY equal to ENGINE_API_KEY', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs admin_key_equals_engine_key once per isolate, never the key', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const cfg = { ADMIN_API_KEY: ` ${ENGINE}\n`, ADMIN_KEY_REQUIRED: 'true' };
    for (let i = 0; i < 3; i++) {
      const res = await run(
        cfg,
        new Request(ADMIN_CONFIG, { headers: { Authorization: `Bearer ${ENGINE}` } })
      );
      // The shared value classifies as the engine key, so enforcement refuses it.
      expect(res.status).toBe(403);
    }
    const lines = warnSpy.mock.calls.map((args) => String(args[0]));
    const logged = lines.filter((l) => l.startsWith('{"event":"admin_key_equals_engine_key"'));
    expect(logged).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(ENGINE);
  });
});
