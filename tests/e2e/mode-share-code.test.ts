/**
 * Route-level tests for GET /api/v1/admin/orgs/:org/modes/:modeName/share-code
 * (admin-portal#345). Resolution logic is covered against a fake KV in
 * tests/unit/mode-share-code.test.ts; here the route's contract: auth, 400s,
 * the distinguishable 404 body, and the 200 shape with worker_version.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/types';
import { APP_VERSION } from '../../src/generated/version.js';
import worker from '../../src/index';

const ENGINE = 'test-api-key'; // vitest.config.ts binding
const ADMIN = 'u345-admin-key';
/** The production posture (#485): the admin key exists and is enforced. */
const ENFORCED: Partial<Env> = { ADMIN_API_KEY: ADMIN, ADMIN_KEY_REQUIRED: 'true' };
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

/** Call the worker's default export with an overridden env (the same app and middleware as SELF). */
async function fetchWith(overrides: Partial<Env>, target: string, key?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const handler = worker as unknown as {
    fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  };
  const init = key === undefined ? {} : { headers: bearer(key) };
  const res = await handler.fetch(new Request(target, init), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** The share-code route as the portal BFF calls it: with ADMIN_API_KEY, the admin key enforced. */
const adminFetch = (target: string) => fetchWith(ENFORCED, target, ADMIN);
const HOME = 'u345-home';
const PARTNER = 'U345 Partner';
const SEEDED = [`${HOME}:modes`, `${PARTNER}:modes`];

const url = (org: string, mode: string, homeOrg?: string) =>
  `https://worker/api/v1/admin/orgs/${encodeURIComponent(org)}/modes/${mode}/share-code` +
  (homeOrg === undefined ? '' : `?home_org=${encodeURIComponent(homeOrg)}`);

async function seed(): Promise<void> {
  await env.PROMPT_OVERRIDES.put(
    `${HOME}:modes`,
    JSON.stringify({ modes: [{ name: 'u345-coach', published: true, overrides: {} }] })
  );
  await env.PROMPT_OVERRIDES.put(
    `${PARTNER}:modes`,
    JSON.stringify({
      modes: [
        { name: 'u345-coach', published: true, overrides: {} },
        { name: 'u345-draft', overrides: {} },
      ],
    })
  );
}

afterEach(async () => {
  await Promise.all(SEEDED.map((k) => env.PROMPT_OVERRIDES.delete(k)));
});

describe('GET …/modes/:modeName/share-code', () => {
  it('requires the admin bearer token', async () => {
    const res = await fetchWith(ENFORCED, url(HOME, 'u345-coach', HOME));
    expect(res.status).toBe(401);
  });

  it('a home mode returns its bare code, resolves, and the worker version', async () => {
    await seed();
    const res = await adminFetch(url(HOME, 'u345-coach', HOME));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: 'u345-coach',
      resolves: true,
      resolved_org: HOME,
      home_has_modes: true,
      worker_version: APP_VERSION,
    });
  });

  it('a foreign mode returns the qualified code the chat path matches', async () => {
    await seed();
    const res = await adminFetch(url(PARTNER, 'u345-coach', HOME));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: 'u345-partner/u345-coach',
      resolves: true,
      resolved_org: PARTNER,
      home_has_modes: true,
      worker_version: APP_VERSION,
    });
  });

  it('a foreign draft returns its would-be code with resolves=false', async () => {
    await seed();
    const res = await adminFetch(url(PARTNER, 'u345-draft', HOME));
    expect(await res.json()).toEqual({
      code: 'u345-partner/u345-draft',
      resolves: false,
      reason: 'draft',
      home_has_modes: true,
      worker_version: APP_VERSION,
    });
  });
});

describe('GET …/modes/:modeName/share-code — errors', () => {
  it('an unknown mode or org is a 404 whose JSON body says mode_not_found', async () => {
    await seed();
    for (const target of [url(HOME, 'u345-nope', HOME), url('u345-no-org', 'x', HOME)]) {
      const res = await adminFetch(target);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'mode_not_found' });
    }
  });

  it('a route this worker does not have is a 404 without that body', async () => {
    const res = await adminFetch(
      `https://worker/api/v1/admin/orgs/${HOME}/modes/u345-coach/share-codez`
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('mode_not_found');
  });

  it('a home_org with no modes record is an empty home: 200 with home_has_modes false', async () => {
    await seed();
    const res = await adminFetch(url(PARTNER, 'u345-coach', 'u345-typo'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      code: 'u345-partner/u345-coach',
      resolves: true,
      home_has_modes: false,
    });
  });
});

describe('GET …/modes/:modeName/share-code — auth and home org', () => {
  it('an org or home_org too long for a KV key is a 400 invalid_org, not a 503', async () => {
    const long = 'a'.repeat(600);
    const cases = [
      { target: url(long, 'u345-coach', HOME), field: 'org' },
      { target: url(HOME, 'u345-coach', long), field: 'home_org' },
    ];
    for (const { target, field } of cases) {
      const res = await adminFetch(target);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_org', field });
    }
  });
});

describe('GET …/modes/:modeName/share-code — admin key gate (#479, #485)', () => {
  it('ENGINE_API_KEY gets 403 admin_key_required when ADMIN_KEY_REQUIRED=true', async () => {
    await seed();
    const res = await fetchWith(ENFORCED, url(HOME, 'u345-coach', HOME), ENGINE);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'admin_key_required' });
  });

  it('ENGINE_API_KEY still works while the admin key is not enforced (transition)', async () => {
    await seed();
    const res = await fetchWith({ ADMIN_API_KEY: ADMIN }, url(HOME, 'u345-coach', HOME), ENGINE);
    expect(res.status).toBe(200);
  });

  it('an org-scoped admin key cannot reach the route (super admin only)', async () => {
    await seed();
    await env.ORG_ADMIN_KEYS.put(PARTNER, 'u345-org-key');
    try {
      const res = await fetchWith(ENFORCED, url(PARTNER, 'u345-coach', HOME), 'u345-org-key');
      expect(res.status).toBe(403);
    } finally {
      await env.ORG_ADMIN_KEYS.delete(PARTNER);
    }
  });

  it('a record with null elements answers instead of a 500', async () => {
    await env.PROMPT_OVERRIDES.put(
      `${HOME}:modes`,
      JSON.stringify({ modes: [null, { name: 'u345-coach', published: true, overrides: {} }] })
    );
    const res = await adminFetch(url(HOME, 'u345-coach', HOME));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: 'u345-coach', resolves: true });
  });

  it('home_org is required', async () => {
    await seed();
    const res = await adminFetch(url(HOME, 'u345-coach'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'home_org_required', field: 'home_org' });
  });

  it('an invalid mode name is a 400', async () => {
    const res = await adminFetch(url(HOME, 'Bad_Name', HOME));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_mode_name' });
  });
});
