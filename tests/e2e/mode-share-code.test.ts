/**
 * Route-level tests for GET /api/v1/admin/orgs/:org/modes/:modeName/share-code
 * (admin-portal#345). Resolution logic is covered against a fake KV in
 * tests/unit/mode-share-code.test.ts; here the route's contract: auth, 400s,
 * the distinguishable 404 body, and the 200 shape with worker_version.
 */
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/generated/version.js';

const AUTH = { Authorization: 'Bearer test-api-key' };
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
    const res = await SELF.fetch(url(HOME, 'u345-coach', HOME));
    expect(res.status).toBe(401);
  });

  it('a home mode returns its bare code, resolves, and the worker version', async () => {
    await seed();
    const res = await SELF.fetch(url(HOME, 'u345-coach', HOME), { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: 'u345-coach',
      resolves: true,
      resolved_org: HOME,
      worker_version: APP_VERSION,
    });
  });

  it('a foreign mode returns the qualified code the chat path matches', async () => {
    await seed();
    const res = await SELF.fetch(url(PARTNER, 'u345-coach', HOME), { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: 'u345-partner/u345-coach',
      resolves: true,
      resolved_org: PARTNER,
      worker_version: APP_VERSION,
    });
  });

  it('a foreign draft returns its would-be code with resolves=false', async () => {
    await seed();
    const res = await SELF.fetch(url(PARTNER, 'u345-draft', HOME), { headers: AUTH });
    expect(await res.json()).toEqual({
      code: 'u345-partner/u345-draft',
      resolves: false,
      reason: 'draft',
      worker_version: APP_VERSION,
    });
  });
});

describe('GET …/modes/:modeName/share-code — errors', () => {
  it('an unknown mode or org is a 404 whose JSON body says mode_not_found', async () => {
    await seed();
    for (const target of [url(HOME, 'u345-nope', HOME), url('u345-no-org', 'x', HOME)]) {
      const res = await SELF.fetch(target, { headers: AUTH });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'mode_not_found' });
    }
  });

  it('a route this worker does not have is a 404 without that body', async () => {
    const res = await SELF.fetch(
      `https://worker/api/v1/admin/orgs/${HOME}/modes/u345-coach/share-codez`,
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('mode_not_found');
  });

  it('a home_org with no modes record is a 400 unknown_home_org', async () => {
    await seed();
    const res = await SELF.fetch(url(PARTNER, 'u345-coach', 'u345-typo'), { headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_home_org' });
  });

  it('a record with null elements answers instead of a 500', async () => {
    await env.PROMPT_OVERRIDES.put(
      `${HOME}:modes`,
      JSON.stringify({ modes: [null, { name: 'u345-coach', published: true, overrides: {} }] })
    );
    const res = await SELF.fetch(url(HOME, 'u345-coach', HOME), { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: 'u345-coach', resolves: true });
  });

  it('home_org is required', async () => {
    await seed();
    const res = await SELF.fetch(url(HOME, 'u345-coach'), { headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'home_org_required' });
  });

  it('an invalid mode name is a 400', async () => {
    const res = await SELF.fetch(url(HOME, 'Bad_Name', HOME), { headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_mode_name' });
  });
});
