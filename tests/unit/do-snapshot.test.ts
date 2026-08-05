import { describe, it, expect } from 'vitest';
import { readDoSnapshot } from '../../src/services/admin/do-snapshot.js';

const okIdentity = () =>
  new Response(JSON.stringify({ identity: { do_name: 'user:o:u1', org: 'o', user_id: 'u1' } }), {
    status: 200,
  });
const okHistory = () =>
  new Response(JSON.stringify({ user_id: 'u1', entries: [{ user_message: 'hi' }] }), {
    status: 200,
  });

describe('readDoSnapshot', () => {
  it('decodes both subrequests when they succeed', async () => {
    const result = await readDoSnapshot(okIdentity(), okHistory());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.identity).toMatchObject({ do_name: 'user:o:u1' });
    expect(result.history.entries).toHaveLength(1);
  });

  it('normalizes a missing identity to null (DO predating identity persistence)', async () => {
    const res = new Response(JSON.stringify({ identity: null }), { status: 200 });
    const result = await readDoSnapshot(res, okHistory());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.identity).toBeNull();
  });

  // The core regression this module exists to prevent: a DO storage error must
  // never be decoded into a result that looks like a successful empty snapshot.
  it('fails when the identity subrequest errors', async () => {
    const failed = new Response(JSON.stringify({ error: 'storage unavailable' }), { status: 500 });
    const result = await readDoSnapshot(failed, okHistory());
    expect(result).toEqual({ ok: false, identityStatus: 500, historyStatus: 200 });
  });

  it('fails when the history subrequest errors', async () => {
    const failed = new Response(JSON.stringify({ error: 'storage unavailable' }), { status: 500 });
    const result = await readDoSnapshot(okIdentity(), failed);
    expect(result).toEqual({ ok: false, identityStatus: 200, historyStatus: 500 });
  });

  it('fails when both subrequests error, reporting both statuses', async () => {
    const result = await readDoSnapshot(
      new Response('{}', { status: 503 }),
      new Response('{}', { status: 500 })
    );
    expect(result).toEqual({ ok: false, identityStatus: 503, historyStatus: 500 });
  });

  it('does not consume the bodies of failed responses', async () => {
    // Proves the failure path short-circuits BEFORE decoding — the caller can
    // still inspect the raw payload for diagnostics.
    const failed = new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    await readDoSnapshot(failed, okHistory());
    expect(failed.bodyUsed).toBe(false);
  });
});
