/**
 * The `ORG_CONFIG` namespace also holds the model-route breaker (#403) under
 * reserved `__route_health__:<route>` keys. The admin org-config routes take the
 * org id straight from the path, so without a guard an "org" named
 * `__route_health__:primary` could read, poison or clear the breaker.
 */
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTE_HEALTH_KEY_PREFIX } from '../../src/services/claude/route-health';

const AUTH = { Authorization: 'Bearer test-api-key' };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };
const RESERVED = `${ROUTE_HEALTH_KEY_PREFIX}primary`;
const url = (org: string) => `https://worker/api/v1/admin/orgs/${encodeURIComponent(org)}/config`;

afterEach(async () => {
  await env.ORG_CONFIG.delete(RESERVED);
});

describe('admin org config — reserved key prefix', () => {
  it('PUT on a reserved org id is refused and writes nothing', async () => {
    const res = await SELF.fetch(url(RESERVED), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ max_history_llm: 5 }),
    });

    expect(res.status).toBe(400);
    expect(await env.ORG_CONFIG.get(RESERVED)).toBeNull();
  });

  it('DELETE on a reserved org id is refused and leaves the breaker record alone', async () => {
    await env.ORG_CONFIG.put(RESERVED, '{"outage":"http_5xx"}');

    const res = await SELF.fetch(url(RESERVED), { method: 'DELETE', headers: AUTH });

    expect(res.status).toBe(400);
    expect(await env.ORG_CONFIG.get(RESERVED)).toBe('{"outage":"http_5xx"}');
  });

  it('GET on a reserved org id is refused rather than echoing the record as a config', async () => {
    const res = await SELF.fetch(url(RESERVED), { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it('an ordinary org id is unaffected', async () => {
    const res = await SELF.fetch(url('test-org-403'), { headers: AUTH });
    expect(res.status).toBe(200);
  });
});
