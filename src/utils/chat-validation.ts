/**
 * Shared validation for POST /api/v1/chat{,/stream,/callback} request bodies.
 *
 * Used by the worker route handlers in src/index.ts AND by UserDO's
 * handleUnifiedChat as a defense-in-depth re-validation. Keeping one
 * implementation prevents the worker- and DO-side rules from drifting
 * and silently breaking the transport-to-delivery invariant the queue
 * dispatch relies on.
 */

import type { ChatRequest, ChatTransport } from '../types/engine.js';

const VALID_CHAT_TYPES: ReadonlySet<string> = new Set(['private', 'group', 'supergroup']);

/**
 * client_id values that identify admin-origin callers.
 *
 * These client_ids are hardcoded in the corresponding caller's server-side
 * source (e.g. bt-servant-admin-portal/worker/baruch.ts sets
 * `client_id: "admin-portal"` on every chat relay). Because the bearer-token
 * auth middleware already gates `/api/*`, the set of callers that can reach
 * this code path is bounded to internal services holding ENGINE_API_KEY;
 * deriving the admin bit from client_id — rather than from a self-asserted
 * body flag — ties the signal to which caller it came from rather than what
 * the caller chose to write in JSON.
 */
const ADMIN_CLIENT_IDS: ReadonlySet<string> = new Set(['admin-portal']);

/** True when the incoming request originated from an admin-capable client. */
export function isAdminClient(clientId: string | undefined): boolean {
  return clientId !== undefined && ADMIN_CLIENT_IDS.has(clientId);
}

/** Validate an optional ISO 639-1 language code. */
function validateLanguageHint(hint: unknown): string | null {
  if (hint === undefined) return null;
  if (typeof hint !== 'string' || !/^[a-z]{2}$/.test(hint)) {
    return 'response_language_hint must be a valid ISO 639-1 language code (2 lowercase letters)';
  }
  return null;
}

/**
 * Reject callback-flavored fields on transports that don't accept them.
 *
 * Uses `!== undefined` (not truthy checks) so that an explicit `null` or
 * empty string is still rejected — any *presence* of a callback-flavored
 * field on /chat or /chat/stream is an error. Both endpoints deliver a
 * self-contained response (JSON or SSE) and have no use for a callback
 * URL, correlation key, or progress-mode tuning.
 */
function forbidCallbackFields(body: ChatRequest, endpoint: string): string | null {
  if (body.progress_callback_url !== undefined) {
    return `progress_callback_url is not valid on ${endpoint} — use /api/v1/chat/callback`;
  }
  if (body.progress_mode !== undefined) {
    return `progress_mode is not valid on ${endpoint} — use /api/v1/chat/callback`;
  }
  if (body.progress_throttle_seconds !== undefined) {
    return `progress_throttle_seconds is not valid on ${endpoint} — use /api/v1/chat/callback`;
  }
  if (body.message_key !== undefined) {
    return `message_key is not valid on ${endpoint} — use /api/v1/chat/callback`;
  }
  return null;
}

/**
 * Require the two fields that /chat/callback cannot operate without.
 *
 * Uses truthy (`!`) because empty strings are not usable as a URL or
 * correlation key and should be rejected the same way as a missing field.
 */
function requireCallbackFields(body: ChatRequest): string | null {
  if (!body.progress_callback_url) {
    return 'progress_callback_url is required on /api/v1/chat/callback';
  }
  if (!body.message_key) {
    return 'message_key is required on /api/v1/chat/callback';
  }
  return null;
}

/** Per-transport field-presence rules. */
function validateTransportFields(body: ChatRequest, transport: ChatTransport): string | null {
  if (transport === 'final') return forbidCallbackFields(body, '/api/v1/chat');
  if (transport === 'stream') return forbidCallbackFields(body, '/api/v1/chat/stream');
  if (transport === 'callback') return requireCallbackFields(body);
  return null;
}

function validateCoreFields(body: ChatRequest): string | null {
  if (!body.user_id) return 'user_id is required';
  if (!body.client_id) return 'client_id is required';
  // is_admin is not a public field — admin origin is derived from client_id
  // server-side via isAdminClient(). Reject the field so older callers that
  // try to self-assert get a clear error rather than silent false-negatives.
  if ((body as unknown as Record<string, unknown>).is_admin !== undefined) {
    return 'is_admin is not a valid field; admin origin is derived from client_id';
  }
  if (body.chat_type && !VALID_CHAT_TYPES.has(body.chat_type)) {
    return `Invalid chat_type: ${body.chat_type}. Must be one of: private, group, supergroup`;
  }
  const isGroup = body.chat_type === 'group' || body.chat_type === 'supergroup';
  if (isGroup && !body.chat_id) return 'chat_id is required for group/supergroup chats';
  return null;
}

/** Validate chat request fields, returning an error string or null if valid. */
export function validateChatBody(body: ChatRequest, transport: ChatTransport): string | null {
  const coreError = validateCoreFields(body);
  if (coreError) return coreError;

  const transportError = validateTransportFields(body, transport);
  if (transportError) return transportError;

  return validateLanguageHint(body.response_language_hint);
}
