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

/** Read the ambient pseudonym. Hoisted so cases do not nest callbacks needlessly. */
async function readPseudonym(): Promise<string | undefined> {
  return getUserPseudonym();
}

/** Make crypto.subtle.importKey reject, forcing withUserPseudonym's catch branch. */
function breakHashing() {
  return vi
    .spyOn(globalThis.crypto.subtle, 'importKey')
    .mockRejectedValue(new Error('subtle unavailable') as never);
}

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
    const seen = await withUserPseudonym(SALTED, 'telegram', 'telegram:42', readPseudonym);
    expect(seen).toBe(HASH_TELEGRAM);
  });

  it('runs fn with NO pseudonym when the salt is unset', async () => {
    const seen = await withUserPseudonym(UNSALTED, 'telegram', 'telegram:42', readPseudonym);
    expect(seen).toBeUndefined();
  });

  it('runs fn with NO pseudonym when client_id is missing', async () => {
    const seen = await withUserPseudonym(SALTED, undefined, 'telegram:42', readPseudonym);
    expect(seen).toBeUndefined();
  });

  it('runs fn with NO pseudonym when user_id is missing', async () => {
    const seen = await withUserPseudonym(SALTED, 'telegram', undefined, readPseudonym);
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
    const spy = breakHashing();
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
      readPseudonym
    );
    const doSide = await withUserPseudonym(
      SALTED,
      'whatsapp',
      'whatsapp:15551234567',
      readPseudonym
    );
    expect(workerSide).toBeDefined();
    expect(doSide).toBe(workerSide);
  });

  it('isolates concurrent async contexts', async () => {
    const [a, b, outside] = await Promise.all([
      withUserPseudonym(SALTED, 'telegram', 'telegram:42', readPseudonym),
      withUserPseudonym(SALTED, 'whatsapp', 'telegram:42', readPseudonym),
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

  // redactSpan runs from RedactingSpanExporter.export(), which fires AFTER spans end —
  // by then the handler has left withUserPseudonym and the store reads undefined. So it
  // must NOT try to substitute here; the pseudonym is attached at span CREATION instead.
  it('drops user_id, and never substitutes — even with a pseudonym in scope', () => {
    const s = span({ user_id: 'telegram:42', transport: 'telegram' });
    runWithPseudonymForTests(HASH_TELEGRAM, () => redactSpan(s));
    const attrs = s.attributes as Record<string, unknown>;
    expect(attrs.user_id).toBeUndefined();
    expect(attrs.user_hash).toBeUndefined();
    expect(attrs.transport).toBe('telegram');
  });

  it('drops user_id outside a scope too', () => {
    const s = span({ user_id: 'telegram:42' });
    redactSpan(s);
    expect((s.attributes as Record<string, unknown>).user_id).toBeUndefined();
  });

  it('preserves a user_hash that span creation already attached', () => {
    // The realistic shape: withSpan set user_hash while the span was live, and export-time
    // redaction must leave it intact.
    const s = span({ user_hash: HASH_TELEGRAM, transport: 'telegram' });
    redactSpan(s);
    const attrs = s.attributes as Record<string, unknown>;
    expect(attrs.user_hash).toBe(HASH_TELEGRAM);
    expect(attrs.transport).toBe('telegram');
  });
});

/**
 * AsyncLocalStorage INHERITS the enclosing store, so a fail-closed path that simply calls
 * `fn()` would run under whatever user's scope happens to enclose it. That is not a
 * theoretical concern: a group DO drains user B's queue entry from background work created
 * inside user A's `handleUnifiedChat` scope. Attributing B's records to A is strictly worse
 * than attributing them to nobody, so both fallback branches must CLEAR, not inherit.
 */
describe('withUserPseudonym — nested scopes must clear, not inherit', () => {
  /** Inner call with a missing client_id, run from inside an outer user's scope. */
  const nestedMissingId = () =>
    withUserPseudonym(SALTED, undefined, 'whatsapp:15550001111', readPseudonym);

  /** What the onError callback observed, so a case can assert the diagnostic's own scope. */
  let seenByOnError: string | undefined | 'never-called';

  /** Inner call whose hashing will fail, run from inside an outer user's scope. */
  const nestedFailing = () =>
    withUserPseudonym(SALTED, 'whatsapp', 'whatsapp:15550001111', readPseudonym, () => {
      seenByOnError = getUserPseudonym();
    });

  it('clears when the inner call is missing identifiers', async () => {
    const inner = await withUserPseudonym(SALTED, 'telegram', 'telegram:42', nestedMissingId);
    expect(inner).toBeUndefined();
  });

  it('clears when the inner call fails to hash', async () => {
    const spy = breakHashing();
    const inner = await runWithPseudonymForTests(HASH_TELEGRAM, nestedFailing);
    spy.mockRestore();
    expect(inner).toBeUndefined();
  });

  it('clears for the onError diagnostic itself, not just the handler', async () => {
    // onError is a LOGGING callback. Running it under the enclosing store would stamp user
    // A's user_hash onto a user_pseudonym_failed record carrying user B's client_id — the
    // same cross-user attribution, just relocated into the diagnostic.
    seenByOnError = 'never-called';
    const spy = breakHashing();
    await runWithPseudonymForTests(HASH_TELEGRAM, nestedFailing);
    spy.mockRestore();
    expect(seenByOnError).not.toBe('never-called');
    expect(seenByOnError).toBeUndefined();
  });
});
