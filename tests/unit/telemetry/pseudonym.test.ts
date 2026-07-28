/**
 * The OTLP-path user pseudonym (A1 — docs/plans/production-otel.md).
 *
 * Two properties matter most here and are asserted directly:
 *  1. It FAILS CLOSED. No salt, no identifiers, or a hashing failure ⇒ no `user_hash`
 *     egresses. A missing correlation key is recoverable; a leaked raw id is not.
 *  2. Async contexts are isolated. A DO alarm can run while a prior fetch's background
 *     work still emits on the same isolate, and neither may see the other's pseudonym.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  hashUserId,
  withUserPseudonym,
  getUserPseudonym,
  runWithPseudonymForTests,
} from '../../../src/services/telemetry/pseudonym.js';
import { buildLogAttributes } from '../../../src/services/telemetry/logs.js';
import { redactSpan } from '../../../src/services/telemetry/config.js';
import type { LogEntry } from '../../../src/utils/logger.js';
import { Env } from '../../../src/config/types.js';

const SALTED = { TELEMETRY_USER_ID_SALT: 'test-salt' } as Env;
const UNSALTED = {} as Env;

// Independently computed (python hmac), NOT by calling the code under test — otherwise the
// assertion would only prove the function agrees with itself.
const HASH_TELEGRAM = '62e087febfdc7dca0c35c57e4e5f5b59574e4b3e826fe18cd8c0270258d99dd8';
const HASH_WHATSAPP = 'fdeedebaee70ab3909a0086fd0d397041117866718f85820ac335277542ea34e';

describe('hashUserId', () => {
  it('matches an independently computed HMAC-SHA-256 vector', async () => {
    await expect(hashUserId('test-salt', 'telegram', 'telegram:42')).resolves.toBe(HASH_TELEGRAM);
  });

  it('namespaces by client_id so the same id on two channels never collides', async () => {
    const a = await hashUserId('test-salt', 'telegram', 'telegram:42');
    const b = await hashUserId('test-salt', 'whatsapp', 'telegram:42');
    expect(a).toBe(HASH_TELEGRAM);
    expect(b).toBe(HASH_WHATSAPP);
    expect(a).not.toBe(b);
  });

  it('is stable across calls — cohort-style math would be meaningless otherwise', async () => {
    const a = await hashUserId('test-salt', 'telegram', 'telegram:42');
    const b = await hashUserId('test-salt', 'telegram', 'telegram:42');
    expect(a).toBe(b);
  });

  it('a different salt yields a different pseudonym (the two systems stay unlinkable)', async () => {
    const ours = await hashUserId('test-salt', 'telegram', 'telegram:42');
    const theirs = await hashUserId('a-completely-different-salt', 'telegram', 'telegram:42');
    expect(ours).not.toBe(theirs);
  });
});

describe('withUserPseudonym — fail closed', () => {
  it('puts the pseudonym in scope when salt and both identifiers are present', async () => {
    const seen = await withUserPseudonym(SALTED, 'telegram', 'telegram:42', async () =>
      getUserPseudonym()
    );
    expect(seen).toBe(HASH_TELEGRAM);
  });

  it('runs fn with NO pseudonym when the salt is unset', async () => {
    const seen = await withUserPseudonym(UNSALTED, 'telegram', 'telegram:42', async () =>
      getUserPseudonym()
    );
    expect(seen).toBeUndefined();
  });

  it('runs fn with NO pseudonym when client_id is missing', async () => {
    const seen = await withUserPseudonym(SALTED, undefined, 'telegram:42', async () =>
      getUserPseudonym()
    );
    expect(seen).toBeUndefined();
  });

  it('runs fn with NO pseudonym when user_id is missing', async () => {
    const seen = await withUserPseudonym(SALTED, 'telegram', undefined, async () =>
      getUserPseudonym()
    );
    expect(seen).toBeUndefined();
  });

  it('treats an empty-string salt as unset and still runs the handler', async () => {
    const errors: unknown[] = [];
    const result = await withUserPseudonym(
      { TELEMETRY_USER_ID_SALT: '' } as Env,
      'telegram',
      'telegram:42',
      async () => 'handler-ran',
      (e) => errors.push(e)
    );
    expect(result).toBe('handler-ran');
    // Short-circuits as falsy before hashing, so this is the fail-closed path, not the
    // error path — nothing to report. The error path is covered below.
    expect(errors).toHaveLength(0);
    expect(getUserPseudonym()).toBeUndefined();
  });
});

describe('withUserPseudonym — resilience', () => {
  it('reports a hashing failure and still runs the handler', async () => {
    // Force the failure the fail-closed branch exists for: make importKey reject.
    const subtle = globalThis.crypto.subtle;
    const spy = vi
      .spyOn(subtle, 'importKey')
      .mockRejectedValue(new Error('subtle unavailable') as never);

    const errors: unknown[] = [];
    let seen: string | undefined = 'not-run';
    const result = await withUserPseudonym(
      SALTED,
      'telegram',
      'telegram:42',
      async () => {
        seen = getUserPseudonym();
        return 'handler-ran';
      },
      (e) => errors.push(e)
    );

    spy.mockRestore();
    // The request must survive a telemetry failure, with the failure observable.
    expect(result).toBe('handler-ran');
    expect(seen).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('subtle unavailable');
  });

  it('two independent scopes agree — the worker/DO isolate boundary', async () => {
    // A chat request is handled by TWO isolates: the worker, then the Durable Object.
    // AsyncLocalStorage cannot cross stub.fetch(), so each establishes its own scope from
    // the same body. This asserts the property that makes that safe: same salt + same
    // identifiers ⇒ same pseudonym, so both halves of one request correlate in the sink.
    // If this ever fails, one user appears as two in OpenObserve.
    const workerSide = await withUserPseudonym(
      SALTED,
      'whatsapp',
      'whatsapp:15551234567',
      async () => getUserPseudonym()
    );
    const doSide = await withUserPseudonym(SALTED, 'whatsapp', 'whatsapp:15551234567', async () =>
      getUserPseudonym()
    );
    expect(workerSide).toBeDefined();
    expect(doSide).toBe(workerSide);
  });

  it('isolates concurrent async contexts', async () => {
    const [a, b, outside] = await Promise.all([
      withUserPseudonym(SALTED, 'telegram', 'telegram:42', async () => getUserPseudonym()),
      withUserPseudonym(SALTED, 'whatsapp', 'telegram:42', async () => getUserPseudonym()),
      Promise.resolve(getUserPseudonym()),
    ]);
    expect(a).toBe(HASH_TELEGRAM);
    expect(b).toBe(HASH_WHATSAPP);
    expect(outside).toBeUndefined();
  });
});

describe('buildLogAttributes — adds user_hash, keeps user_id', () => {
  const entry = {
    event: 'request_received',
    request_id: 'req-1',
    timestamp: 1,
    user_id: 'telegram:42',
    client_id: 'telegram',
  } as LogEntry;

  it('emits BOTH identifiers inside a pseudonym scope', () => {
    const attrs = runWithPseudonymForTests(HASH_TELEGRAM, () => buildLogAttributes(entry));
    // user_id survives for bt-servant-telemetry (Phase C1); the collector deletes it on the
    // OpenObserve pipeline. user_hash is what actually reaches the sink.
    expect(attrs.user_id).toBe('telegram:42');
    expect(attrs.user_hash).toBe(HASH_TELEGRAM);
  });

  it('emits no user_hash outside a scope', () => {
    const attrs = buildLogAttributes(entry);
    expect(attrs.user_hash).toBeUndefined();
    expect(attrs.user_id).toBe('telegram:42');
  });

  it('correlates records that never mentioned the user themselves', () => {
    const bare = { event: 'claude_request', request_id: 'req-1', timestamp: 1 } as LogEntry;
    const attrs = runWithPseudonymForTests(HASH_TELEGRAM, () => buildLogAttributes(bare));
    expect(attrs.user_hash).toBe(HASH_TELEGRAM);
  });
});

describe('redactSpan — substitutes rather than adding', () => {
  /** Minimal span stub with the mutable attribute bag redactSpan operates on. */
  const span = (attributes: Record<string, unknown>) =>
    ({ attributes, name: 'fetchHandler POST', events: [] }) as unknown as Parameters<
      typeof redactSpan
    >[0];

  it('replaces user_id with user_hash inside a scope', () => {
    const s = span({ user_id: 'telegram:42', transport: 'telegram' });
    runWithPseudonymForTests(HASH_TELEGRAM, () => redactSpan(s));
    const attrs = s.attributes as Record<string, unknown>;
    // Spans reach OpenObserve ONLY — nothing downstream needs the raw id, so it must go.
    expect(attrs.user_id).toBeUndefined();
    expect(attrs.user_hash).toBe(HASH_TELEGRAM);
    expect(attrs.transport).toBe('telegram');
  });

  it('drops user_id with no replacement outside a scope', () => {
    const s = span({ user_id: 'telegram:42' });
    redactSpan(s);
    const attrs = s.attributes as Record<string, unknown>;
    expect(attrs.user_id).toBeUndefined();
    expect(attrs.user_hash).toBeUndefined();
  });

  it('leaves spans that never carried an identifier alone', () => {
    const s = span({ transport: 'telegram' });
    runWithPseudonymForTests(HASH_TELEGRAM, () => redactSpan(s));
    const attrs = s.attributes as Record<string, unknown>;
    expect(attrs.user_hash).toBeUndefined();
    expect(attrs.transport).toBe('telegram');
  });
});
