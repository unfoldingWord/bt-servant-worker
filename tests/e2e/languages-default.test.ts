/**
 * E2E tests for the org default language admin routes (worker#356) —
 * `GET`/`PUT /api/v1/admin/orgs/:org/languages-default` and the 409 guard on
 * deleting the language currently set as default.
 *
 * The malformed-JSON cases pin the routes' body-validation contract: invalid
 * client input must produce a 400 at the route boundary, never escape to
 * Hono's default handler as a 500 (PR #357 review finding).
 *
 * Skipped on Windows (SQLite/workerd incompatibility). Runs in CI on Linux.
 */
import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const AUTH = { Authorization: 'Bearer test-api-key' };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };
const BASE = 'https://worker/api/v1/admin/orgs/test-org-356';

describe('language admin routes: malformed JSON handling', () => {
  it('returns 400, not 500, for a malformed JSON body on PUT languages-default', async () => {
    const res = await SELF.fetch(`${BASE}/languages-default`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: '{"name": "hin', // truncated payload
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('valid JSON');
  });

  it('returns 400, not 500, for a malformed JSON body on PUT languages/:languageName', async () => {
    const res = await SELF.fetch(`${BASE}/languages/hindi`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: '{"document": "# Hi', // truncated payload
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('valid JSON');
  });

  it('rejects setting a default that references no existing language', async () => {
    const res = await SELF.fetch(`${BASE}/languages-default`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'no-such-language' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not found');
  });
});

describe('languages-default lifecycle', () => {
  it('set → read → guard → clear → delete round-trip', async () => {
    const createRes = await SELF.fetch(`${BASE}/languages/hindi`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ document: '# Hindi tuning', published: true }),
    });
    expect(createRes.status).toBe(200);

    const setRes = await SELF.fetch(`${BASE}/languages-default`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'hindi' }),
    });
    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({ name: 'hindi' });

    const getRes = await SELF.fetch(`${BASE}/languages-default`, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({ org: 'test-org-356', name: 'hindi' });

    const collectionRes = await SELF.fetch(`${BASE}/languages`, { headers: AUTH });
    expect(await collectionRes.json()).toMatchObject({ defaultLanguage: 'hindi' });

    // Deleting the current default is rejected and deletes nothing.
    const guardedDelete = await SELF.fetch(`${BASE}/languages/hindi`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(guardedDelete.status).toBe(409);
    const stillThere = await SELF.fetch(`${BASE}/languages/hindi`, { headers: AUTH });
    expect(stillThere.status).toBe(200);

    const clearRes = await SELF.fetch(`${BASE}/languages-default`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: null }),
    });
    expect(clearRes.status).toBe(200);
    expect(await clearRes.json()).toMatchObject({ name: null });

    // With the default cleared, deletion goes through.
    const deleteRes = await SELF.fetch(`${BASE}/languages/hindi`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(deleteRes.status).toBe(200);
  });
});
