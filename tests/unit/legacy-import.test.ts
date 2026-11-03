/**
 * Legacy user import (admin-portal#354): how one copy reads the destination
 * DO's answer. Only a 200 or a 409 carries an import result; any other
 * status (a storage error answers 500 with a plain error body) is a failure
 * for that user, decided from the status before the body is parsed.
 */

import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/types.js';
import { isJsonSafe } from '../../src/durable-objects/user-data-transfer.js';
import { importLegacyUsers } from '../../src/services/partner-keys/legacy-import.js';
import type { PartnerKeyRecord } from '../../src/types/partner-keys.js';
import { createMockLogger } from '../helpers/mock-logger.js';

const KEY: PartnerKeyRecord = {
  id: 'pk_0123456789abcdef',
  prefix: 'bts_01234567',
  name: 'BCS production',
  app: 'BCS app',
  org: 'bcs',
  createdBy: 'admin@example.org',
  createdAt: '2026-11-02T00:00:00.000Z',
  scopes: ['chat'],
  userNamespace: 'pk_0123456789abcdef',
};

const SOURCE = {
  identity: { client_id: 'shema', org: 'bcs', chat_type: 'private' },
  entries: [['history', []]],
};

/** A USER_DO binding: the source exports SOURCE, the destination answers `dest`. */
function envWithDestination(dest: () => Response): Env {
  const stub = (name: string) => ({
    fetch: async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? dest() : Response.json(SOURCE),
    name,
  });
  return {
    USER_DO: { idFromName: (name: string) => name, get: (name: string) => stub(name) },
  } as unknown as Env;
}

const active = async () => 'active' as const;

const run = (env: Env) =>
  importLegacyUsers(
    env,
    KEY,
    { legacyClientId: 'shema', userIds: ['u1'] },
    { logger: createMockLogger(), requestId: 'req-1', currentStatus: active }
  );

describe('importLegacyUsers reads the destination status before its body', () => {
  it('a 500 with a non-JSON body is reported as failed, not a parse error', async () => {
    const env = envWithDestination(() => new Response('storage exploded', { status: 500 }));
    expect(await run(env)).toEqual([{ userId: 'u1', status: 'failed' }]);
  });

  it('a 500 with a JSON body is still failed (never read as a result)', async () => {
    const env = envWithDestination(() => Response.json({ ok: true, imported: 9 }, { status: 500 }));
    expect(await run(env)).toEqual([{ userId: 'u1', status: 'failed' }]);
  });

  it('a 409 reports its reason; a 200 reports copied', async () => {
    const busy = envWithDestination(() =>
      Response.json({ ok: false, reason: 'destination_busy' }, { status: 409 })
    );
    expect(await run(busy)).toEqual([{ userId: 'u1', status: 'destination_busy' }]);
    const ok = envWithDestination(() => Response.json({ ok: true, imported: 1 }));
    expect(await run(ok)).toEqual([{ userId: 'u1', status: 'copied', entries: 1 }]);
  });
});

describe('importLegacyUsers re-checks the key before each batch', () => {
  it('stops at a concurrent revoke and reports key_revoked for the users not yet copied', async () => {
    const env = envWithDestination(() => Response.json({ ok: true, imported: 1 }));
    const statuses = ['active', 'revoked'] as const;
    let call = 0;
    const currentStatus = async () => statuses[Math.min(call++, 1)] ?? 'revoked';
    const userIds = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];
    const logger = createMockLogger();
    const results = await importLegacyUsers(
      env,
      KEY,
      { legacyClientId: 'shema', userIds },
      { logger, requestId: 'req-1', currentStatus }
    );
    expect(results.map((r) => r.status)).toEqual([
      'copied',
      'copied',
      'copied',
      'copied',
      'copied',
      'key_revoked',
      'key_revoked',
    ]);
    expect(logger.warn).toHaveBeenCalledWith('partner_key_legacy_import_stopped', {
      key_id: KEY.id,
      status: 'revoked',
    });
  });

  it('reports key_expired when the grace ran out mid-import', async () => {
    const env = envWithDestination(() => Response.json({ ok: true, imported: 1 }));
    const results = await importLegacyUsers(
      env,
      KEY,
      { legacyClientId: 'shema', userIds: ['u1'] },
      { logger: createMockLogger(), requestId: 'r', currentStatus: async () => 'expired' }
    );
    expect(results).toEqual([{ userId: 'u1', status: 'key_expired' }]);
  });
});

describe('isJsonSafe: what the legacy copy can carry', () => {
  it('accepts JSON data and refuses anything a JSON round-trip would change', () => {
    const ok = [null, 'a', true, 0, -1.5, [], [1, 'x'], {}, { a: { b: [null] } }];
    for (const value of ok) expect(isJsonSafe(value)).toBe(true);
    const notOk = [
      undefined,
      Number.NaN,
      Infinity,
      new Date(0),
      new Map(),
      new Set(),
      new Uint8Array(1),
      { a: undefined },
      [() => 1],
      BigInt(1),
    ];
    for (const value of notOk) expect(isJsonSafe(value)).toBe(false);
  });
});
