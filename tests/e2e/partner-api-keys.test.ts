/**
 * E2E tests for partner API keys (admin-portal#354), through the real worker
 * (`SELF.fetch`) and the emulated API_KEYS namespace:
 *
 * - ENGINE_API_KEY behaves exactly as before (chat + admin).
 * - Admin CRUD: create returns the plaintext once; list/get never return it or
 *   the hash; revoke; rotate (old key dies, new key works, same user namespace).
 * - Hash at rest: no stored value contains the plaintext; the record lives
 *   under `key:<sha256(plaintext)>`.
 * - A partner key reaches POST /api/v1/chat, is locked to its org, has its
 *   user_id namespaced into its own DO, and is logged with its key id.
 * - Unknown/revoked keys → 403; partner keys are blocked from every admin
 *   route and every non-allowlisted route; admin-portal client_id, audio
 *   requests and progress_callback_url are refused.
 *
 * KV is shared between suites (`isolatedStorage: false`), so every test uses
 * its own org and the namespace is emptied after each test.
 *
 * Skipped on Windows (SQLite/workerd incompatibility). Runs in CI on Linux.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredIdentity } from '../../src/types/engine';
import type { PublicPartnerKey } from '../../src/types/partner-keys';
import { sha256Hex } from '../../src/utils/crypto';
import { AUDIO_TOOL_NAMES } from '../../src/services/claude/tools';
import {
  setupAnthropicFetchCapture,
  type AnthropicCapture,
  type LogRecord,
} from '../helpers/anthropic-capture.js';

// The Anthropic call is intercepted at globalThis.fetch; see anthropic-capture.ts.
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const INTERNAL = { Authorization: 'Bearer test-api-key' };
const JSON_INTERNAL = { ...INTERNAL, 'Content-Type': 'application/json' };
const KEYS = 'https://worker/api/v1/admin/api-keys';
const CHAT = 'https://worker/api/v1/chat';

type CreateBody = { key: PublicPartnerKey; apiKey: string };

const partnerHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
});

async function createKey(org: string, extra: Record<string, unknown> = {}): Promise<CreateBody> {
  const res = await SELF.fetch(KEYS, {
    method: 'POST',
    headers: JSON_INTERNAL,
    body: JSON.stringify({
      org,
      name: 'Test key',
      app: 'Test app',
      createdBy: 'tester@example.org',
      // Test orgs have no config; the unknown-org check has its own suite below.
      allow_new_org: true,
      ...extra,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateBody;
}

const chatBody = (extra: Record<string, unknown> = {}) => ({
  client_id: 'partner-app',
  user_id: 'alice',
  message: 'hello',
  message_type: 'text',
  ...extra,
});

const postChat = (apiKey: string, body: unknown, url = CHAT) =>
  SELF.fetch(url, { method: 'POST', headers: partnerHeaders(apiKey), body: JSON.stringify(body) });

async function clearNamespace(): Promise<void> {
  const { keys } = await env.API_KEYS.list();
  await Promise.all(keys.map((k) => env.API_KEYS.delete(k.name)));
}

/** First captured log record with this event name (helper keeps test callbacks shallow). */
function findLog(records: LogRecord[], event: string): LogRecord | undefined {
  return records.find((l) => l.event === event);
}

const idsOf = (keys: PublicPartnerKey[]): string[] => keys.map((k) => k.id);

async function identityOf(doName: string): Promise<StoredIdentity | null> {
  const stub = env.USER_DO.get(env.USER_DO.idFromName(doName));
  const res = await stub.fetch('http://fake-host/identity');
  return ((await res.json()) as { identity: StoredIdentity | null }).identity;
}

let capture: AnthropicCapture;

beforeEach(async () => {
  await clearNamespace();
  capture = setupAnthropicFetchCapture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearNamespace();
});

describe('ENGINE_API_KEY is unchanged', () => {
  it('still reaches chat validation and admin routes', async () => {
    const chat = await SELF.fetch(CHAT, {
      method: 'POST',
      headers: JSON_INTERNAL,
      body: JSON.stringify({ client_id: 'web', message: 'x', message_type: 'text' }),
    });
    expect(chat.status).toBe(400);
    expect(await chat.json()).toEqual({ error: 'user_id is required' });

    const list = await SELF.fetch(KEYS, { headers: INTERNAL });
    expect(list.status).toBe(200);
  });

  it('lets an internal caller use any org and admin-portal client_id', async () => {
    const res = await SELF.fetch(CHAT, {
      method: 'POST',
      headers: JSON_INTERNAL,
      body: JSON.stringify(
        chatBody({ client_id: 'admin-portal', org: 'internal-354', user_id: 'bob' })
      ),
    });
    expect(res.status).toBe(200);
    expect(await identityOf('user:internal-354:bob')).toMatchObject({ user_id: 'bob' });
    const received = findLog(capture.logs, 'request_received');
    expect(received?.payload).toMatchObject({ key_id: 'internal', org: 'internal-354' });
  });
});

describe('admin CRUD: create and list', () => {
  it('create returns the plaintext once; list and get never do', async () => {
    const { key, apiKey } = await createKey('org-354-crud', { termsVersion: 'v1' });
    expect(apiKey).toMatch(/^bts_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(apiKey.startsWith(key.prefix)).toBe(true);
    expect(key).toMatchObject({
      org: 'org-354-crud',
      status: 'active',
      scopes: ['chat'],
      termsVersion: 'v1',
      userNamespace: key.id,
    });

    const list = await SELF.fetch(`${KEYS}?org=org-354-crud`, { headers: INTERNAL });
    const listText = await list.text();
    expect(listText).not.toContain(apiKey);
    expect(listText).not.toContain(await sha256Hex(apiKey));
    const listed = JSON.parse(listText) as { keys: PublicPartnerKey[] };
    expect(idsOf(listed.keys)).toEqual([key.id]);

    const get = await SELF.fetch(`${KEYS}/${key.id}`, { headers: INTERNAL });
    const getText = await get.text();
    expect(get.status).toBe(200);
    expect(getText).not.toContain(apiKey);
    expect(getText).not.toContain(await sha256Hex(apiKey));
    expect(Object.keys(JSON.parse(getText) as object)).toEqual(['key']);
  });

  it('lists all orgs or filters by org', async () => {
    const a = await createKey('org-354-list-a');
    const b = await createKey('org-354-list-b');
    const all = (await (await SELF.fetch(KEYS, { headers: INTERNAL })).json()) as {
      keys: PublicPartnerKey[];
    };
    expect(idsOf(all.keys).sort()).toEqual([a.key.id, b.key.id].sort());
    const onlyB = (await (
      await SELF.fetch(`${KEYS}?org=org-354-list-b`, { headers: INTERNAL })
    ).json()) as { keys: PublicPartnerKey[] };
    expect(idsOf(onlyB.keys)).toEqual([b.key.id]);
  });
});

describe('admin CRUD: storage and validation', () => {
  it('stores only the SHA-256 of the key (hash at rest)', async () => {
    const { key, apiKey } = await createKey('org-354-hash');
    const { keys } = await env.API_KEYS.list();
    for (const k of keys) {
      expect(k.name).not.toContain(apiKey);
      expect((await env.API_KEYS.get(k.name)) ?? '').not.toContain(apiKey);
    }
    const hash = await sha256Hex(apiKey);
    const stored = await env.API_KEYS.get<PublicPartnerKey>(`key:${hash}`, 'json');
    expect(stored?.id).toBe(key.id);
    expect(await env.API_KEYS.get(`id:${key.id}`)).toBe(hash);
  });

  it('validates create bodies and unknown ids', async () => {
    const bad = await SELF.fetch(KEYS, {
      method: 'POST',
      headers: JSON_INTERNAL,
      body: JSON.stringify({ org: 'x', name: 'n', app: 'a', createdBy: 'c', scopes: ['admin'] }),
    });
    expect(bad.status).toBe(400);
    const missing = await SELF.fetch(`${KEYS}/pk_0000000000000000`, { headers: INTERNAL });
    expect(missing.status).toBe(404);
    const revokeMissing = await SELF.fetch(`${KEYS}/pk_0000000000000000/_revoke`, {
      method: 'POST',
      headers: INTERNAL,
    });
    expect(revokeMissing.status).toBe(404);
  });
});

describe('admin CRUD: revoke', () => {
  it('revoke makes the key fail with 403 and is idempotent', async () => {
    const { key, apiKey } = await createKey('org-354-revoke');
    expect((await postChat(apiKey, chatBody())).status).toBe(200);

    const revoke = await SELF.fetch(`${KEYS}/${key.id}/_revoke`, {
      method: 'POST',
      headers: JSON_INTERNAL,
      body: JSON.stringify({ revokedBy: 'ops@example.org' }),
    });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({
      key: { status: 'revoked', revokedBy: 'ops@example.org' },
      alreadyRevoked: false,
    });

    const denied = await postChat(apiKey, chatBody());
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Invalid API key' });
    const rejected = findLog(capture.warnLogs, 'auth_rejected');
    expect(rejected?.payload).toMatchObject({ reason: 'revoked_partner_key', key_id: key.id });

    const again = await SELF.fetch(`${KEYS}/${key.id}/_revoke`, {
      method: 'POST',
      headers: INTERNAL,
    });
    expect(await again.json()).toMatchObject({ alreadyRevoked: true });
  });
});

const rotateKey = (keyId: string, body?: unknown) =>
  SELF.fetch(`${KEYS}/${keyId}/_rotate`, {
    method: 'POST',
    headers: JSON_INTERNAL,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Move a stored key's grace end into the past, as if the window had elapsed. */
async function elapseGrace(apiKey: string): Promise<void> {
  const name = `key:${await sha256Hex(apiKey)}`;
  const record = await env.API_KEYS.get<Record<string, unknown>>(name, 'json');
  await env.API_KEYS.put(
    name,
    JSON.stringify({ ...record, expiresAt: '2026-01-01T00:00:00.000Z' })
  );
}

type RotateBody = CreateBody & { previous: PublicPartnerKey };

describe('admin CRUD: rotate with grace', () => {
  it('issues a new key with the same metadata; the old key works until its grace ends', async () => {
    const { key, apiKey } = await createKey('org-354-rotate');
    const rotate = await rotateKey(key.id);
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as RotateBody;
    expect(rotated.apiKey).not.toBe(apiKey);
    expect(rotated.key).toMatchObject({
      status: 'active',
      rotatedFrom: key.id,
      userNamespace: key.userNamespace,
      name: key.name,
      org: key.org,
    });
    // Default grace: 7 days.
    const graceMs =
      Date.parse(rotated.previous.expiresAt ?? '') - Date.parse(rotated.key.createdAt);
    expect(graceMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(rotated.previous).toMatchObject({ status: 'active', rotatedTo: rotated.key.id });

    expect((await postChat(apiKey, chatBody())).status).toBe(200);
    expect((await postChat(rotated.apiKey, chatBody())).status).toBe(200);

    await elapseGrace(apiKey);
    expect((await postChat(apiKey, chatBody())).status).toBe(403);
    expect(findLog(capture.warnLogs, 'auth_rejected')?.payload).toMatchObject({
      reason: 'expired_partner_key',
      key_id: key.id,
    });
    expect((await postChat(rotated.apiKey, chatBody())).status).toBe(200);
  });

  it('graceSeconds 0 kills the old key immediately; a rotated key cannot be rotated again', async () => {
    const { key, apiKey } = await createKey('org-354-rotate-now');
    const rotate = await rotateKey(key.id, { graceSeconds: 0 });
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as RotateBody;
    expect(rotated.previous).toMatchObject({ status: 'revoked' });
    expect((await postChat(apiKey, chatBody())).status).toBe(403);
    expect((await postChat(rotated.apiKey, chatBody())).status).toBe(200);
    expect((await rotateKey(key.id)).status).toBe(409);
    expect((await rotateKey(rotated.key.id, { graceSeconds: 31 * 24 * 3600 })).status).toBe(400);
  });
});

describe('admin CRUD: org check on create', () => {
  const post = (org: string, extra: Record<string, unknown> = {}) =>
    SELF.fetch(KEYS, {
      method: 'POST',
      headers: JSON_INTERNAL,
      body: JSON.stringify({ org, name: 'n', app: 'a', createdBy: 'c@d.org', ...extra }),
    });

  it('refuses an org with no configuration unless allow_new_org is true', async () => {
    const res = await post('org-354-typo');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'unknown_org' });
    expect((await post('org-354-typo', { allow_new_org: true })).status).toBe(201);
  });

  it('accepts a configured org and the default org', async () => {
    await env.ORG_CONFIG.put('org-354-known', JSON.stringify({}));
    await env.PROMPT_OVERRIDES.put('org-354-known-modes-only:modes', JSON.stringify({ modes: [] }));
    try {
      expect((await post('org-354-known')).status).toBe(201);
      expect((await post('org-354-known-modes-only')).status).toBe(201);
      expect((await post('unfoldingWord')).status).toBe(201);
      // A prefix match is not an org: 'org-354-kno' has no keys of its own.
      expect((await post('org-354-kno')).status).toBe(400);
    } finally {
      await env.ORG_CONFIG.delete('org-354-known');
      await env.PROMPT_OVERRIDES.delete('org-354-known-modes-only:modes');
    }
  });
});

describe('partner key on chat', () => {
  it('reaches chat, locked to its org, in its own namespaced DO, logged by key id', async () => {
    const { key, apiKey } = await createKey('org-354-chat');
    const res = await postChat(apiKey, chatBody());
    expect(res.status).toBe(200);

    const doName = `user:org-354-chat:partner:${key.userNamespace}:alice`;
    expect(await identityOf(doName)).toMatchObject({
      do_name: doName,
      org: 'org-354-chat',
      user_id: `partner:${key.userNamespace}:alice`,
    });
    // The un-namespaced DO for the same raw user_id was never touched.
    expect(await identityOf('user:org-354-chat:alice')).toBeNull();
    const received = findLog(capture.logs, 'request_received');
    expect(received?.payload).toMatchObject({ key_id: key.id, org: 'org-354-chat' });
  });

  it('rejects a mismatched org with 400', async () => {
    const { apiKey } = await createKey('org-354-orgs');
    const res = await postChat(apiKey, chatBody({ org: 'unfoldingWord' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("'org-354-orgs'");
  });
});

describe('partner key on chat: refusals', () => {
  it('refuses the admin-portal client_id', async () => {
    const { apiKey } = await createKey('org-354-admin-client');
    const res = await postChat(apiKey, chatBody({ client_id: 'admin-portal' }));
    expect(res.status).toBe(403);
  });

  it('refuses progress_callback_url without pointing partners at /chat/callback', async () => {
    const { apiKey } = await createKey('org-354-callback');
    for (const url of [CHAT, `${CHAT}/stream`]) {
      const res = await postChat(
        apiKey,
        chatBody({ progress_callback_url: 'https://evil.example/cb' }),
        url
      );
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain('progress_callback_url');
      expect(error).toContain('not available with partner API keys');
      expect(error).not.toContain('/api/v1/chat/callback');
    }
    expect(capture.calls).toHaveLength(0);
  });

  it('refuses audio input up front; ignores voice_format and null audio fields', async () => {
    const { apiKey } = await createKey('org-354-audio');
    const res = await postChat(apiKey, chatBody({ message_type: 'audio', audio_base64: 'AAAA' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('partner API keys');
    expect(capture.calls).toHaveLength(0);

    const ignored = chatBody({ voice_format: 'aac', audio_format: null, org: null });
    expect((await postChat(apiKey, ignored)).status).toBe(200);
  });
});

describe('partner key outside chat', () => {
  it('unknown keys get 403', async () => {
    const unknown = `bts_00000000_${'A'.repeat(43)}`;
    const res = await postChat(unknown, chatBody());
    expect(res.status).toBe(403);
    const rejected = findLog(capture.warnLogs, 'auth_rejected');
    expect(rejected?.payload).toMatchObject({ reason: 'unknown_partner_key' });
  });

  it.each([
    ['POST', '/api/v1/chat/callback'],
    ['GET', '/api/v1/orgs/org-354-deny/users/alice/preferences'],
    ['GET', '/api/v1/orgs/org-354-deny/users/alice/history'],
    ['GET', '/api/v1/audio/audio/x.ogg'],
    ['GET', '/api/v1/admin/api-keys'],
    ['POST', '/api/v1/admin/api-keys'],
    ['GET', '/api/v1/admin/orgs/org-354-deny/modes'],
    ['GET', `/api/v1/admin/do/${'a'.repeat(64)}/snapshot`],
  ])('is blocked from %s %s', async (method, path) => {
    const { apiKey } = await createKey('org-354-deny');
    const res = await SELF.fetch(`https://worker${path}`, {
      method,
      headers: partnerHeaders(apiKey),
      ...(method === 'POST' ? { body: JSON.stringify(chatBody()) } : {}),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'This API key is not permitted to call this endpoint',
    });
  });
});

/** Tool names in the first captured model request. */
function offeredTools(): string[] {
  const tools = (capture.calls[0]?.body.tools ?? []) as { name: string }[];
  return tools.map((t) => t.name);
}

const audioToolsIn = (names: string[]): string[] => names.filter((n) => AUDIO_TOOL_NAMES.has(n));

/** A model reply that calls one tool, then (second call) a plain text answer. */
function modelCallsToolOnce(toolName: string): void {
  let call = 0;
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('api.anthropic.com')) throw new Error(`unexpected fetch to ${url}`);
    call++;
    const content =
      call === 1
        ? [{ type: 'tool_use', id: 'toolu_audio', name: toolName, input: {} }]
        : [{ type: 'text', text: 'text only' }];
    return Response.json({
      id: `msg_${call}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-test',
      stop_reason: call === 1 ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content,
    });
  });
}

describe('partner keys are text-only (decided 2026-11-02)', () => {
  it('a partner request is not offered any audio tool or audio guidance', async () => {
    const { apiKey } = await createKey('org-354-text-only');
    expect((await postChat(apiKey, chatBody())).status).toBe(200);
    expect(offeredTools()).toContain('execute_code');
    expect(audioToolsIn(offeredTools())).toEqual([]);
    expect(capture.calls[0]?.system).not.toContain('request_audio');
  });

  it('an internal request is unchanged: audio tools and guidance present', async () => {
    const res = await SELF.fetch(CHAT, {
      method: 'POST',
      headers: JSON_INTERNAL,
      body: JSON.stringify(chatBody({ org: 'internal-354-audio', user_id: 'carol' })),
    });
    expect(res.status).toBe(200);
    expect(audioToolsIn(offeredTools()).sort()).toEqual([...AUDIO_TOOL_NAMES].sort());
    expect(capture.calls[0]?.system).toContain('request_audio');
  });

  it('refuses an audio tool the model names anyway, and returns no audio', async () => {
    const { apiKey } = await createKey('org-354-refuse-tool');
    modelCallsToolOnce('request_audio');
    const res = await postChat(apiKey, chatBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { voice_audio_url: string | null };
    expect(body.voice_audio_url).toBeNull();
    expect(findLog(capture.warnLogs, 'audio_tool_refused_text_only')?.payload).toMatchObject({
      tool: 'request_audio',
    });
  });
});
