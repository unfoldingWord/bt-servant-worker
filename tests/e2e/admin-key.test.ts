/**
 * E2E tests for the dedicated admin key (ADMIN_API_KEY / ADMIN_KEY_REQUIRED).
 *
 * The test pool's bindings carry only ENGINE_API_KEY (`test-api-key`), so the
 * "admin key unset" case runs through `SELF`. The other configurations call
 * the worker's default export directly with an overridden env, which runs the
 * same Hono app and middleware chain against the same KV / DO bindings.
 *
 * Skipped on Windows (SQLite/workerd incompatibility). Runs in CI on Linux.
 */
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import type { Env } from '../../src/config/types';

const ENGINE = 'test-api-key'; // vitest.config.ts binding
const ADMIN = 'test-admin-key';
const ORG = 'test-org-admin-key';
const ADMIN_CONFIG = `https://worker/api/v1/admin/orgs/${ORG}/config`;
const USER_PREFS = `https://worker/api/v1/orgs/${ORG}/users/admin-key-user/preferences`;
const DO_SNAPSHOT = `https://worker/api/v1/admin/do/${'a'.repeat(64)}/snapshot`;
const MCP_POOL = `https://worker/api/v1/admin/orgs/${ORG}/mcp-servers`;

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

async function fetchWith(
  overrides: Partial<Env>,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const ctx = createExecutionContext();
  const handler = worker as unknown as {
    fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  };
  const res = await handler.fetch(new Request(url, init), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('empty bearer and unset secrets through the real middleware', () => {
  const noKeys = {
    ENGINE_API_KEY: undefined as unknown as string,
    ADMIN_API_KEY: undefined,
  };

  it.each([
    ['unset ENGINE_API_KEY', noKeys],
    ['empty ENGINE_API_KEY', { ENGINE_API_KEY: '', ADMIN_API_KEY: '' }],
    ['configured keys', { ADMIN_API_KEY: ADMIN }],
  ])('"Bearer " never authenticates (%s)', async (_label, cfg) => {
    for (const url of [ADMIN_CONFIG, USER_PREFS, DO_SNAPSHOT]) {
      for (const header of ['Bearer ', 'Bearer   ', 'Bearer \t']) {
        const res = await fetchWith(cfg, url, { headers: { Authorization: header } });
        // Fetch trims header values, so these arrive as a bare "Bearer" (401).
        expect(res.status).toBe(401);
      }
    }
  });

  it('with no secrets set, no token authenticates', async () => {
    for (const key of ['undefined', 'null', 'x']) {
      const res = await fetchWith(noKeys, ADMIN_CONFIG, { headers: bearer(key) });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Invalid API key', code: 'invalid_api_key' });
    }
  });
});

describe('admin key unset (behaviour unchanged)', () => {
  it('engine key reaches admin and chat/user routes', async () => {
    expect((await SELF.fetch(ADMIN_CONFIG, { headers: bearer(ENGINE) })).status).toBe(200);
    expect((await SELF.fetch(USER_PREFS, { headers: bearer(ENGINE) })).status).toBe(200);
  });

  it('flag "true" without an admin key does not lock the engine key out', async () => {
    const res = await fetchWith({ ADMIN_KEY_REQUIRED: 'true' }, ADMIN_CONFIG, {
      headers: bearer(ENGINE),
    });
    expect(res.status).toBe(200);
  });

  it('a wrong key gets the stable invalid_api_key code', async () => {
    const res = await SELF.fetch(ADMIN_CONFIG, { headers: bearer('wrong') });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Invalid API key', code: 'invalid_api_key' });
    const chat = await SELF.fetch('https://worker/api/v1/chat', {
      method: 'POST',
      headers: bearer('wrong'),
      body: '{}',
    });
    expect(await chat.json()).toEqual({ error: 'Invalid API key', code: 'invalid_api_key' });
  });

  it('missing bearer → 401, wrong key → 403 (as before)', async () => {
    expect((await SELF.fetch(ADMIN_CONFIG)).status).toBe(401);
    expect((await SELF.fetch(ADMIN_CONFIG, { headers: bearer('wrong') })).status).toBe(403);
    expect((await SELF.fetch(ADMIN_CONFIG, { headers: bearer(ADMIN) })).status).toBe(403);
  });
});

describe('blank or padded ADMIN_API_KEY', () => {
  it.each(['', '   ', '\n'])(
    'blank %j counts as unset: engine key keeps admin, flag has no effect',
    async (value) => {
      const cfg = { ADMIN_API_KEY: value, ADMIN_KEY_REQUIRED: 'true' };
      expect((await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ENGINE) })).status).toBe(200);
      // A blank token can never match a blank secret. (Fetch trims header
      // values, so "Bearer " arrives as "Bearer" and is a missing bearer.)
      expect(
        (await fetchWith(cfg, ADMIN_CONFIG, { headers: { Authorization: 'Bearer ' } })).status
      ).toBe(401);
      expect((await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(value) })).status).not.toBe(200);
    }
  );

  it('a padded secret matches the trimmed key the clients send', async () => {
    const cfg = { ADMIN_API_KEY: ` ${ADMIN}\n`, ADMIN_KEY_REQUIRED: 'true' };
    expect((await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ADMIN) })).status).toBe(200);
    expect((await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ENGINE) })).status).toBe(403);
  });
});

describe('admin key set, ADMIN_KEY_REQUIRED "false" (transition)', () => {
  const cfg = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'false' };

  it('admin key reaches admin routes and passes the global /api/* check', async () => {
    expect((await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ADMIN) })).status).toBe(200);
    expect((await fetchWith(cfg, USER_PREFS, { headers: bearer(ADMIN) })).status).toBe(200);
  });

  it('engine key still reaches admin routes', async () => {
    expect((await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ENGINE) })).status).toBe(200);
  });

  it('wrong key → 403, missing bearer → 401', async () => {
    expect((await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer('wrong') })).status).toBe(403);
    expect((await fetchWith(cfg, ADMIN_CONFIG)).status).toBe(401);
  });
});

describe('admin key set, ADMIN_KEY_REQUIRED "true" (enforced)', () => {
  const cfg = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'true' };

  it('engine key gets 403 on every admin surface', async () => {
    const attempts = [
      fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ENGINE) }),
      fetchWith(cfg, DO_SNAPSHOT, { headers: bearer(ENGINE) }),
      fetchWith(cfg, MCP_POOL, { headers: bearer(ENGINE) }),
      fetchWith(cfg, MCP_POOL, {
        method: 'PUT',
        headers: { ...bearer(ENGINE), 'Content-Type': 'application/json' },
        body: '[]',
      }),
      fetchWith(cfg, `https://worker/api/v1/admin/orgs/${ORG}/users/u1/memory`, {
        method: 'DELETE',
        headers: bearer(ENGINE),
      }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'This route requires the admin API key',
        code: 'admin_key_required',
      });
    }
  });
});

describe('admin key set, ADMIN_KEY_REQUIRED "true": chat and user routes', () => {
  const cfg = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'true' };

  it('engine key cannot use the admin chat client_id (rejected before the DO)', async () => {
    const res = await fetchWith(cfg, 'https://worker/api/v1/chat', {
      method: 'POST',
      headers: { ...bearer(ENGINE), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'admin-portal',
        user_id: 'admin-key-user',
        message: 'hello',
        message_type: 'text',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'This client_id requires the admin API key',
      code: 'admin_key_required',
    });
  });

  it('engine key still works on chat/user routes', async () => {
    expect((await fetchWith(cfg, USER_PREFS, { headers: bearer(ENGINE) })).status).toBe(200);
  });
});

describe('admin key set, ADMIN_KEY_REQUIRED "true": admin key and other keys', () => {
  const cfg = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'true' };

  it('admin key reaches admin routes', async () => {
    expect((await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ADMIN) })).status).toBe(200);
    expect((await fetchWith(cfg, MCP_POOL, { headers: bearer(ADMIN) })).status).toBe(200);
  });

  it('an org-scoped KV key still cannot pass the global /api/* check', async () => {
    await env.ORG_ADMIN_KEYS.put(ORG, 'org-scoped-key');
    try {
      const res = await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer('org-scoped-key') });
      expect(res.status).toBe(403);
    } finally {
      await env.ORG_ADMIN_KEYS.delete(ORG);
    }
  });

  it('wrong key → 403, missing bearer → 401', async () => {
    expect((await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer('wrong') })).status).toBe(403);
    expect((await fetchWith(cfg, ADMIN_CONFIG)).status).toBe(401);
  });
});

describe('admin_auth logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Parsed structured log entries whose `event` matches. */
  function entries(spy: { mock: { calls: unknown[][] } }, event: string) {
    // Only structured logger output (one JSON object per call) is inspected.
    return spy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.startsWith('{"event":'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e.event === event);
  }

  it('logs the key class (never the key) for each admin request', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const cfg = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'false' };
    await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ENGINE) });
    await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ADMIN) });

    const logged = entries(logSpy, 'admin_auth');
    expect(logged.map((e) => e.key_class)).toEqual(['engine', 'admin']);
    expect(logged.every((e) => e.enforced === false)).toBe(true);
    const raw = logSpy.mock.calls.map((a) => String(a[0])).join('\n');
    expect(raw).not.toContain(ENGINE);
    expect(raw).not.toContain(ADMIN);
  });

  it('logs the engine-key rejection under enforcement', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const cfg = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'true' };
    await fetchWith(cfg, ADMIN_CONFIG, { headers: bearer(ENGINE) });

    const rejected = entries(warnSpy, 'auth_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: 'admin_key_required', key_class: 'engine' });
  });
});
