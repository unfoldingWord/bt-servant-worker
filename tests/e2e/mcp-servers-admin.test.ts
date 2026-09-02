/**
 * E2E tests for the MCP server admin routes after admin-portal#278 made the
 * server list a single global pool:
 *
 * - `GET/PUT/POST /api/v1/admin/orgs/:org/mcp-servers`, `DELETE …/:serverId`
 *   and `GET …/resources` all read/write the reserved `__global__` KV key; the
 *   `:org` path parameter is ignored for storage and rejected when it is the
 *   reserved key itself.
 * - Transitional fallback: while `__global__` is absent, reads fall back to the
 *   legacy `DEFAULT_ORG` (`unfoldingWord`) key so a staging redeploy on a PR
 *   push never blanks the pool, and the GET body says so (`migrated: false`).
 *   Writes require `__global__` to exist (409 otherwise): the migration runbook
 *   is the only path that creates it, so no colo can ever rebuild the pool from
 *   a stale legacy view or seal off another org's legacy key.
 * - `authToken` is never serialised in a response (`hasAuthToken` instead) and
 *   is merged by server id on write: omitted → preserve, null/"" → clear,
 *   non-empty string → set.
 *
 * KV is shared between suites (`isolatedStorage: false` in vitest.config.ts),
 * so every test asserts a clean namespace at start and deletes its keys after.
 *
 * Skipped on Windows (SQLite/workerd incompatibility). Runs in CI on Linux.
 */
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_GLOBAL_KEY } from '../../src/utils/mcp-validation';
import type { MCPServerConfig } from '../../src/types/mcp';

const AUTH = { Authorization: 'Bearer test-api-key' };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };
const ORG_A = 'test-org-278-a';
const ORG_B = 'test-org-278-b';
const LEGACY_KEY = 'unfoldingWord'; // DEFAULT_ORG in vitest.config.ts
const OTHER_ORG_KEY = 'test-org-278-other-legacy';
const base = (org: string) => `https://worker/api/v1/admin/orgs/${org}/mcp-servers`;

const server = (id: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  id,
  name: `Server ${id}`,
  url: `https://${id}.example.com/mcp`,
  enabled: true,
  priority: 1,
  ...extra,
});

type PublicServer = { id: string; hasAuthToken: boolean; authToken?: unknown };
type ListBody = {
  org: string;
  migrated: boolean;
  code?: string;
  warning?: string;
  fallback_found?: boolean;
  legacy_keys?: string[];
  legacy_listing?: string;
  stale_global_suspected?: boolean;
  servers: PublicServer[];
};

async function readKey(key: string): Promise<MCPServerConfig[] | null> {
  return env.MCP_SERVERS.get<MCPServerConfig[]>(key, 'json');
}

/** Migrated namespace: `__global__` exists (as the runbook would have created it). */
async function seedGlobal(servers: MCPServerConfig[] = []): Promise<void> {
  await env.MCP_SERVERS.put(MCP_GLOBAL_KEY, JSON.stringify(servers));
}

const tokenOf = async (id: string) =>
  (await readKey(MCP_GLOBAL_KEY))?.find((s) => s.id === id)?.authToken;

/** Fail loudly if any server in a response body carries the secret. */
function expectRedacted(servers: PublicServer[]): void {
  for (const s of servers) {
    expect(Object.keys(s)).not.toContain('authToken');
    expect(typeof s.hasAuthToken).toBe('boolean');
  }
}

const post = (org: string, payload: unknown) =>
  SELF.fetch(base(org), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) });
const put = (org: string, payload: unknown) =>
  SELF.fetch(base(org), { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(payload) });
const del = (org: string, id: string) =>
  SELF.fetch(`${base(org)}/${id}`, { method: 'DELETE', headers: AUTH });
const get = async (
  org: string,
  query = ''
): Promise<{ status: number; text: string; body: ListBody }> => {
  const res = await SELF.fetch(`${base(org)}${query}`, { headers: AUTH });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as ListBody };
};

beforeEach(async () => {
  // Shared KV: another suite leaking a pool would make these assertions lie.
  expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();
  expect(await readKey(LEGACY_KEY)).toBeNull();
  expect(await readKey(OTHER_ORG_KEY)).toBeNull();
});

afterEach(async () => {
  await env.MCP_SERVERS.delete(MCP_GLOBAL_KEY);
  await env.MCP_SERVERS.delete(LEGACY_KEY);
  await env.MCP_SERVERS.delete(OTHER_ORG_KEY);
});

describe('global pool: :org is ignored for storage', () => {
  it('writes under __global__ and serves the same list to every org', async () => {
    await seedGlobal();
    expect((await post(ORG_A, server('alpha'))).status).toBe(200);

    expect((await readKey(MCP_GLOBAL_KEY))?.map((s) => s.id)).toEqual(['alpha']);
    expect(await readKey(ORG_A)).toBeNull();

    const fromB = await get(ORG_B);
    expect(fromB.body.org).toBe(ORG_B);
    expect(fromB.body.migrated).toBe(true);
    expect(fromB.body.servers.map((s) => s.id)).toEqual(['alpha']);
  });

  it('PUT replaces the global pool and DELETE removes from it', async () => {
    await seedGlobal();
    expect((await put(ORG_A, [server('one'), server('two', { priority: 2 })])).status).toBe(200);
    expect((await readKey(MCP_GLOBAL_KEY))?.map((s) => s.id)).toEqual(['one', 'two']);

    expect((await del(ORG_B, 'one')).status).toBe(200);
    expect((await readKey(MCP_GLOBAL_KEY))?.map((s) => s.id)).toEqual(['two']);
  });

  it('PUT [] empties a migrated pool (replace-all) and the legacy key is ignored', async () => {
    await env.MCP_SERVERS.put(LEGACY_KEY, JSON.stringify([server('legacy')]));
    await seedGlobal([server('g1'), server('g2')]);

    expect((await put(ORG_A, [])).status).toBe(200);
    expect(await readKey(MCP_GLOBAL_KEY)).toEqual([]);
    expect((await readKey(LEGACY_KEY))?.map((s) => s.id)).toEqual(['legacy']);
    expect((await get(ORG_A)).body).toMatchObject({ migrated: true, servers: [] });
  });
});

describe('transitional read fallback to the legacy DEFAULT_ORG key', () => {
  it('GET on a fresh namespace returns an empty, unmigrated pool with a warning', async () => {
    const res = await get(ORG_A);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      org: ORG_A,
      servers: [],
      migrated: false,
      code: 'MCP_POOL_NOT_MIGRATED',
      fallback_found: false,
      legacy_keys: [],
      legacy_listing: 'complete',
      stale_global_suspected: false,
    });
    expect(typeof res.body.warning).toBe('string');
    expect(res.body.warning).toContain(MCP_GLOBAL_KEY);
    // The API never asserts emptiness: the operator runs the listing and
    // seeds [] only if that shows no keys.
    expect(res.body.warning).toContain('not proof that none exist');
    expect(res.body.warning).toContain('only if it shows no keys at all');
    expect(res.body.warning).not.toMatch(/^.*No legacy keys exist/);
  });
});

describe('unmigrated GET guidance', () => {
  it('GET names the legacy keys to migrate and never suggests seeding [] while they exist', async () => {
    await env.MCP_SERVERS.put(
      OTHER_ORG_KEY,
      JSON.stringify([server('theirs', { authToken: 'tok' })])
    );
    const res = await get(ORG_A);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('tok"');
    expect(res.body).toMatchObject({
      servers: [],
      migrated: false,
      fallback_found: false,
      legacy_keys: [OTHER_ORG_KEY],
      legacy_listing: 'complete',
    });
    expect(res.body.warning).toContain(OTHER_ORG_KEY);
    expect(res.body.warning).not.toMatch(/No legacy keys exist/);
    expect(res.body.warning).toContain('redacted');
  });
});

describe('resources route migration state', () => {
  it('GET …/resources carries the same migration state fields and no token', async () => {
    // Disabled so listOrgResources skips it without touching the network.
    await env.MCP_SERVERS.put(
      LEGACY_KEY,
      JSON.stringify([server('legacy', { authToken: 'tok-res', enabled: false })])
    );
    const unmigrated = await SELF.fetch(
      `https://worker/api/v1/admin/orgs/${ORG_A}/resources?language=en`,
      { headers: AUTH }
    );
    expect(unmigrated.status).toBe(200);
    const text = await unmigrated.text();
    expect(text).not.toContain('tok-res');
    const body = JSON.parse(text) as ListBody;
    expect(body).toMatchObject({
      org: ORG_A,
      migrated: false,
      code: 'MCP_POOL_NOT_MIGRATED',
      fallback_found: true,
      legacy_keys: [LEGACY_KEY],
      servers: [],
    });
    expect(body).toMatchObject({ legacy_listing: 'complete', stale_global_suspected: false });
    expect(body.warning).toContain(LEGACY_KEY);
    expect(body.warning).not.toMatch(/No legacy keys exist/);
  });
});

describe('resources route after migration', () => {
  it('GET …/resources surfaces leftover legacy keys after migration, without the token', async () => {
    await env.MCP_SERVERS.put(
      LEGACY_KEY,
      JSON.stringify([server('legacy', { authToken: 'tok-res', enabled: false })])
    );
    await seedGlobal();
    const leftover = await SELF.fetch(
      `https://worker/api/v1/admin/orgs/${ORG_A}/resources?language=en`,
      { headers: AUTH }
    );
    const leftoverText = await leftover.text();
    expect(leftoverText).not.toContain('tok-res');
    const leftoverBody = JSON.parse(leftoverText) as ListBody;
    expect(leftoverBody).toMatchObject({
      migrated: true,
      legacy_keys: [LEGACY_KEY],
      legacy_listing: 'complete',
    });
    expect(leftoverBody.warning).toContain('no longer read');
    await env.MCP_SERVERS.delete(LEGACY_KEY);
  });

  it('GET …/resources on a clean migrated pool carries legacy_listing and no warning', async () => {
    await seedGlobal();
    const migrated = await SELF.fetch(
      `https://worker/api/v1/admin/orgs/${ORG_A}/resources?language=en`,
      { headers: AUTH }
    );
    const migratedBody = (await migrated.json()) as ListBody;
    expect(migratedBody).toMatchObject({
      org: ORG_A,
      migrated: true,
      legacy_listing: 'complete',
      servers: [],
    });
    expect(migratedBody).not.toHaveProperty('warning');
  });
});

describe('transitional read fallback: legacy served', () => {
  it('reads the legacy key while __global__ is absent, redacted and flagged', async () => {
    await env.MCP_SERVERS.put(
      LEGACY_KEY,
      JSON.stringify([server('legacy', { authToken: 'sekrit-l' })])
    );

    const res = await get(ORG_A);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('sekrit-l');
    expectRedacted(res.body.servers);
    expect(res.body.migrated).toBe(false);
    expect(res.body.code).toBe('MCP_POOL_NOT_MIGRATED');
    expect(res.body.servers.map((s) => [s.id, s.hasAuthToken])).toEqual([['legacy', true]]);
    // Reads never write: the global key is still absent.
    expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();
  });
});

describe('__global__ precedence and corruption', () => {
  it('prefers __global__ over the legacy key once it exists, even when empty — and says so', async () => {
    await env.MCP_SERVERS.put(
      LEGACY_KEY,
      JSON.stringify([server('legacy', { authToken: 'tok-l' })])
    );
    await seedGlobal();

    const res = await get(ORG_A);
    expect(res.text).not.toContain('tok-l');
    expect(res.body).toMatchObject({
      org: ORG_A,
      migrated: true,
      servers: [],
      legacy_keys: [LEGACY_KEY],
    });
    expect(res.body.warning).toContain('no longer read');
    expect(res.body.warning).toContain('Do not delete');
  });

  it('a migrated pool with no leftover keys carries no warning', async () => {
    await seedGlobal([server('g')]);
    const res = await get(ORG_A);
    expect(res.body.migrated).toBe(true);
    expect(res.body.legacy_listing).toBe('complete');
    expect(res.body).not.toHaveProperty('warning');
    expect(res.body).not.toHaveProperty('legacy_keys');
  });

  it('GET returns 500, not a token or a crash, when __global__ is corrupt', async () => {
    await env.MCP_SERVERS.put(MCP_GLOBAL_KEY, JSON.stringify({ authToken: 'sekrit' }));
    const res = await get(ORG_A);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('sekrit');
  });
});

describe('writes require __global__ to exist (409 MCP_POOL_NOT_MIGRATED)', () => {
  const attempts: [string, () => Promise<Response>][] = [
    ['POST', () => post(ORG_A, server('new'))],
    ['PUT', () => put(ORG_A, [server('new')])],
    ['PUT []', () => put(ORG_A, [])],
    ['DELETE', () => del(ORG_A, 'legacy')],
  ];

  async function expectRefused(): Promise<void> {
    for (const [, attempt] of attempts) {
      const res = await attempt();
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: string; code: string };
      expect(json.code).toBe('MCP_POOL_NOT_MIGRATED');
      expect(JSON.stringify(json)).not.toContain('tok');
    }
    expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();
  }

  it('when the legacy key holds servers (409 body names the key, not the token)', async () => {
    await env.MCP_SERVERS.put(LEGACY_KEY, JSON.stringify([server('legacy', { authToken: 'tok' })]));
    await expectRefused();
    expect((await readKey(LEGACY_KEY))?.[0].authToken).toBe('tok');

    const res = await post(ORG_A, server('new'));
    const json = (await res.json()) as {
      fallback_found: boolean;
      legacy_keys: string[];
      error: string;
    };
    expect(json.fallback_found).toBe(true);
    expect(json.legacy_keys).toEqual([LEGACY_KEY]);
    expect(json.stale_global_suspected).toBe(false);
    expect(json.error).toContain(LEGACY_KEY);
    expect(json.error).not.toMatch(/No legacy keys exist/);
  });

  it('when neither key exists (fresh namespace)', async () => {
    await expectRefused();
  });

  it('when only another org key holds servers (never sealed off by a write)', async () => {
    await env.MCP_SERVERS.put(
      OTHER_ORG_KEY,
      JSON.stringify([server('theirs', { authToken: 'tok' })])
    );
    await expectRefused();
    expect((await readKey(OTHER_ORG_KEY))?.map((s) => s.id)).toEqual(['theirs']);
  });
});

describe('super-admin fence on writes', () => {
  const ORG_KEY = 'org-admin-key-278';
  afterEach(async () => {
    await env.ORG_ADMIN_KEYS.delete(ORG_A);
  });

  // NOTE: the global `/api/*` middleware rejects any non-ENGINE_API_KEY bearer
  // before these routes run, so end-to-end this 403 is produced upstream of
  // rejectMcpWrite and cannot be told apart by status alone. The route fence
  // itself is contracted by the poolWriteAuthError unit tests; this test pins
  // the observable invariant (an org key cannot change the pool) regardless
  // of which layer enforces it.
  it('an org-scoped admin key can never write the global pool', async () => {
    await env.ORG_ADMIN_KEYS.put(ORG_A, ORG_KEY);
    await seedGlobal([server('keep')]);
    const headers = { Authorization: `Bearer ${ORG_KEY}`, 'Content-Type': 'application/json' };

    const attempts = [
      SELF.fetch(base(ORG_A), { method: 'PUT', headers, body: '[]' }),
      SELF.fetch(base(ORG_A), { method: 'POST', headers, body: JSON.stringify(server('x')) }),
      SELF.fetch(`${base(ORG_A)}/keep`, { method: 'DELETE', headers }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
    }
    expect((await readKey(MCP_GLOBAL_KEY))?.map((s) => s.id)).toEqual(['keep']);
  });
});

describe('reserved key guard', () => {
  const reserved = base(MCP_GLOBAL_KEY);

  it.each([
    ['GET', reserved, undefined],
    ['PUT', reserved, JSON.stringify([server('x')])],
    ['POST', reserved, JSON.stringify(server('x'))],
    ['DELETE', `${reserved}/x`, undefined],
    ['GET', `https://worker/api/v1/admin/orgs/${MCP_GLOBAL_KEY}/resources?language=en`, undefined],
  ])('%s %s → 400', async (method, url, body) => {
    await seedGlobal();
    const res = await SELF.fetch(url, {
      method,
      headers: body === undefined ? AUTH : JSON_HEADERS,
      body,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('reserved');
    expect(await readKey(MCP_GLOBAL_KEY)).toEqual([]);
  });
});

describe('authToken redaction on GET response sites', () => {
  it('GET (plain and ?discover=true) never returns the token or unknown stored keys', async () => {
    // Both disabled: discovery reports them as skipped without touching the
    // network, while the discover response still spreads every stored config.
    // `password` simulates a pre-#278 record that persisted `{...body}` verbatim.
    await env.MCP_SERVERS.put(
      MCP_GLOBAL_KEY,
      JSON.stringify([
        { ...server('with-token', { authToken: 'sekrit-1', enabled: false }), password: 'hunter2' },
        server('no-token', { enabled: false }),
      ])
    );

    const plain = await get(ORG_A);
    expect(plain.text).not.toMatch(/sekrit-1|hunter2/);
    expectRedacted(plain.body.servers);
    expect(plain.body.servers.map((s) => [s.id, s.hasAuthToken])).toEqual([
      ['with-token', true],
      ['no-token', false],
    ]);

    const discover = await get(ORG_A, '?discover=true');
    expect(discover.status).toBe(200);
    expect(discover.text).not.toMatch(/sekrit-1|hunter2/);
    const statuses = discover.body.servers as (PublicServer & { discovery_status: string })[];
    expectRedacted(statuses);
    expect(statuses.map((s) => [s.id, s.hasAuthToken, s.discovery_status])).toEqual([
      ['with-token', true, 'skipped'],
      ['no-token', false, 'skipped'],
    ]);
  });
});

describe('authToken redaction on POST/PUT/DELETE response sites', () => {
  it('POST response never returns the token', async () => {
    await seedGlobal();
    const res = await post(ORG_A, server('p', { authToken: 'sekrit-post' }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('sekrit-post');
    const body = JSON.parse(text) as { servers: PublicServer[] };
    expectRedacted(body.servers);
    expect(body.servers).toEqual([expect.objectContaining({ id: 'p', hasAuthToken: true })]);
  });

  it('PUT response never returns the token', async () => {
    await seedGlobal([server('p', { authToken: 'sekrit-p' })]);
    const res = await put(ORG_A, [server('p'), server('q', { authToken: 'sekrit-put' })]);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('sekrit');
    const body = JSON.parse(text) as { servers: PublicServer[] };
    expectRedacted(body.servers);
    expect(body.servers.map((s) => [s.id, s.hasAuthToken])).toEqual([
      ['p', true],
      ['q', true],
    ]);
  });

  it('DELETE response never returns the token', async () => {
    await seedGlobal([
      server('p', { authToken: 'sekrit-p' }),
      server('q', { authToken: 'sekrit-q' }),
    ]);
    const res = await del(ORG_A, 'p');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('sekrit');
    const body = JSON.parse(text) as { servers: PublicServer[] };
    expectRedacted(body.servers);
    expect(body.servers.map((s) => [s.id, s.hasAuthToken])).toEqual([['q', true]]);
  });
});

describe('authToken write rule on POST: omitted → preserve, null/"" → clear, string → set', () => {
  it('sets, then preserves on omit', async () => {
    await seedGlobal();

    expect((await post(ORG_A, server('s', { authToken: 'first' }))).status).toBe(200);
    expect(await tokenOf('s')).toBe('first');

    // Redacted read → edit → write round-trip: no authToken key in the body.
    expect((await post(ORG_A, server('s', { priority: 5 }))).status).toBe(200);
    expect(await tokenOf('s')).toBe('first');
    expect((await readKey(MCP_GLOBAL_KEY))?.[0].priority).toBe(5);
  });

  it('clears on "" and on null, and sets again on a non-empty string', async () => {
    await seedGlobal([server('s', { authToken: 'first' })]);

    expect((await post(ORG_A, { ...server('s'), authToken: '' })).status).toBe(200);
    expect(await tokenOf('s')).toBeUndefined();
    expect(Object.keys((await readKey(MCP_GLOBAL_KEY))?.[0] ?? {})).not.toContain('authToken');

    expect((await post(ORG_A, server('s', { authToken: 'second' }))).status).toBe(200);
    expect(await tokenOf('s')).toBe('second');

    expect((await post(ORG_A, { ...server('s'), authToken: null })).status).toBe(200);
    expect(await tokenOf('s')).toBeUndefined();
  });

  it('GET → PUT of the public shape does not persist hasAuthToken or lose the token', async () => {
    await seedGlobal([server('rt', { authToken: 'rt-tok', transport: 'json-rpc' })]);
    const got = await get(ORG_A);
    expect(got.body.servers[0]).toHaveProperty('hasAuthToken', true);

    const res = await put(
      ORG_A,
      got.body.servers.map((s) => ({ ...s, password: 'hunter2' }))
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('hunter2');

    const pool = await readKey(MCP_GLOBAL_KEY);
    expect(pool).toEqual([server('rt', { authToken: 'rt-tok', transport: 'json-rpc' })]);
  });
});

describe('authToken write rule on PUT', () => {
  it('merges tokens by id, drops servers absent from the array', async () => {
    await seedGlobal([
      server('keep', { authToken: 'tok-keep' }),
      server('clear', { authToken: 'tok-clear' }),
      server('drop', { authToken: 'tok-drop' }),
    ]);

    const res = await put(ORG_B, [
      server('keep', { priority: 3 }),
      { ...server('clear'), authToken: null },
      server('new', { authToken: 'tok-new' }),
    ]);
    expect(res.status).toBe(200);

    const pool = await readKey(MCP_GLOBAL_KEY);
    expect(pool?.map((s) => [s.id, s.authToken ?? null, s.priority])).toEqual([
      ['keep', 'tok-keep', 3],
      ['clear', null, 1],
      ['new', 'tok-new', 1],
    ]);
  });
});

describe('rejected authToken values', () => {
  it('rejects an over-long authToken with 400', async () => {
    await seedGlobal();
    const res = await post(ORG_A, server('long', { authToken: 'x'.repeat(8193) }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('authToken');
    expect(await readKey(MCP_GLOBAL_KEY)).toEqual([]);
  });

  it('rejects a non-string authToken with 400 and writes nothing', async () => {
    await seedGlobal();
    const p = await post(ORG_A, { ...server('bad'), authToken: 42 });
    expect(p.status).toBe(400);
    expect(((await p.json()) as { error: string }).error).toContain('authToken');

    const u = await put(ORG_A, [{ ...server('bad'), authToken: { nested: true } }]);
    expect(u.status).toBe(400);
    expect(await readKey(MCP_GLOBAL_KEY)).toEqual([]);
  });
});

describe('body validation', () => {
  it.each([
    ['PUT', '[{"id": "x"'],
    ['POST', '{"id": "x"'],
  ])('%s with malformed JSON → 400, not 500', async (method, body) => {
    await seedGlobal();
    const res = await SELF.fetch(base(ORG_A), { method, headers: JSON_HEADERS, body });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('valid JSON');
  });

  it('POST with a non-object body → 400', async () => {
    await seedGlobal();
    const res = await post(ORG_A, [server('x')]);
    expect(res.status).toBe(400);
    expect(await readKey(MCP_GLOBAL_KEY)).toEqual([]);
  });

  it('PUT with more than MAX_SERVERS entries → 400', async () => {
    await seedGlobal();
    const res = await put(
      ORG_A,
      Array.from({ length: 51 }, (_, i) => server(`s${String(i)}`))
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('global pool');
    expect(await readKey(MCP_GLOBAL_KEY)).toEqual([]);
  });

  it('PUT with a non-array body → 400', async () => {
    await seedGlobal();
    const res = await put(ORG_A, server('x'));
    expect(res.status).toBe(400);
    expect(await readKey(MCP_GLOBAL_KEY)).toEqual([]);
  });
});

describe('PUT element validation', () => {
  it('null element → 400, not 500', async () => {
    await seedGlobal();
    const res = await put(ORG_A, [server('ok'), null]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('object');
    expect(await readKey(MCP_GLOBAL_KEY)).toEqual([]);
  });

  it('duplicate ids → 400', async () => {
    await seedGlobal();
    const res = await put(ORG_A, [server('dup'), server('other'), server('dup', { priority: 2 })]);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; server_ids: string[] };
    expect(json.error).toContain('Duplicate');
    expect(json.server_ids).toEqual(['dup']);
    expect(await readKey(MCP_GLOBAL_KEY)).toEqual([]);
  });
});

describe('pool cap', () => {
  it('POST updating an existing id is allowed at the cap; adding a new one is not', async () => {
    await seedGlobal(Array.from({ length: 50 }, (_, i) => server(`s${String(i)}`)));

    expect((await post(ORG_A, server('s0', { priority: 9 }))).status).toBe(200);

    const add = await post(ORG_A, server('overflow'));
    expect(add.status).toBe(400);
    expect(((await add.json()) as { error: string }).error).toContain('global pool');
    expect((await readKey(MCP_GLOBAL_KEY))?.length).toBe(50);
  });
});
