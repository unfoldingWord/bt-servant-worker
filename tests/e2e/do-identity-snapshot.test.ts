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
import { describe, it, expect } from 'vitest';
import type { StoredIdentity, ChatHistoryResponse } from '../../src/types/engine';

const AUTH = { Authorization: 'Bearer test-api-key' };

interface SnapshotResponse {
  do_id: string;
  identity: StoredIdentity | null;
  history: ChatHistoryResponse;
}

describe('DO identity persistence + admin snapshot', () => {
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

    // The turn itself may fail downstream (no live engine in tests); identity
    // persistence happens before orchestration, so the outcome does not matter.
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
