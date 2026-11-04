/**
 * Legacy user import (admin-portal#354): how one copy reads the destination
 * DO's answer. Only a well-formed 200 (imported) or 409 (an explicit
 * refusal) is definite, and a 400 is a refusal before any write. Anything
 * else (a failed request, a 5xx, an unreadable or unknown answer) is
 * `import_outcome_unknown`: the write may have landed, so audio is kept.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_RENEW_EVERY,
  rehomeHistoryAudio,
} from '../../src/services/partner-keys/legacy-audio.js';
import { partnerAudioKeyFor } from '../../src/services/audio/r2-storage.js';
import type { Env } from '../../src/config/types.js';
import { readImportEntries, toJsonSafe } from '../../src/durable-objects/user-data-transfer.js';
import {
  importLegacyUsers,
  LEGACY_IMPORT_OPERATION_BUDGET,
} from '../../src/services/partner-keys/legacy-import.js';
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

const NO_AUDIO = { copied: 0, existing: 0, missing: 0 };
const unknownOutcome = [{ userId: 'u1', status: 'import_outcome_unknown', audio: NO_AUDIO }];

describe('importLegacyUsers: only a definite answer is definite', () => {
  it('a 500 (JSON or not) is an unknown outcome, never read as a result', async () => {
    const text = envWithDestination(() => new Response('storage exploded', { status: 500 }));
    expect(await run(text)).toEqual(unknownOutcome);
    const json = envWithDestination(() =>
      Response.json({ ok: true, imported: 9 }, { status: 500 })
    );
    expect(await run(json)).toEqual(unknownOutcome);
  });

  it('a failed request, an unreadable 200 and an unknown 409 reason are unknown outcomes', async () => {
    const thrown = envWithDestination(() => {
      throw new Error('network');
    });
    expect(await run(thrown)).toEqual(unknownOutcome);
    const unreadable = envWithDestination(() => new Response('not json', { status: 200 }));
    expect(await run(unreadable)).toEqual(unknownOutcome);
    const oddReason = envWithDestination(() =>
      Response.json({ ok: false, reason: 'something_else' }, { status: 409 })
    );
    expect(await run(oddReason)).toEqual(unknownOutcome);
  });

  it('logs an unknown outcome with the key and user', async () => {
    const logger = createMockLogger();
    await importLegacyUsers(
      envWithDestination(() => new Response('x', { status: 503 })),
      KEY,
      { legacyClientId: 'shema', userIds: ['u1'] },
      { logger, requestId: 'req-1', currentStatus: active }
    );
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_legacy_import_outcome_unknown',
      expect.any(Error),
      { key_id: KEY.id, user_id: 'u1', audio_kept: 0 }
    );
  });

  it('a 400 (body refused before any write) is failed', async () => {
    const env = envWithDestination(() => Response.json({ error: 'bad' }, { status: 400 }));
    expect(await run(env)).toEqual([{ userId: 'u1', status: 'failed' }]);
  });

  it('a 409 reports its reason; a 200 reports copied', async () => {
    const busy = envWithDestination(() =>
      Response.json({ ok: false, reason: 'destination_busy' }, { status: 409 })
    );
    expect(await run(busy)).toEqual([{ userId: 'u1', status: 'destination_busy' }]);
    const ok = envWithDestination(() => Response.json({ ok: true, imported: 1 }));
    expect(await run(ok)).toEqual([
      { userId: 'u1', status: 'copied', entries: 1, audio: { copied: 0, existing: 0, missing: 0 } },
    ]);
  });
});

/** Import u1, whose history references one TTS object, against `dest`; did its partner copy survive? */
async function importWithAudio(dest: () => Response, renewLease?: () => Promise<boolean>) {
  const objects = new Map<string, Uint8Array>([['audio/bcs/u1/t.opus', new Uint8Array([1])]]);
  const bucket = {
    head: async (key: string) => (objects.has(key) ? {} : null),
    get: async (key: string) => (objects.has(key) ? { body: objects.get(key) } : null),
    put: async (key: string, body: Uint8Array) => void objects.set(key, body),
    delete: async (keys: string[]) => keys.forEach((key) => objects.delete(key)),
  };
  const source = {
    ...SOURCE,
    entries: [['history', [{ voice_audio_key: 'audio/bcs/u1/t.opus' }]]],
  };
  const env = {
    AUDIO_BUCKET: bucket,
    USER_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init?: RequestInit) => {
          if (init?.method !== 'PUT') return Response.json(source);
          puts += 1;
          return dest();
        },
      }),
    },
  } as unknown as Env;
  let puts = 0;
  const logger = createMockLogger();
  const [result] = await importLegacyUsers(
    env,
    KEY,
    { legacyClientId: 'shema', userIds: ['u1'] },
    { logger, requestId: 'req-1', currentStatus: active, ...(renewLease ? { renewLease } : {}) }
  );
  const kept = objects.has(`audio/bcs/partner:${KEY.userNamespace}:u1/t.opus`);
  return { result, kept, logger, puts };
}

/** A renewLease that answers `answers` in order, then false; counts its calls. */
function scriptedLease(answers: boolean[]) {
  let calls = 0;
  return {
    renew: async () => answers[calls++] ?? false,
    calls: () => calls,
  };
}

describe('importLegacyUsers: a lost import lease stops the run', () => {
  it('renews before each user; once a renewal is refused, the rest is deferred and not touched', async () => {
    const puts: string[] = [];
    const env = {
      USER_DO: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          fetch: async (_url: string, init?: RequestInit) => {
            if (init?.method === 'PUT') {
              puts.push(name);
              return Response.json({ ok: true, imported: 1 });
            }
            return Response.json(SOURCE);
          },
        }),
      },
    } as unknown as Env;
    // Each user renews twice (before the user, before the write): 10 holds for batch 1.
    const lease = scriptedLease(Array<boolean>(10).fill(true));
    const logger = createMockLogger();
    const userIds = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];
    const results = await importLegacyUsers(
      env,
      KEY,
      { legacyClientId: 'shema', userIds },
      { logger, requestId: 'req-1', currentStatus: active, renewLease: lease.renew }
    );
    expect(results.map((r) => r.status)).toEqual([
      ...Array<string>(5).fill('copied'),
      'deferred',
      'deferred',
    ]);
    expect(puts).toHaveLength(5);
    expect(logger.warn).toHaveBeenCalledWith('partner_key_legacy_import_lease_lost', {
      key_id: KEY.id,
    });
  });
});

describe('importLegacyUsers: a failing lease renewal', () => {
  it('a renewal that throws counts as lost (logged)', async () => {
    const logger = createMockLogger();
    const results = await importLegacyUsers(
      envWithDestination(() => Response.json({ ok: true, imported: 1 })),
      KEY,
      { legacyClientId: 'shema', userIds: ['u1'] },
      {
        logger,
        requestId: 'req-1',
        currentStatus: active,
        renewLease: async () => {
          throw new Error('store down');
        },
      }
    );
    expect(results).toEqual([{ userId: 'u1', status: 'deferred' }]);
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_legacy_import_lease_renew_failed',
      expect.any(Error),
      { key_id: KEY.id }
    );
  });
});

describe('importLegacyUsers: the lease covers the destination write', () => {
  it('held before the copy, lost before the write: no PUT, the copy stays, deferred', async () => {
    const lease = scriptedLease([true, false]);
    const out = await importWithAudio(() => Response.json({ ok: true, imported: 1 }), lease.renew);
    expect(out.result).toEqual({ userId: 'u1', status: 'deferred' });
    expect(out.puts).toBe(0);
    expect(out.kept).toBe(true);
    expect(out.logger.warn).toHaveBeenCalledWith(
      'partner_key_legacy_import_audio_kept_lease_lost',
      { key_id: KEY.id, user_id: 'u1', count: 1 }
    );
  });
});

describe('rehomeHistoryAudio renews during a long copy', () => {
  it(`asks keepGoing every ${AUDIO_RENEW_EVERY} objects and stops (keeping the copies) when it says no`, async () => {
    const objects = new Map<string, unknown>();
    const keys = Array.from({ length: 30 }, (_, i) => `audio/bcs/u1/t${i}.opus`);
    for (const k of keys) objects.set(k, new Uint8Array([1]));
    const bucket = {
      head: async (key: string) => (objects.has(key) ? {} : null),
      get: async (key: string) => (objects.has(key) ? { body: objects.get(key) } : null),
      put: async (key: string, body: unknown) => void objects.set(key, body),
    } as unknown as R2Bucket;
    const history = keys.map((k) => ({ voice_audio_key: k }));
    let asked = 0;
    const out = await rehomeHistoryAudio(
      bucket,
      [['history', history]],
      { org: 'bcs', namespace: 'pk_1', subject: 'u1' },
      createMockLogger(),
      async () => {
        asked += 1;
        return false;
      }
    );
    expect(asked).toBe(1);
    expect(out).toMatchObject({ ok: false, stopped: true });
    expect(out.written).toHaveLength(AUDIO_RENEW_EVERY);
    for (const key of out.written) expect(objects.has(key)).toBe(true);
  });
});

describe('importLegacyUsers: cleanup only while the lease is held', () => {
  it('never deletes copies once the lease is lost: a refusal then keeps them (logged)', async () => {
    const lease = scriptedLease([true, true, false]); // held for the user and the write, lost before cleanup
    const refused = await importWithAudio(
      () => Response.json({ ok: false, reason: 'destination_not_empty' }, { status: 409 }),
      lease.renew
    );
    expect(refused.result).toEqual({ userId: 'u1', status: 'destination_not_empty' });
    expect(refused.kept).toBe(true);
    expect(lease.calls()).toBe(3);
    expect(refused.logger.warn).toHaveBeenCalledWith(
      'partner_key_legacy_import_audio_kept_lease_lost',
      { key_id: KEY.id, user_id: 'u1', count: 1 }
    );
  });

  it('with the lease held, a refusal still removes this run’s copies', async () => {
    const lease = scriptedLease([true, true, true]);
    const refused = await importWithAudio(
      () => Response.json({ ok: false, reason: 'destination_not_empty' }, { status: 409 }),
      lease.renew
    );
    expect(refused.kept).toBe(false);
    expect(lease.calls()).toBe(3);
  });
});

describe('importLegacyUsers: users whose audio copies share a key', () => {
  it('a refused user never deletes the copy another user of the run imported (Ann B / Ann-B)', async () => {
    const shared = 'voice-submissions/bcs/Ann-B/Ann/v.ogg';
    const copy = `voice-submissions/bcs/partner:${KEY.userNamespace}:Ann-B/Ann/v.ogg`;
    const objects = new Map<string, unknown>([[shared, new Uint8Array([1])]]);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const bucket = {
      // Every R2 call yields, so users copied together interleave their head/put.
      head: async (key: string) => {
        await tick();
        return objects.has(key) ? {} : null;
      },
      get: async (key: string) => {
        await tick();
        return objects.has(key) ? { body: objects.get(key) } : null;
      },
      put: async (key: string, body: unknown) => {
        await tick();
        objects.set(key, body);
      },
      delete: async (keys: string[]) => {
        await tick();
        keys.forEach((key) => objects.delete(key));
      },
    };
    const source = {
      ...SOURCE,
      entries: [['history', [{ inbound_voice_audio_key: shared }]]],
    };
    const env = {
      AUDIO_BUCKET: bucket,
      USER_DO: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          fetch: async (url: string, init?: RequestInit) => {
            if (url.endsWith('/importable')) return Response.json({ ok: true });
            if (init?.method !== 'PUT') return Response.json(source);
            await tick();
            return name.endsWith(':Ann B')
              ? Response.json({ ok: true, imported: 1 })
              : Response.json({ ok: false, reason: 'destination_busy' }, { status: 409 });
          },
        }),
      },
    } as unknown as Env;
    const results = await importLegacyUsers(
      env,
      KEY,
      { legacyClientId: 'shema', userIds: ['Ann B', 'Ann-B'] },
      { logger: createMockLogger(), requestId: 'req-1', currentStatus: active }
    );
    expect(results.map((r) => r.status)).toEqual(['copied', 'destination_busy']);
    expect(objects.has(copy)).toBe(true);
  });
});

describe('importLegacyUsers: copied audio and the write outcome', () => {
  it('keeps the copies on an unknown outcome', async () => {
    const unknown = await importWithAudio(() => new Response('x', { status: 500 }));
    expect(unknown.result).toEqual({
      userId: 'u1',
      status: 'import_outcome_unknown',
      audio: { copied: 1, existing: 0, missing: 0 },
    });
    expect(unknown.kept).toBe(true);
  });

  it('removes the copies on a definite refusal', async () => {
    const refused = await importWithAudio(() =>
      Response.json({ ok: false, reason: 'destination_not_empty' }, { status: 409 })
    );
    expect(refused.result).toEqual({ userId: 'u1', status: 'destination_not_empty' });
    expect(refused.kept).toBe(false);
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

describe('toJsonSafe: what the legacy copy can carry', () => {
  it('accepts JSON data unchanged', () => {
    const ok = [null, 'a', true, 0, -1.5, [], [1, 'x'], {}, { a: { b: [null] } }];
    for (const value of ok) expect(toJsonSafe(value)).toEqual({ ok: true, value });
  });

  it('drops undefined object members, at any depth, and keeps the rest', () => {
    expect(toJsonSafe({ a: undefined, b: 1, c: { d: undefined, e: [{ f: undefined }] } })).toEqual({
      ok: true,
      value: { b: 1, c: { e: [{}] } },
    });
    const normalized = toJsonSafe({ a: undefined, b: 1 });
    expect(normalized.ok && Object.keys(normalized.value as object)).toEqual(['b']);
  });

  it('refuses anything a JSON round-trip would change', () => {
    const notOk = [
      undefined,
      Number.NaN,
      Infinity,
      -Infinity,
      new Date(0),
      new Map(),
      new Set(),
      new ArrayBuffer(1),
      new Uint8Array(1),
      () => 1,
      [() => 1],
      [undefined],
      { a: Number.NaN },
      { a: new Date(0) },
      BigInt(1),
      Symbol('s'),
    ];
    for (const value of notOk) expect(toJsonSafe(value)).toEqual({ ok: false });
  });
});

describe('importLegacyUsers when the status re-check itself fails', () => {
  it('stops, reports status_check_failed for the rest, and logs it', async () => {
    const env = envWithDestination(() => Response.json({ ok: true, imported: 1 }));
    let call = 0;
    const currentStatus = async () => {
      call += 1;
      if (call > 1) throw new Error('store unavailable');
      return 'active' as const;
    };
    const logger = createMockLogger();
    const userIds = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
    const results = await importLegacyUsers(
      env,
      KEY,
      { legacyClientId: 'shema', userIds },
      { logger, requestId: 'r', currentStatus }
    );
    expect(results.map((r) => r.status)).toEqual([
      'copied',
      'copied',
      'copied',
      'copied',
      'copied',
      'status_check_failed',
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_legacy_import_status_check_failed',
      expect.any(Error),
      { key_id: KEY.id }
    );
  });
});

describe('readImportEntries: the import body shape', () => {
  it('accepts [key, value] pairs with string keys and refuses anything else', () => {
    expect(
      readImportEntries({
        entries: [
          ['history', []],
          ['x', 1],
        ],
      })
    ).toHaveLength(2);
    expect(readImportEntries({ entries: [] })).toEqual([]);
    const bad = [
      undefined,
      null,
      [],
      {},
      { entries: 'x' },
      { entries: [['k']] },
      { entries: [['k', 1, 2]] },
      { entries: [[1, 'v']] },
      { entries: [['', 'v']] },
      { entries: [{ key: 'k', value: 1 }] },
    ];
    for (const body of bad) expect(readImportEntries(body)).toBeNull();
  });
});

const target = { org: 'bcs', namespace: 'pk_0123456789abcdef', subject: 'u1' };
const history = (key: string) =>
  [
    [
      'history',
      [{ user_message: 'm', assistant_response: 'r', timestamp: 1, voice_audio_key: key }],
    ],
  ] as [string, unknown][];

/** An in-memory bucket: `objects` holds what exists; `failPut` makes every put throw. */
function fakeBucket(objects: Map<string, string>, failPut = false) {
  return {
    head: vi.fn(async (key: string) => (objects.has(key) ? { key } : null)),
    get: vi.fn(async (key: string) =>
      objects.has(key) ? { body: objects.get(key), httpMetadata: {} } : null
    ),
    put: vi.fn(async (key: string, body: string) => {
      if (failPut) throw new Error('R2 put failed');
      objects.set(key, body);
    }),
  };
}
const SOURCE_KEY = 'audio/bcs/u1/a.opus';
const TARGET_KEY = 'audio/bcs/partner:pk_0123456789abcdef:u1/a.opus';

describe('rehomeHistoryAudio: failures fail the user', () => {
  it('a failed copy fails the user (ok: false), logged, nothing listed as written', async () => {
    const bucket = fakeBucket(new Map([[SOURCE_KEY, 'x']]), true);
    const logger = createMockLogger();
    const out = await rehomeHistoryAudio(
      bucket as unknown as R2Bucket,
      history(SOURCE_KEY),
      target,
      logger
    );
    expect(out).toEqual({ ok: false, written: [], stopped: false });
    expect(logger.error).toHaveBeenCalledWith(
      'partner_key_legacy_import_audio_copy_failed',
      expect.any(Error),
      { user_id: 'u1', source_key: SOURCE_KEY }
    );
  });

  it('a key outside the two audio families fails the user without touching R2', async () => {
    const bucket = fakeBucket(new Map());
    const out = await rehomeHistoryAudio(
      bucket as unknown as R2Bucket,
      history('ptxprint/x.pdf'),
      target,
      createMockLogger()
    );
    expect(out.ok).toBe(false);
    expect(bucket.head).not.toHaveBeenCalled();
  });
});

describe('rehomeHistoryAudio: streaming, reuse and missing sources', () => {
  it('streams the copy (passes the object body to put)', async () => {
    const bucket = fakeBucket(new Map([[SOURCE_KEY, 'stream-body']]));
    const out = await rehomeHistoryAudio(
      bucket as unknown as R2Bucket,
      history(SOURCE_KEY),
      target,
      createMockLogger()
    );
    expect(out).toMatchObject({ ok: true, written: [TARGET_KEY] });
    expect(bucket.put).toHaveBeenCalledWith(TARGET_KEY, 'stream-body', { httpMetadata: {} });
  });

  it('reuses a target that already exists: no put, not listed as written', async () => {
    const bucket = fakeBucket(
      new Map([
        [SOURCE_KEY, 'x'],
        [TARGET_KEY, 'earlier run'],
      ])
    );
    const out = await rehomeHistoryAudio(
      bucket as unknown as R2Bucket,
      history(SOURCE_KEY),
      target,
      createMockLogger()
    );
    expect(out).toMatchObject({
      ok: true,
      written: [],
      counts: { copied: 0, existing: 1, missing: 0 },
    });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('a missing source drops only its key and keeps the entry', async () => {
    const bucket = fakeBucket(new Map());
    const out = await rehomeHistoryAudio(
      bucket as unknown as R2Bucket,
      history(SOURCE_KEY),
      target,
      createMockLogger()
    );
    expect(out).toMatchObject({ ok: true, counts: { copied: 0, existing: 0, missing: 1 } });
    if (!out.ok) return;
    const [entry] = out.entries[0]?.[1] as Record<string, unknown>[];
    expect(entry).toEqual({ user_message: 'm', assistant_response: 'r', timestamp: 1 });
  });
});

describe('partnerAudioKeyFor', () => {
  it('maps keys to the partner partition exactly as the chat flow writes them', () => {
    expect(partnerAudioKeyFor('audio/old/u1/a.opus', target)).toBe(
      'audio/bcs/partner:pk_0123456789abcdef:u1/a.opus'
    );
    expect(
      partnerAudioKeyFor('voice-submissions/bcs/u1/Ann/v.ogg', { ...target, subject: 'a b' })
    ).toBe('voice-submissions/bcs/partner:pk_0123456789abcdef:a-b/Ann/v.ogg');
    expect(partnerAudioKeyFor('audio/bcs/u1/x/a.opus', target)).toBeNull();
  });
});

describe('importLegacyUsers operation budget', () => {
  it('defers the users that would not fit, and every later one', async () => {
    const env = envWithDestination(() => Response.json({ ok: true, imported: 1 }));
    const userIds = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];
    // Batch 1: status check (1) + 5 per user (two lease renewals, preflight,
    // export, import) leaves room for 3 users out of 16.
    const results = await importLegacyUsers(
      env,
      KEY,
      { legacyClientId: 'shema', userIds },
      { logger: createMockLogger(), requestId: 'r', currentStatus: active, operationBudget: 16 }
    );
    expect(results.map((r) => r.status)).toEqual([
      'copied',
      'copied',
      'copied',
      'deferred',
      'deferred',
      'deferred',
      'deferred',
    ]);
  });

  it('the default budget is a named constant well under the Cloudflare subrequest limit', () => {
    expect(LEGACY_IMPORT_OPERATION_BUDGET).toBe(800);
  });
});

describe('importLegacyUsers preflights the destination before any audio', () => {
  it('a destination that refuses is skipped without the source export or R2', async () => {
    const calls: string[] = [];
    const stub = {
      fetch: async (url: string) => {
        calls.push(new URL(url).pathname);
        return Response.json({ ok: false, reason: 'destination_not_empty' }, { status: 409 });
      },
    };
    const env = {
      USER_DO: { idFromName: (n: string) => n, get: () => stub },
      AUDIO_BUCKET: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error('R2 touched');
          },
        }
      ),
    } as unknown as Env;
    const results = await importLegacyUsers(
      env,
      KEY,
      { legacyClientId: 'shema', userIds: ['u1'] },
      { logger: createMockLogger(), requestId: 'r', currentStatus: active }
    );
    expect(results).toEqual([{ userId: 'u1', status: 'destination_not_empty' }]);
    expect(calls).toEqual(['/admin/user-data/importable']);
  });
});
