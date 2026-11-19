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
import { orgDoNameError, resolveOrgFromBody } from './org.js';
import { isReservedPartnerId, PARTNER_PREFIX } from '../types/partner-namespace.js';

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
 * source (e.g. bt-servant-admin-portal/worker/chat.ts sets
 * `client_id: "admin-portal"` on every chat relay). client_id alone is not
 * trusted: the worker grants admin visibility only when the request also
 * authenticated with a super-admin key (src/utils/admin-auth.ts), and passes
 * the result to the DO as the server-set `_is_admin` body field. A partner
 * API key (admin-portal#354) is never super-admin, and for partner requests
 * the client_id is not the partner's at all: the worker replaces it with a
 * server-set `partner:<userNamespace>` (see {@link partnerClientId}), so it
 * can never name an admin client in the first place.
 */
const ADMIN_CLIENT_IDS: ReadonlySet<string> = new Set(['admin-portal']);

/** True when `clientId` names an admin-capable client. Not sufficient on its own: the worker also requires a super-admin key (`_is_admin`). */
export function isAdminClient(clientId: string | undefined): boolean {
  return clientId !== undefined && ADMIN_CLIENT_IDS.has(clientId);
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
  if (isReservedPartnerId(body.user_id)) return reservedPartnerIdError('user_id');
  const isGroup = body.chat_type === 'group' || body.chat_type === 'supergroup';
  // The group segment names a DO only for group chats (resolveDOId).
  if (isGroup && isReservedPartnerId(groupSegment(body))) {
    return reservedPartnerIdError("chat_id (joined with thread_id as in the group's name)");
  }
  return null;
}

/** The 400 message for a reserved id in `field`. */
export function reservedPartnerIdError(field: string): string {
  return `${field} must not start with '${PARTNER_PREFIX}' (reserved for partner API keys)`;
}

/**
 * Characters a user id may not contain if it must stay addressable as the
 * `:userId` path segment of the user routes (`/orgs/:org/users/:userId/...`,
 * admin and non-admin). Those routes have no character validator: Hono
 * percent-decodes the segment, so any id works when its caller encodes it.
 * But `/` `?` `#` `\` change the URL's structure and `%` changes its
 * decoding whenever a caller builds the path without encoding the id (the
 * admin portal's chat history/memory proxies do), so partner user ids
 * exclude them.
 */
export const USER_PATH_UNSAFE_CHARACTERS: readonly string[] = ['/', '?', '#', '%', '\\'];

/** True when `value` contains no USER_PATH_UNSAFE_CHARACTERS. */
export function isPathAddressableUserId(value: string): boolean {
  return !USER_PATH_UNSAFE_CHARACTERS.some((char) => value.includes(char));
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
  const shareQrError = validateOptionalBoolean(body.accepts_share_qr, 'accepts_share_qr');
  if (shareQrError) return shareQrError;
  const historyError = validateClientHistory(body.history);
  if (historyError) return historyError;
  if (isGroup && hasClientHistory(body)) {
    return 'history is not supported on group/supergroup chats';
  }
  return null;
}

/**
 * Body fields that address a conversation: they pick the Durable Object
 * (`user:<org>:<user_id>`, `group:<org>:<chat_id>[:<thread_id>]`, chosen by
 * chat_type) or build an id the worker trusts (client_id, the partner
 * namespace). Each must be a primitive string when present (null counts as
 * absent).
 */
export const CONVERSATION_ADDRESS_FIELDS: readonly string[] = [
  'user_id',
  'chat_id',
  'thread_id',
  'org',
  'org_id',
  'chat_type',
  'client_id',
];

/**
 * THE runtime type check for conversation-address fields, run on every chat
 * body before any authorization check or routing (readChatBodyObject in the
 * worker) and again by validateChatBody. Every check after it compares
 * strings, but DO names are built by string interpolation, which would turn
 * an array such as `["partner:<ns>:alice"]` into the very string the
 * reserved-id checks refuse. So anything that is not a string (array,
 * object, number, boolean) is a 400 here, for every caller. Returns the 400
 * message, or null.
 */
export function conversationAddressError(body: object): string | null {
  for (const field of CONVERSATION_ADDRESS_FIELDS) {
    const value: unknown = Reflect.get(body, field);
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `${field} must be a string`;
    }
  }
  return null;
}

function validateCoreFields(body: ChatRequest): string | null {
  const addressError = conversationAddressError(body);
  if (addressError) return addressError;
  if (!body.user_id) return 'user_id is required';
  if (!body.client_id) return 'client_id is required';
  // is_admin is not a public field — admin origin is derived server-side (the
  // worker-set `_is_admin`: an admin client_id AND a super-admin key; never a
  // partner key). Reject the field so older callers that try to self-assert
  // get a clear error rather than silent false-negatives.
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
  const orgError = orgDoNameError(resolveOrgFromBody(body, ''));
  if (orgError) return orgError;
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
