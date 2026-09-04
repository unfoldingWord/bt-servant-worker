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
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildChatBody,
  postChatFinal,
  putPreferredLanguage,
  setupAnthropicFetchCapture,
} from '../helpers/anthropic-capture.js';
import type { UserPreferencesInternal } from '../../src/types/engine.js';

// The #408 turn-driving tests below run real chat turns through the DO; the
// harness intercepts the orchestrator at globalThis.fetch, but the SDK
// constructor must still be stubbed (hoisted per file). Inert for every other
// test in this file since the orchestrator calls globalThis.fetch directly.
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

/** GET /preferences and return the API-reported response_language (may be null). */
async function getReportedLanguage(stub: DurableObjectStub): Promise<string | null> {
  const response = await stub.fetch('http://fake-host/preferences');
  expect(response.status).toBe(200);
  const data = (await response.json()) as { response_language: string | null };
  return data.response_language;
}

/** Read the raw persisted preferences record straight from DO storage. */
function readStoredPreferences(
  stub: DurableObjectStub
): Promise<UserPreferencesInternal | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<UserPreferencesInternal>('preferences')
  );
}

/** Invoke the DO's internal getPreferences() — what reply-language logic reads. */
function readInternalPreferences(stub: DurableObjectStub): Promise<UserPreferencesInternal> {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as { getPreferences(): Promise<UserPreferencesInternal> }).getPreferences()
  );
}

/** Seed a raw preferences record directly into DO storage (migration setup). */
function seedStoredPreferences(
  stub: DurableObjectStub,
  prefs: UserPreferencesInternal
): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.put('preferences', prefs));
}

describe('UserDO Durable Object', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    const id = env.USER_DO.newUniqueId();
    stub = env.USER_DO.get(id);
  });

  describe('GET /preferences', () => {
    it('reports response_language: null for a user who has never set one', async () => {
      // Post-#408: the API reports null (never chosen) instead of leaking the
      // internal 'en' default, so clients can seed a first-visit default.
      const response = await stub.fetch('http://fake-host/preferences');
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data).toEqual({
        response_language: null,
      });
    });
  });

  // ── #408: GET /preferences must distinguish "never chose" from "chose en" ──
  describe('response_language explicit reporting (#408)', () => {
    let captured: ReturnType<typeof setupAnthropicFetchCapture>;

    beforeEach(() => {
      captured = setupAnthropicFetchCapture();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('never set: GET reports null while internal reads still default to en', async () => {
      expect(await getReportedLanguage(stub)).toBeNull();

      const internal = await readInternalPreferences(stub);
      expect(internal.response_language).toBe('en');
      expect(internal.response_language_explicit).toBeUndefined();
    });

    it('PUT { response_language: "pt" }: GET reports pt and the flag is persisted', async () => {
      await putPreferredLanguage(stub, 'pt');

      expect(await getReportedLanguage(stub)).toBe('pt');

      const stored = await readStoredPreferences(stub);
      expect(stored?.response_language).toBe('pt');
      expect(stored?.response_language_explicit).toBe(true);
    });

    it('first-interaction flip on a never-set user keeps GET reporting null', async () => {
      // A real turn (no @-trigger, no explicit language) triggers the
      // first_interaction flip, which persists the record — the storage
      // pollution path from #408. It must NOT set the explicit flag.
      const response = await postChatFinal(stub, buildChatBody({ message: 'hello there' }));
      expect(response.status).toBe(200);
      expect(captured.calls.length).toBeGreaterThan(0);

      const stored = await readStoredPreferences(stub);
      expect(stored?.first_interaction).toBe(false);
      expect(stored?.response_language_explicit).toBeUndefined();

      expect(await getReportedLanguage(stub)).toBeNull();
    });

    it('response_language_hint on a turn does not set the flag or change GET', async () => {
      const response = await postChatFinal(
        stub,
        buildChatBody({ message: 'hello there', response_language_hint: 'pt' })
      );
      expect(response.status).toBe(200);

      const stored = await readStoredPreferences(stub);
      expect(stored?.response_language_explicit).toBeUndefined();

      expect(await getReportedLanguage(stub)).toBeNull();
    });

    it('migration: a pre-existing stored language with no flag reports null', async () => {
      // Seed a record written before #408: a real response_language but no
      // explicit flag (e.g. the flip baked in the default, or a pre-#408 PUT).
      await seedStoredPreferences(stub, {
        response_language: 'pt',
        first_interaction: false,
      });

      expect(await getReportedLanguage(stub)).toBeNull();

      // Internal reads still honour the stored language — reply behavior is
      // unchanged; only the API report gates on the flag.
      const internal = await readInternalPreferences(stub);
      expect(internal.response_language).toBe('pt');
    });

    it('empty PUT (no response_language) reports null, consistent with GET', async () => {
      // A valid PUT carrying no response_language must not record an explicit
      // choice, and its response must match what GET reports — null, not the
      // internal default. Regression guard for the codex P2 where the PUT
      // echoed "en" while a subsequent GET returned null (#408).
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.response_language).toBeNull();

      const stored = await readStoredPreferences(stub);
      expect(stored?.response_language_explicit).toBeUndefined();

      expect(await getReportedLanguage(stub)).toBeNull();
    });

    it('empty PUT after an explicit choice still reports the chosen language', async () => {
      // The flag persists, so a later no-op PUT echoes the real choice and
      // stays consistent with GET.
      await putPreferredLanguage(stub, 'pt');

      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.response_language).toBe('pt');
      expect(await getReportedLanguage(stub)).toBe('pt');
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

describe('UserDO explicit chat transports', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    const id = env.USER_DO.newUniqueId();
    stub = env.USER_DO.get(id);
  });

  it('POST /chat/stream returns text/event-stream', async () => {
    const response = await stub.fetch('http://fake-host/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'test-client',
        user_id: 'test-user',
        message: 'hello',
        message_type: 'text',
      }),
    });

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  });

  it('POST /chat/callback returns 202 + message_id', async () => {
    const response = await stub.fetch('http://fake-host/chat/callback', {
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

    // org2's user never set a language, so post-#408 the API reports null —
    // crucially not org1's 'es', which is the isolation this test guards.
    const org2Prefs = await org2Stub.fetch('http://fake-host/preferences');
    const org2Data = (await org2Prefs.json()) as { response_language: string | null };
    expect(org2Data.response_language).toBeNull();
  });
});
