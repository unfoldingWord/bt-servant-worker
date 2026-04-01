/**
 * E2E tests for UserDO (merged Durable Object)
 *
 * These tests run in the actual Cloudflare Workers runtime (via miniflare)
 * and test the real Durable Object implementation.
 *
 * NOTE: MCP server admin endpoints have been moved to the worker (using KV).
 * Tests for those endpoints are in worker-admin.test.ts.
 */

/* eslint-disable max-lines-per-function */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

describe('UserDO Durable Object', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    const id = env.USER_DO.newUniqueId();
    stub = env.USER_DO.get(id);
  });

  describe('GET /preferences', () => {
    it('returns default preferences for new user', async () => {
      const response = await stub.fetch('http://fake-host/preferences');
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data).toEqual({
        response_language: 'en',
      });
    });
  });

  describe('PUT /preferences - valid updates', () => {
    it('updates response_language with valid ISO 639-1 code', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'es' }),
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.response_language).toBe('es');
    });

    it('persists preferences across requests', async () => {
      await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'fr' }),
      });

      const response = await stub.fetch('http://fake-host/preferences');
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.response_language).toBe('fr');
    });
  });

  describe('PUT /preferences - invalid language codes', () => {
    it('rejects language code that is too long', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'english' }),
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid response_language');
    });

    it('rejects uppercase language code', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'EN' }),
      });

      expect(response.status).toBe(400);
    });

    it('rejects language code that is too short', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'e' }),
      });

      expect(response.status).toBe(400);
    });

    it('rejects language code with numbers', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: '12' }),
      });

      expect(response.status).toBe(400);
    });

    it('rejects SQL injection attempt', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: "'; DROP TABLE users;--" }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /history', () => {
    it('returns empty history for new user', async () => {
      const response = await stub.fetch('http://fake-host/history?user_id=test-user');
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.entries).toEqual([]);
      expect(data.total_count).toBe(0);
    });

    it('respects limit parameter', async () => {
      const response = await stub.fetch('http://fake-host/history?user_id=test-user&limit=10');
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.limit).toBe(10);
    });

    it('caps limit at MAX_HISTORY_ENTRIES (50)', async () => {
      const response = await stub.fetch('http://fake-host/history?user_id=test-user&limit=100');
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.limit).toBe(50);
    });
  });

  describe('DELETE /history', () => {
    it('returns success message', async () => {
      const response = await stub.fetch('http://fake-host/history', {
        method: 'DELETE',
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.message).toBe('User history cleared');
    });
  });
});

describe('UserDO unified chat endpoint', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    const id = env.USER_DO.newUniqueId();
    stub = env.USER_DO.get(id);
  });

  it('returns SSE stream for requests without callback URL', async () => {
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'test-client',
        user_id: 'test-user',
        message: 'hello',
        message_type: 'text',
      }),
    });

    // SSE mode returns event-stream
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  });

  it('returns 202 for callback-mode requests', async () => {
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'test-client',
        user_id: 'test-user',
        message: 'hello',
        message_type: 'text',
        progress_callback_url: 'https://example.com/callback',
        message_key: 'test-key',
      }),
    });

    expect(response.status).toBe(202);
    const data = (await response.json()) as { message_id: string };
    expect(data.message_id).toBeDefined();
  });

  it('returns 400 for invalid JSON', async () => {
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });

  it('non-chat endpoints still work without lock', async () => {
    const prefsResponse = await stub.fetch('http://fake-host/preferences');
    expect(prefsResponse.status).toBe(200);

    const historyResponse = await stub.fetch('http://fake-host/history?user_id=test');
    expect(historyResponse.status).toBe(200);
  });
});

describe('UserDO user-scoped DO isolation', () => {
  it('different users have separate history', async () => {
    const aliceStub = env.USER_DO.get(env.USER_DO.idFromName('user:test-org:alice'));
    const bobStub = env.USER_DO.get(env.USER_DO.idFromName('user:test-org:bob'));

    await aliceStub.fetch('http://fake-host/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_language: 'es' }),
    });

    await bobStub.fetch('http://fake-host/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_language: 'fr' }),
    });

    const alicePrefs = await aliceStub.fetch('http://fake-host/preferences');
    const aliceData = (await alicePrefs.json()) as { response_language: string };
    expect(aliceData.response_language).toBe('es');

    const bobPrefs = await bobStub.fetch('http://fake-host/preferences');
    const bobData = (await bobPrefs.json()) as { response_language: string };
    expect(bobData.response_language).toBe('fr');
  });

  it('users in different orgs are isolated', async () => {
    const org1Stub = env.USER_DO.get(env.USER_DO.idFromName('user:org1:alice'));
    const org2Stub = env.USER_DO.get(env.USER_DO.idFromName('user:org2:alice'));

    await org1Stub.fetch('http://fake-host/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_language: 'es' }),
    });

    const org2Prefs = await org2Stub.fetch('http://fake-host/preferences');
    const org2Data = (await org2Prefs.json()) as { response_language: string };
    expect(org2Data.response_language).toBe('en');
  });
});
