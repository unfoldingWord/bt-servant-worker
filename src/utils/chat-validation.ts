/**
 * Shared validation for POST /api/v1/chat{,/stream,/callback} request bodies.
 *
 * Used by the worker route handlers in src/index.ts AND by UserDO's
 * handleUnifiedChat as a defense-in-depth re-validation. Keeping one
 * implementation prevents the worker- and DO-side rules from drifting
 * and silently breaking the transport-to-delivery invariant the queue
 * dispatch relies on.
 */

import type { ChatCaller, ChatRequest, ChatTransport } from '../types/engine.js';
import { hasClientHistory, validateClientHistory } from './history-validation.js';

const VALID_CHAT_TYPES: ReadonlySet<string> = new Set(['private', 'group', 'supergroup']);

const VALID_VOICE_FORMATS: ReadonlySet<string> = new Set(['opus', 'aac']);

/** ISO 639-1 language code shape: exactly two lowercase letters. */
const ISO_639_1_PATTERN = /^[a-z]{2}$/;

/**
 * True when `code` has the shape of an ISO 639-1 language code. The single
 * definition shared by the request-body `response_language_hint` check here
 * and the persisted `response_language` check in UserDO (`PUT /preferences`).
 */
export function isValidLanguageCode(code: string): boolean {
  return ISO_639_1_PATTERN.test(code);
}

/**
 * client_id values that identify admin-origin callers.
 *
 * These client_ids are hardcoded in the corresponding caller's server-side
 * source (e.g. bt-servant-admin-portal/worker/baruch.ts sets
 * `client_id: "admin-portal"` on every chat relay). client_id is still
 * self-asserted body data: since partner API keys (admin-portal#354) the
 * callers that reach the chat routes are no longer only internal services
 * holding ENGINE_API_KEY. So the admin bit must never be derived from
 * client_id alone — use {@link callerIsAdmin}, which also requires the
 * request to come from an internal caller. For partner requests the client_id
 * is not the partner's at all: the worker replaces it with a server-set
 * `partner:<userNamespace>` (see {@link partnerClientId}), so it can never
 * name an admin client in the first place.
 */
const ADMIN_CLIENT_IDS: ReadonlySet<string> = new Set(['admin-portal']);

/** True when `clientId` names an admin-capable client. Not sufficient on its own; see callerIsAdmin. */
export function isAdminClient(clientId: string | undefined): boolean {
  return clientId !== undefined && ADMIN_CLIENT_IDS.has(clientId);
}

/**
 * The admin bit for a chat request: an admin client_id AND an internal caller.
 * A partner-authenticated body (`_caller: 'partner'`, stamped by the worker
 * after the client spread) is never admin, whatever client_id it carries.
 */
export function callerIsAdmin(body: Pick<ChatRequest, '_caller' | 'client_id'>): boolean {
  return !isPartnerCaller(body._caller) && isAdminClient(body.client_id);
}

/**
 * client_id of every partner-key request (admin-portal#354). The SERVER sets
 * it from the key's user namespace (`pk_<hex>`, stable across rotation); the
 * partner's own client_id is discarded, so a partner can neither pose as
 * `whatsapp`/`web`/`admin-portal` nor put its own text into the prompt.
 */
export const PARTNER_CLIENT_ID_PREFIX = 'partner:';

export function partnerClientId(userNamespace: string): string {
  return `${PARTNER_CLIENT_ID_PREFIX}${userNamespace}`;
}

/**
 * True when the request was authenticated with a partner key. `_caller` is
 * the single source of truth (stamped by the worker from the auth principal,
 * after the client spread); never infer it from client_id. Absent `_caller`
 * (direct DO calls, older queued entries) means internal.
 */
export function isPartnerCaller(caller: ChatCaller | undefined): boolean {
  return caller === 'partner';
}

/**
 * Partner API keys are text-only (decided 2026-11-02, admin-portal#354): no
 * audio in, no audio out, and no tool that yields an audio URL. The ONE place
 * that decision is read from the request; the DO and orchestrator only ask
 * this function. Absent `_caller` (direct DO calls, older queued entries)
 * means internal, i.e. today's behaviour.
 */
export function callerAllowsAudio(caller: ChatCaller | undefined): boolean {
  return !isPartnerCaller(caller);
}

/**
 * Characters the admin group/thread routes accept in a chat_id or thread_id
 * path parameter: letters, digits, `_`, `.`, `-` and `:` (Telegram ids are
 * typically numeric). Partner chat_id/thread_id use the same set minus `:`
 * (services/partner-keys/policy.ts), so every partner group stays manageable
 * through those routes.
 */
export const CHAT_ID_PATTERN = /^[\w.:-]+$/;
/** Max length of a chat_id or thread_id path parameter on the admin group routes. */
export const MAX_CHAT_ID_LENGTH = 256;

/** Options for {@link validateChatBody}. */
export interface ChatValidationOptions {
  /**
   * Whether the caller may use `/api/v1/chat/callback`. Only changes the
   * wording of the callback-field rejection on /chat and /chat/stream, so a
   * partner (who cannot use the callback transport) is not pointed at it.
   * Default true.
   */
  callbackAvailable?: boolean;
  /**
   * Who authenticated. Defaults to the body's `_caller` (stamped by the
   * worker for the DO), else internal. Only a partner caller may send a
   * `partner:`-form user_id / chat_id: the worker writes that form itself
   * when it namespaces a partner request, before validation runs.
   */
  caller?: ChatCaller;
}

/**
 * An internal caller may not name a partner user or group (admin-portal#354):
 * `partner:<namespace>:...` ids are written only by the worker for partner
 * keys, and would otherwise address that partner's DOs directly.
 */
function validateNoPartnerIds(body: ChatRequest): string | null {
  const reserved = (value: unknown) =>
    typeof value === 'string' && value.startsWith(PARTNER_CLIENT_ID_PREFIX);
  if (reserved(body.user_id)) {
    return `user_id must not start with '${PARTNER_CLIENT_ID_PREFIX}' (reserved for partner API keys)`;
  }
  if (reserved(groupSegment(body))) {
    return `chat_id (joined with thread_id as in the group's name) must not start with '${PARTNER_CLIENT_ID_PREFIX}' (reserved for partner API keys)`;
  }
  return null;
}

/**
 * The group part of a group DO's name, joined exactly as resolveDOId joins
 * it: `<chat_id>:<thread_id>` when a thread_id is given, else `<chat_id>`.
 * Checked as a whole, so `chat_id: 'partner'` + `thread_id: '<ns>:g'` cannot
 * name partner group `partner:<ns>:g` either.
 */
function groupSegment(body: ChatRequest): string | undefined {
  if (typeof body.chat_id !== 'string') return undefined;
  return body.thread_id ? `${body.chat_id}:${String(body.thread_id)}` : body.chat_id;
}

/** Why a chat_id / thread_id is unusable as a group DO name segment, or null. */
export type ChatIdProblem = 'missing' | 'too_long' | 'invalid_characters';

/**
 * The ONE chat_id / thread_id shape check, shared by the admin group routes
 * (validateChatIdParam) and the partner chat policy (checkGroupId): present,
 * at most `maxLength` characters (MAX_CHAT_ID_LENGTH by default), and only
 * CHAT_ID_PATTERN characters — minus ':' when `allowColon` is false.
 */
export function chatIdProblem(
  value: string,
  opts: { maxLength?: number; allowColon?: boolean } = {}
): ChatIdProblem | null {
  if (!value) return 'missing';
  if (value.length > (opts.maxLength ?? MAX_CHAT_ID_LENGTH)) return 'too_long';
  if (!CHAT_ID_PATTERN.test(value)) return 'invalid_characters';
  if (opts.allowColon === false && value.includes(':')) return 'invalid_characters';
  return null;
}

/** Validate an optional ISO 639-1 language code. */
function validateLanguageHint(hint: unknown): string | null {
  if (hint === undefined) return null;
  if (typeof hint !== 'string' || !isValidLanguageCode(hint)) {
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
function forbidCallbackFields(
  body: ChatRequest,
  endpoint: string,
  callbackAvailable: boolean
): string | null {
  const hint = callbackAvailable
    ? 'use /api/v1/chat/callback'
    : 'progress callbacks are not available with partner API keys';
  if (body.progress_callback_url !== undefined) {
    return `progress_callback_url is not valid on ${endpoint} — ${hint}`;
  }
  if (body.progress_mode !== undefined) {
    return `progress_mode is not valid on ${endpoint} — ${hint}`;
  }
  if (body.progress_throttle_seconds !== undefined) {
    return `progress_throttle_seconds is not valid on ${endpoint} — ${hint}`;
  }
  if (body.message_key !== undefined) {
    return `message_key is not valid on ${endpoint} — ${hint}`;
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
function validateTransportFields(
  body: ChatRequest,
  transport: ChatTransport,
  callbackAvailable: boolean
): string | null {
  if (transport === 'final') return forbidCallbackFields(body, '/api/v1/chat', callbackAvailable);
  if (transport === 'stream') {
    return forbidCallbackFields(body, '/api/v1/chat/stream', callbackAvailable);
  }
  if (transport === 'callback') return requireCallbackFields(body);
  return null;
}

/**
 * Validate the optional `voice_format` field.
 *
 * Presence is checked with `!== undefined`/`!== null` (not truthiness) so
 * falsey junk (`""`, `false`, `0`) is rejected rather than silently surviving
 * to synthesis with an unsupported format. `null` is deliberately treated as
 * absent to match the `body.voice_format ?? 'opus'` default at the point of
 * use in UserDO — both mean "use the default".
 */
function validateVoiceFormat(format: unknown): string | null {
  if (format === undefined || format === null) return null;
  // Fixed message for non-strings — coercing arbitrary JSON values into the
  // error can itself throw (e.g. { toString: null } shadows the conversion
  // method), turning the promised 400 into a 500.
  if (typeof format !== 'string') {
    return 'Invalid voice_format: expected a string. Must be one of: opus, aac';
  }
  if (!VALID_VOICE_FORMATS.has(format)) {
    return `Invalid voice_format: ${format}. Must be one of: opus, aac`;
  }
  return null;
}

/** Validate the optional enum-valued fields shared by all transports. */
function validateEnumFields(body: ChatRequest): string | null {
  if (body.chat_type && !VALID_CHAT_TYPES.has(body.chat_type)) {
    return `Invalid chat_type: ${body.chat_type}. Must be one of: private, group, supergroup`;
  }
  return validateVoiceFormat(body.voice_format);
}

/**
 * Validate an optional boolean flag. `null` is treated as absent (the same
 * convention as `voice_format`), so `undefined`/`null` both mean "default".
 * Anything else that is not literally `true`/`false` is rejected — a client
 * sending `"yes"` or `1` must get a 400, not a silently-ignored flag.
 */
function validateOptionalBoolean(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') return `${field} must be a boolean`;
  return null;
}

/**
 * The client-owned-conversation fields (#392): `history`, `suppress_welcome`,
 * `suppress_memory`. `history` is private-chat only in phase 1 — group DOs
 * share memory/preferences per chat and the ownership story there is
 * unspecified, so the field is rejected rather than half-supported.
 */
function validateClientOwnedFields(body: ChatRequest, isGroup: boolean): string | null {
  const welcomeError = validateOptionalBoolean(body.suppress_welcome, 'suppress_welcome');
  if (welcomeError) return welcomeError;
  const memoryError = validateOptionalBoolean(body.suppress_memory, 'suppress_memory');
  if (memoryError) return memoryError;
  const historyError = validateClientHistory(body.history);
  if (historyError) return historyError;
  if (isGroup && hasClientHistory(body)) {
    return 'history is not supported on group/supergroup chats';
  }
  return null;
}

function validateCoreFields(body: ChatRequest): string | null {
  if (!body.user_id) return 'user_id is required';
  if (!body.client_id) return 'client_id is required';
  // is_admin is not a public field — admin origin is derived server-side by
  // callerIsAdmin(): an internal caller (`_caller`, set from the auth
  // principal) AND an admin client_id. Reject the field so older callers that
  // try to self-assert get a clear error rather than silent false-negatives.
  if ((body as unknown as Record<string, unknown>).is_admin !== undefined) {
    return 'is_admin is not a valid field; admin origin is derived server-side from the authenticated caller and client_id';
  }
  const enumError = validateEnumFields(body);
  if (enumError) return enumError;
  const isGroup = body.chat_type === 'group' || body.chat_type === 'supergroup';
  if (isGroup && !body.chat_id) return 'chat_id is required for group/supergroup chats';
  return validateClientOwnedFields(body, isGroup);
}

/** Validate chat request fields, returning an error string or null if valid. */
export function validateChatBody(
  body: ChatRequest,
  transport: ChatTransport,
  options: ChatValidationOptions = {}
): string | null {
  const coreError = validateCoreFields(body);
  if (coreError) return coreError;
  if (!isPartnerCaller(options.caller ?? body._caller)) {
    const partnerIdError = validateNoPartnerIds(body);
    if (partnerIdError) return partnerIdError;
  }

  const transportError = validateTransportFields(
    body,
    transport,
    options.callbackAvailable ?? true
  );
  if (transportError) return transportError;

  return validateLanguageHint(body.response_language_hint);
}
