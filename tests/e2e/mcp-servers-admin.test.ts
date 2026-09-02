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
 *   push never blanks the pool.
 * - `authToken` is never serialised in a response (`hasAuthToken` instead) and
 *   is merged by server id on write: omitted → preserve, null/"" → clear,
 *   string → set.
 *
 * KV is shared between suites (`isolatedStorage: false` in vitest.config.ts),
 * so every test asserts a clean pool at start and deletes both keys after.
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
const base = (org: string) => `https://worker/api/v1/admin/orgs/${org}/mcp-servers`;

const server = (id: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  id,
  name: `Server ${id}`,
  url: `https://${id}.example.com/mcp`,
  enabled: true,
  priority: 1,
  ...extra,
});

async function readKey(key: string): Promise<MCPServerConfig[] | null> {
  return env.MCP_SERVERS.get<MCPServerConfig[]>(key, 'json');
}

beforeEach(async () => {
  // Shared KV: another suite leaking a pool would make these assertions lie.
  expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();
  expect(await readKey(LEGACY_KEY)).toBeNull();
});

afterEach(async () => {
  await env.MCP_SERVERS.delete(MCP_GLOBAL_KEY);
  await env.MCP_SERVERS.delete(LEGACY_KEY);
});

describe('global pool: :org is ignored for storage', () => {
  it('returns an empty pool when neither key exists', async () => {
    const res = await SELF.fetch(base(ORG_A), { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ org: ORG_A, servers: [] });
  });

  it('writes under __global__ and serves the same list to every org', async () => {
    const post = await SELF.fetch(base(ORG_A), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(server('alpha')),
    });
    expect(post.status).toBe(200);

    expect((await readKey(MCP_GLOBAL_KEY))?.map((s) => s.id)).toEqual(['alpha']);
    expect(await readKey(ORG_A)).toBeNull();

    const fromB = await SELF.fetch(base(ORG_B), { headers: AUTH });
    const body = (await fromB.json()) as { org: string; servers: { id: string }[] };
    expect(body.org).toBe(ORG_B);
    expect(body.servers.map((s) => s.id)).toEqual(['alpha']);
  });

  it('PUT replaces the global pool and DELETE removes from it', async () => {
    const put = await SELF.fetch(base(ORG_A), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify([server('one'), server('two', { priority: 2 })]),
    });
    expect(put.status).toBe(200);
    expect((await readKey(MCP_GLOBAL_KEY))?.map((s) => s.id)).toEqual(['one', 'two']);

    const del = await SELF.fetch(`${base(ORG_B)}/one`, { method: 'DELETE', headers: AUTH });
    expect(del.status).toBe(200);
    expect((await readKey(MCP_GLOBAL_KEY))?.map((s) => s.id)).toEqual(['two']);
  });
});

describe('transitional fallback to the legacy DEFAULT_ORG key', () => {
  it('reads the legacy key while __global__ is absent', async () => {
    await env.MCP_SERVERS.put(LEGACY_KEY, JSON.stringify([server('legacy')]));

    const res = await SELF.fetch(base(ORG_A), { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { servers: { id: string }[] };
    expect(body.servers.map((s) => s.id)).toEqual(['legacy']);
    // Reads never write: the global key is still absent.
    expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();
  });

  it('prefers __global__ over the legacy key once it exists, even when empty', async () => {
    await env.MCP_SERVERS.put(LEGACY_KEY, JSON.stringify([server('legacy')]));
    await env.MCP_SERVERS.put(MCP_GLOBAL_KEY, JSON.stringify([]));

    const res = await SELF.fetch(base(ORG_A), { headers: AUTH });
    expect(await res.json()).toEqual({ org: ORG_A, servers: [] });
  });

  it('first write carries the legacy list into __global__ and leaves the legacy key alone', async () => {
    await env.MCP_SERVERS.put(LEGACY_KEY, JSON.stringify([server('legacy')]));

    const post = await SELF.fetch(base(ORG_A), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(server('new')),
    });
    expect(post.status).toBe(200);

    expect((await readKey(MCP_GLOBAL_KEY))?.map((s) => s.id)).toEqual(['legacy', 'new']);
    expect((await readKey(LEGACY_KEY))?.map((s) => s.id)).toEqual(['legacy']);
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
    const res = await SELF.fetch(url, {
      method,
      headers: body === undefined ? AUTH : JSON_HEADERS,
      body,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('reserved');
    expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();
  });
});

type PublicServer = { id: string; hasAuthToken: boolean; authToken?: unknown };

/** Fail loudly if any server in a response body carries the secret. */
function expectRedacted(servers: PublicServer[]): void {
  for (const s of servers) {
    expect(Object.keys(s)).not.toContain('authToken');
    expect(typeof s.hasAuthToken).toBe('boolean');
  }
}

describe('authToken redaction on GET response sites', () => {
  it('GET (plain and ?discover=true) never returns the token', async () => {
    // Both disabled: discovery reports them as skipped without touching the
    // network, while the discover response still spreads every stored config.
    await env.MCP_SERVERS.put(
      MCP_GLOBAL_KEY,
      JSON.stringify([
        server('with-token', { authToken: 'sekrit-1', enabled: false }),
        server('no-token', { enabled: false }),
      ])
    );

    const plain = await SELF.fetch(base(ORG_A), { headers: AUTH });
    const plainText = await plain.text();
    expect(plainText).not.toContain('sekrit-1');
    const plainBody = JSON.parse(plainText) as { servers: PublicServer[] };
    expectRedacted(plainBody.servers);
    expect(plainBody.servers.map((s) => [s.id, s.hasAuthToken])).toEqual([
      ['with-token', true],
      ['no-token', false],
    ]);

    const discover = await SELF.fetch(`${base(ORG_A)}?discover=true`, { headers: AUTH });
    const discoverText = await discover.text();
    expect(discover.status).toBe(200);
    expect(discoverText).not.toContain('sekrit-1');
    const discoverBody = JSON.parse(discoverText) as {
      servers: (PublicServer & { discovery_status: string; tools_count: number })[];
    };
    expectRedacted(discoverBody.servers);
    expect(discoverBody.servers.map((s) => [s.id, s.hasAuthToken, s.discovery_status])).toEqual([
      ['with-token', true, 'skipped'],
      ['no-token', false, 'skipped'],
    ]);
  });
});

describe('authToken redaction on POST/PUT/DELETE response sites', () => {
  it('POST response never returns the token', async () => {
    const post = await SELF.fetch(base(ORG_A), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(server('p', { authToken: 'sekrit-post' })),
    });
    const postText = await post.text();
    expect(post.status).toBe(200);
    expect(postText).not.toContain('sekrit-post');
    const postBody = JSON.parse(postText) as { servers: PublicServer[] };
    expectRedacted(postBody.servers);
    expect(postBody.servers).toEqual([expect.objectContaining({ id: 'p', hasAuthToken: true })]);
  });

  it('PUT response never returns the token', async () => {
    await env.MCP_SERVERS.put(
      MCP_GLOBAL_KEY,
      JSON.stringify([server('p', { authToken: 'sekrit-p' })])
    );

    const put = await SELF.fetch(base(ORG_A), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify([server('p'), server('q', { authToken: 'sekrit-put' })]),
    });
    const putText = await put.text();
    expect(put.status).toBe(200);
    expect(putText).not.toContain('sekrit');
    const putBody = JSON.parse(putText) as { servers: PublicServer[] };
    expectRedacted(putBody.servers);
    expect(putBody.servers.map((s) => [s.id, s.hasAuthToken])).toEqual([
      ['p', true],
      ['q', true],
    ]);
  });
});

describe('authToken redaction on the DELETE response site', () => {
  it('DELETE response never returns the token', async () => {
    await env.MCP_SERVERS.put(
      MCP_GLOBAL_KEY,
      JSON.stringify([
        server('p', { authToken: 'sekrit-p' }),
        server('q', { authToken: 'sekrit-q' }),
      ])
    );

    const del = await SELF.fetch(`${base(ORG_A)}/p`, { method: 'DELETE', headers: AUTH });
    const delText = await del.text();
    expect(del.status).toBe(200);
    expect(delText).not.toContain('sekrit');
    const delBody = JSON.parse(delText) as { servers: PublicServer[] };
    expectRedacted(delBody.servers);
    expect(delBody.servers.map((s) => [s.id, s.hasAuthToken])).toEqual([['q', true]]);
  });
});

const tokenOf = async (id: string) =>
  (await readKey(MCP_GLOBAL_KEY))?.find((s) => s.id === id)?.authToken;

describe('authToken write rule on POST: omitted → preserve, null/"" → clear, string → set', () => {
  it('POST: set, then preserve on omit, then clear on "" and on null', async () => {
    const post = (payload: unknown) =>
      SELF.fetch(base(ORG_A), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      });

    expect((await post(server('s', { authToken: 'first' }))).status).toBe(200);
    expect(await tokenOf('s')).toBe('first');

    // Redacted read → edit → write round-trip: no authToken key in the body.
    expect((await post(server('s', { priority: 5 }))).status).toBe(200);
    expect(await tokenOf('s')).toBe('first');
    expect((await readKey(MCP_GLOBAL_KEY))?.[0].priority).toBe(5);

    expect((await post({ ...server('s'), authToken: '' })).status).toBe(200);
    expect(await tokenOf('s')).toBeUndefined();
    expect(Object.keys((await readKey(MCP_GLOBAL_KEY))?.[0] ?? {})).not.toContain('authToken');

    expect((await post(server('s', { authToken: 'second' }))).status).toBe(200);
    expect(await tokenOf('s')).toBe('second');

    expect((await post({ ...server('s'), authToken: null })).status).toBe(200);
    expect(await tokenOf('s')).toBeUndefined();
  });

  it('preserves a token stored under the legacy key across the first global write', async () => {
    await env.MCP_SERVERS.put(
      LEGACY_KEY,
      JSON.stringify([server('fia', { authToken: 'fia-tok' })])
    );

    const post = await SELF.fetch(base(ORG_A), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(server('fia', { name: 'FIA renamed' })),
    });
    expect(post.status).toBe(200);
    expect(await tokenOf('fia')).toBe('fia-tok');
    expect((await readKey(MCP_GLOBAL_KEY))?.[0].name).toBe('FIA renamed');
  });
});

describe('authToken write rule on PUT, and rejected token types', () => {
  it('PUT: merges tokens by id, drops servers absent from the array', async () => {
    await env.MCP_SERVERS.put(
      MCP_GLOBAL_KEY,
      JSON.stringify([
        server('keep', { authToken: 'tok-keep' }),
        server('clear', { authToken: 'tok-clear' }),
        server('drop', { authToken: 'tok-drop' }),
      ])
    );

    const put = await SELF.fetch(base(ORG_B), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify([
        server('keep', { priority: 3 }),
        { ...server('clear'), authToken: null },
        server('new', { authToken: 'tok-new' }),
      ]),
    });
    expect(put.status).toBe(200);

    const pool = await readKey(MCP_GLOBAL_KEY);
    expect(pool?.map((s) => [s.id, s.authToken ?? null, s.priority])).toEqual([
      ['keep', 'tok-keep', 3],
      ['clear', null, 1],
      ['new', 'tok-new', 1],
    ]);
  });

  it('rejects a non-string authToken with 400 and writes nothing', async () => {
    const post = await SELF.fetch(base(ORG_A), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...server('bad'), authToken: 42 }),
    });
    expect(post.status).toBe(400);
    expect(((await post.json()) as { error: string }).error).toContain('authToken');
    expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();

    const put = await SELF.fetch(base(ORG_A), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify([{ ...server('bad'), authToken: { nested: true } }]),
    });
    expect(put.status).toBe(400);
    expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();
  });
});

describe('body validation', () => {
  it.each([
    ['PUT', '[{"id": "x"'],
    ['POST', '{"id": "x"'],
  ])('%s with malformed JSON → 400, not 500', async (method, body) => {
    const res = await SELF.fetch(base(ORG_A), { method, headers: JSON_HEADERS, body });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('valid JSON');
  });

  it('POST with a non-object body → 400', async () => {
    const res = await SELF.fetch(base(ORG_A), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify([server('x')]),
    });
    expect(res.status).toBe(400);
    expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();
  });

  it('PUT with a non-array body → 400', async () => {
    const res = await SELF.fetch(base(ORG_A), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(server('x')),
    });
    expect(res.status).toBe(400);
    expect(await readKey(MCP_GLOBAL_KEY)).toBeNull();
  });

  it('POST updating an existing id is allowed at the cap; adding a new one is not', async () => {
    const full = Array.from({ length: 50 }, (_, i) => server(`s${String(i)}`));
    await env.MCP_SERVERS.put(MCP_GLOBAL_KEY, JSON.stringify(full));

    const update = await SELF.fetch(base(ORG_A), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(server('s0', { priority: 9 })),
    });
    expect(update.status).toBe(200);

    const add = await SELF.fetch(base(ORG_A), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(server('overflow')),
    });
    expect(add.status).toBe(400);
    expect(((await add.json()) as { error: string }).error).toContain('global pool');
    expect((await readKey(MCP_GLOBAL_KEY))?.length).toBe(50);
  });
});
