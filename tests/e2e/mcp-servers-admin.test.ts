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
