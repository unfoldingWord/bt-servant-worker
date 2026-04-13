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

/** Validate an optional ISO 639-1 language code. */
function validateLanguageHint(hint: unknown): string | null {
  if (hint === undefined) return null;
  if (typeof hint !== 'string' || !/^[a-z]{2}$/.test(hint)) {
    return 'response_language_hint must be a valid ISO 639-1 language code (2 lowercase letters)';
  }
  return null;
}

/**
 * Per-transport field-presence rules.
 *
 * The stream-side rejections use `!== undefined` (not truthy checks) so
 * that an explicit `null` or empty string is still rejected — any
 * *presence* of a callback-flavored field on /chat/stream is an error.
 * The callback-side checks use truthy (`!`) because empty strings are
 * not usable as a URL or correlation key and should be rejected the
 * same way as a missing field.
 */
function validateTransportFields(body: ChatRequest, transport: ChatTransport): string | null {
  if (transport === 'stream') {
    if (body.progress_callback_url !== undefined) {
      return 'progress_callback_url is not valid on /api/v1/chat/stream — use /api/v1/chat/callback';
    }
    if (body.progress_mode !== undefined) {
      return 'progress_mode is not valid on /api/v1/chat/stream — use /api/v1/chat/callback';
    }
    if (body.progress_throttle_seconds !== undefined) {
      return 'progress_throttle_seconds is not valid on /api/v1/chat/stream — use /api/v1/chat/callback';
    }
    if (body.message_key !== undefined) {
      return 'message_key is not valid on /api/v1/chat/stream — use /api/v1/chat/callback';
    }
    return null;
  }
  if (transport === 'callback') {
    if (!body.progress_callback_url) {
      return 'progress_callback_url is required on /api/v1/chat/callback';
    }
    if (!body.message_key) {
      return 'message_key is required on /api/v1/chat/callback';
    }
    return null;
  }
  // 'legacy' transport keeps current implicit-dispatch behavior — no rules.
  return null;
}

/** Validate chat request fields, returning an error string or null if valid. */
export function validateChatBody(body: ChatRequest, transport: ChatTransport): string | null {
  if (!body.user_id) return 'user_id is required';
  if (!body.client_id) return 'client_id is required';
  if (body.chat_type && !VALID_CHAT_TYPES.has(body.chat_type)) {
    return `Invalid chat_type: ${body.chat_type}. Must be one of: private, group, supergroup`;
  }
  const isGroup = body.chat_type === 'group' || body.chat_type === 'supergroup';
  if (isGroup && !body.chat_id) return 'chat_id is required for group/supergroup chats';

  const transportError = validateTransportFields(body, transport);
  if (transportError) return transportError;

  return validateLanguageHint(body.response_language_hint);
}
