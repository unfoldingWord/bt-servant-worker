/**
 * E2E smoke tests for the new chat transport paths on UserDO.
 *
 * Confirms that the DO's fetch handler dispatches /chat/stream and
 * /chat/callback into handleUnifiedChat (not the fallback Hono router).
 * Posting invalid JSON to each path should return 400 "Invalid JSON body",
 * which proves the path matched the chat handler — a routing miss would
 * hit the Hono fallback and return 404 instead.
 *
 * Skipped on Windows (SQLite/workerd incompatibility). Runs in CI on Linux.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('UserDO chat transport path dispatch', () => {
  it('routes POST /chat/stream to the unified chat handler', async () => {
    const id = env.USER_DO.newUniqueId();
    const stub = env.USER_DO.get(id);
    const response = await stub.fetch('http://fake-host/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe('Invalid JSON body');
  });

  it('routes POST /chat/callback to the unified chat handler', async () => {
    const id = env.USER_DO.newUniqueId();
    const stub = env.USER_DO.get(id);
    const response = await stub.fetch('http://fake-host/chat/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe('Invalid JSON body');
  });

  it('still routes POST /chat to the unified chat handler (legacy)', async () => {
    const id = env.USER_DO.newUniqueId();
    const stub = env.USER_DO.get(id);
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe('Invalid JSON body');
  });
});
