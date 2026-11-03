/**
 * PARTNER_KEY_TAG_SECRET unset (admin-portal#354): a misconfiguration, not an
 * outage. A partner-shaped token then gets the ordinary 403 "Invalid API key"
 * (no key can be verified, so none is valid), and the misconfiguration is
 * logged as an error once per isolate — not a 503 on every request.
 *
 * Calls the worker's fetch handler directly with the secret removed from the
 * env; ENGINE_API_KEY callers are unaffected.
 */

import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';

const CHAT = 'https://worker/api/v1/chat';
const TOKEN = `bts_0000abcd_${'A'.repeat(43)}_${'A'.repeat(11)}`;

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> };

async function call(headers: Record<string, string>): Promise<Response> {
  const noSecret = { ...env, PARTNER_KEY_TAG_SECRET: undefined };
  const ctx = createExecutionContext();
  const req = new Request(CHAT, { method: 'POST', headers, body: '{}' });
  const res = await (worker as unknown as Handler).fetch(req, noSecret, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => vi.restoreAllMocks());

describe('PARTNER_KEY_TAG_SECRET unset', () => {
  it('answers 403 Invalid API key and logs the misconfiguration once per isolate', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => errors.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    for (let i = 0; i < 3; i++) {
      const res = await call({ Authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Invalid API key' });
    }
    const logged = errors.filter((line) => line.includes('partner_key_tag_secret_missing'));
    expect(logged).toHaveLength(1);
  });

  it('leaves ENGINE_API_KEY callers alone', async () => {
    const res = await call({ Authorization: 'Bearer test-api-key' });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
  });
});
