/**
 * User pseudonym for the OTLP path (A1 — docs/plans/production-otel.md).
 *
 * The worker's structured logs carry a raw `user_id`. That is fine for the console
 * branch — `bt-servant-telemetry` consumes it via a Tail Worker and derives its own
 * salted hash for D1 — but it must NOT reach OpenObserve, where an infra admin (and
 * possibly QA) can read it. The live sink reports `rbac_enabled: false`, so there is
 * no per-stream scoping to fall back on.
 *
 * So the OTLP branch carries `user_hash = HMAC-SHA-256(salt, "clientId:userId")`
 * instead, and the collector deletes `user_id` before it reaches the sink.
 *
 * ## Why AsyncLocalStorage
 *
 * `crypto.subtle.sign` is async; `buildLogAttributes` and `redactSpan` are sync and run
 * on the hot logging/export path. So the HMAC is computed ONCE per request, at the entry
 * point where async is already available, and parked in an async-context store the sync
 * consumers read. A module-level variable would be wrong: a Durable Object alarm can run
 * while a prior fetch's background work is still emitting on the same isolate, and each
 * call tree must see only its own pseudonym.
 *
 * ## Why this salt is NOT bt-servant-telemetry's salt
 *
 * They are independent by design. That app keeps using its own `PII_HASH_SALT` — which
 * nobody can read back out of Cloudflare, and nobody needs to. Its hash lands in D1 and
 * feeds the cohort KPIs; this hash lands in OpenObserve and is only a correlation key.
 * No table, query, or count ever contains both. See "Why two hashes cannot double-count"
 * in the plan.
 *
 * Consequence worth knowing: an OpenObserve record cannot be joined to a D1 user row by
 * identity. Correlate on `request_id`, which is present in both.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { Env } from '../../config/types.js';

/**
 * The current request's pseudonym, scoped to its async call tree. Empty outside a
 * `withUserPseudonym` scope — startup, an unwrapped alarm handler, tests — and the
 * consumers treat that as "emit nothing" rather than falling back to a raw id.
 */
const userPseudonym = new AsyncLocalStorage<string | undefined>();

/**
 * Run `fn` with the pseudonym explicitly CLEARED.
 *
 * Calling `fn()` bare would not do this: `AsyncLocalStorage` inherits the enclosing
 * store, so a fail-closed path nested inside another user's scope would silently run
 * under THAT user's pseudonym. Real path: a group DO drains user B's queue entry from
 * background work created in user A's `handleUnifiedChat` scope. Cross-user attribution
 * is worse than no attribution, so every fallback runs through here.
 */
function withoutPseudonym<T>(fn: () => Promise<T>): Promise<T> {
  return userPseudonym.run(undefined, fn);
}

/**
 * HMAC-SHA-256 over `${clientId}:${userId}`, hex-encoded.
 *
 * The `clientId:` namespace prevents collisions across channels — the same digits can be
 * a WhatsApp number and a Telegram id. This mirrors the construction bt-servant-telemetry
 * uses (`apps/web/src/ingest/redact.ts`), deliberately: same shape, different key, so the
 * two systems are structurally comparable but cryptographically unlinkable.
 */
export async function hashUserId(salt: string, clientId: string, userId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${clientId}:${userId}`));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Run `fn` (and its whole async call tree) with the request's pseudonym in context, so
 * every log record and span it produces can carry `user_hash` without re-hashing.
 *
 * FAILS CLOSED: if the salt is unset (telemetry disabled, or the secret not yet
 * provisioned) or either identifier is missing, `fn` runs with NO pseudonym in scope and
 * nothing is emitted. A missing correlation key is recoverable; a leaked raw id is not.
 *
 * Never throws on the telemetry account: a hashing failure must not break the request it
 * is describing, so it degrades to "no pseudonym" and reports via the caller's logger.
 */
export async function withUserPseudonym<T>(
  env: Env,
  clientId: string | undefined,
  userId: string | undefined,
  fn: () => Promise<T>,
  onError?: (error: unknown) => void
): Promise<T> {
  const salt = env.TELEMETRY_USER_ID_SALT;
  if (!salt || !clientId || !userId) return withoutPseudonym(fn);

  let pseudonym: string;
  try {
    pseudonym = await hashUserId(salt, clientId, userId);
  } catch (error) {
    // Degrade to no pseudonym — but never silently, and never to the ENCLOSING scope's
    // pseudonym. The caller logs it with request context; telemetry losing a correlation
    // key must not take the request with it.
    //
    // `onError` runs INSIDE the cleared store, not before it. `onError` is a logging
    // callback, so emitting it under the enclosing scope would stamp the outer user's
    // `user_hash` onto a `user_pseudonym_failed` record carrying THIS user's client_id and
    // message_id — the exact cross-user attribution this fail-closed path exists to prevent.
    return withoutPseudonym(async () => {
      onError?.(error);
      return fn();
    });
  }
  // Tag the currently-active span too. Span attributes must be set while the span is
  // live: `RedactingSpanExporter` runs at EXPORT time, long after the handler has left
  // this scope, so reading the store there would always see undefined. This catches the
  // auto-instrumented request/DO root; `withSpan` tags its own children at creation.
  trace.getActiveSpan()?.setAttribute('user_hash', pseudonym);
  return userPseudonym.run(pseudonym, fn);
}

/** The current async context's pseudonym, or undefined outside a scope. */
export function getUserPseudonym(): string | undefined {
  return userPseudonym.getStore();
}

/** Test-only: run `fn` with an explicit pseudonym, skipping the HMAC. */
export function runWithPseudonymForTests<T>(pseudonym: string, fn: () => T): T {
  return userPseudonym.run(pseudonym, fn);
}
