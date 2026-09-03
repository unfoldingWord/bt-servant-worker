/**
 * E2E tests for DO identity persistence and the hex-addressed admin snapshot
 * endpoint.
 *
 * The snapshot endpoint exists to make the DO population retroactively
 * enumerable: the Cloudflare REST API lists namespace objects as one-way
 * 64-hex ids, and `idFromString()` is the only path into a DO whose
 * `user:{org}:{user_id}` name is unknown. The DO persists its own identity on
 * each chat turn so a snapshot can attribute hex ids to users going forward.
 *
 * Skipped on Windows (SQLite/workerd incompatibility). Runs in CI on Linux.
 */

/* eslint-disable max-lines-per-function -- established pattern for e2e suites (see user-session.test.ts) */
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StoredIdentity, ChatHistoryResponse } from '../../src/types/engine';

const AUTH = { Authorization: 'Bearer test-api-key' };
const ANTHROPIC_MARKER_HOST = 'api.anthropic.com';

/**
 * Keep the chat turns in this suite off the network.
 *
 * The orchestrator calls `globalThis.fetch` directly rather than going through
 * the Anthropic SDK (the SDK's own fetch trips Cloudflare error 1003 inside a
 * Durable Object), and `vitest.config.ts` injects a real `ANTHROPIC_API_KEY`
 * whenever one is present in `.dev.vars`. Without this stub, every local
 * `pnpm test` — including the husky pre-commit hook, which runs the full suite
 * on each commit — would make billed API calls.
 *
 * The response shape only has to be well-formed enough to reach
 * `extractTextResponses`; the turn's outcome is irrelevant here, because
 * identity persistence happens before orchestration (see the comment on the
 * chat turn below). Non-Anthropic requests fall through to the real fetch so
 * `SELF.fetch` and DO stub calls are unaffected.
 */
function stubAnthropicFetch(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes(ANTHROPIC_MARKER_HOST)) return realFetch(input, init);
    return new Response(
      JSON.stringify({
        id: 'msg_identity_stub',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-test',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: 'text', text: 'ok' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
}

interface SnapshotResponse {
  do_id: string;
  identity: StoredIdentity | null;
  history: ChatHistoryResponse;
}

describe('DO identity persistence + admin snapshot', () => {
  beforeEach(() => {
    stubAnthropicFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null identity for a fresh DO', async () => {
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    const res = await stub.fetch('http://fake-host/identity');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identity: null });
  });

  it('persists identity on a chat turn and serves it via the hex snapshot endpoint', async () => {
    const doName = 'user:test-org:identity-bob';
    const id = env.USER_DO.idFromName(doName);
    const stub = env.USER_DO.get(id);

    // Anthropic is stubbed (see stubAnthropicFetch); identity persistence
    // happens before orchestration, so the turn's outcome does not matter.
    await stub.fetch('http://fake-host/chat/final', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'vitest',
        user_id: 'identity-bob',
        org: 'test-org',
        message: 'hello',
        message_type: 'text',
      }),
    });

    const direct = await stub.fetch('http://fake-host/identity');
    expect(direct.status).toBe(200);
    const { identity } = (await direct.json()) as { identity: StoredIdentity | null };
    expect(identity).toMatchObject({
      do_name: doName,
      org: 'test-org',
      user_id: 'identity-bob',
      client_id: 'vitest',
      chat_type: 'private',
    });

    const snap = await SELF.fetch(`https://worker/api/v1/admin/do/${id.toString()}/snapshot`, {
      headers: AUTH,
    });
    expect(snap.status).toBe(200);
    const data = (await snap.json()) as SnapshotResponse;
    expect(data.do_id).toBe(id.toString());
    expect(data.identity).toMatchObject({ do_name: doName, user_id: 'identity-bob' });
    expect(Array.isArray(data.history.entries)).toBe(true);
  });

  it('persists group identity under the group DO name', async () => {
    const doName = 'group:test-org:chat-42';
    const id = env.USER_DO.idFromName(doName);
    const stub = env.USER_DO.get(id);

    await stub.fetch('http://fake-host/chat/final', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'vitest',
        user_id: 'group-sender',
        org: 'test-org',
        chat_type: 'group',
        chat_id: 'chat-42',
        message: 'hello group',
        message_type: 'text',
      }),
    });

    const res = await stub.fetch('http://fake-host/identity');
    const { identity } = (await res.json()) as { identity: StoredIdentity | null };
    expect(identity).toMatchObject({
      do_name: doName,
      org: 'test-org',
      chat_type: 'group',
      chat_id: 'chat-42',
    });
    // Group DOs are shared across senders; no single user_id is stored.
    expect(identity?.user_id).toBeUndefined();
  });

  it('rejects malformed hex ids with 400', async () => {
    const res = await SELF.fetch('https://worker/api/v1/admin/do/not-a-hex-id/snapshot', {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it('requires bearer auth', async () => {
    const res = await SELF.fetch(`https://worker/api/v1/admin/do/${'a'.repeat(64)}/snapshot`);
    expect(res.status).toBe(401);
  });
});
