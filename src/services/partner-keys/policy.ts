/**
 * What a partner API key may do (admin-portal#354).
 *
 * Three rules, each kept in one function so it is easy to find and change:
 *
 * 1. isPartnerRouteAllowed — a partner key reaches ONLY the two end-user chat
 *    endpoints and the two audio download routes (the latter only for its own
 *    users' and groups' audio: partnerOwnsAudioKey, enforced by the routes).
 *    Everything else under /api/* (admin, callback transport, path-addressed
 *    user preferences/history) is denied by default.
 * 2. applyPartnerChatPolicy — on those chat endpoints the body is locked to
 *    the key: org is the key's org, client_id is set by the server (so a
 *    partner can neither claim another platform nor put its own text in the
 *    prompt) and identifiers are bounded single-line strings. Audio in and
 *    out works as for internal callers, with the same limits. progress_callback_url needs no rule here:
 *    validateChatBody already rejects it on /chat and /chat/stream, the only
 *    routes a partner key reaches (the DO would send ENGINE_API_KEY to it; #40).
 * 3. scopePartnerSubject — end-user ids are namespaced per partner so one
 *    partner can never address another tenant's (or a WhatsApp user's)
 *    Durable Object. PROPOSAL pending team answer (portal#354 question 6).
 */

import type { PartnerKeyRecord } from '../../types/partner-keys.js';
import type { ChatRequest } from '../../types/engine.js';
import { codePointLength, hasLineBreakOrControl } from '../../types/single-line.js';
import {
  chatIdProblem,
  isPathAddressableUserId,
  MAX_CHAT_ID_LENGTH,
  USER_PATH_UNSAFE_CHARACTERS,
} from '../../utils/chat-validation.js';
import { partnerClientId, scopePartnerSubject } from '../../types/partner-namespace.js';

/** Who made an /api/* request, as established by the auth middleware. */
export type Principal = { kind: 'internal' } | { kind: 'partner'; key: PartnerKeyRecord };

/** The id that goes on logs: the partner key id, or "internal" for ENGINE_API_KEY. */
export function principalKeyId(principal: Principal | undefined): string {
  return principal?.kind === 'partner' ? principal.key.id : 'internal';
}

/**
 * Exact method + path pairs a partner key may call. Exact match (no prefix or
 * pattern) so a new route is never reachable by a partner key by accident.
 */
const PARTNER_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/v1/chat',
  'POST /api/v1/chat/stream',
]);

/**
 * GET prefixes a partner key may read: the audio download routes. Each route
 * serves a partner key ONLY audio in that partner's own partition
 * (partnerOwnsAudioKey); anything else answers like a missing object.
 */
const PARTNER_AUDIO_PREFIXES: readonly string[] = ['/api/v1/audio/', '/api/v1/voice-submissions/'];

export function isPartnerRouteAllowed(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (PARTNER_ROUTES.has(`${verb} ${path}`)) return true;
  return verb === 'GET' && PARTNER_AUDIO_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * PROPOSAL (portal#354 Q6): the identity a partner end user has inside the
 * worker, `partner:<ns>:<user_id>` (types/partner-namespace.ts holds the
 * scheme). The prefix is set server-side, never by the caller, so no other
 * partner key can produce it.
 */
export { scopePartnerSubject };

export type PartnerPolicyRejection = {
  status: 400 | 403;
  /** Machine-readable reason for logs/metrics. */
  reason: string;
  error: string;
};

export type PartnerPolicyResult =
  { ok: true; body: ChatRequest } | { ok: false; rejection: PartnerPolicyRejection };

function reject(status: 400 | 403, reason: string, error: string): PartnerPolicyResult {
  return { ok: false, rejection: { status, reason, error } };
}

/**
 * True when a body field is present with a value. `null` counts as absent,
 * matching resolveOrgFromBody (`??`) and validateVoiceFormat (null = default).
 */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Org forcing. A body may omit org (the key's org applies) or name the key's
 * org; any other value is a 400 rather than a silent override, so a partner
 * that believes it is talking to org X never quietly gets org Y's config.
 */
function checkOrg(body: Record<string, unknown>, keyOrg: string): PartnerPolicyResult | null {
  const mismatched =
    isPresent(body.org) && body.org !== keyOrg
      ? 'org'
      : isPresent(body.org_id) && body.org_id !== keyOrg
        ? 'org_id'
        : null;
  if (mismatched === null) return null;
  return reject(
    400,
    'partner_org_mismatch',
    `${mismatched} must be omitted or equal this API key's org ('${keyOrg}')`
  );
}

/**
 * A partner's chat_id / thread_id name a group DO and must stay manageable
 * through the admin group routes, so they use the characters those routes
 * accept (CHAT_ID_PATTERN) MINUS ':', and fit their length limit once stored:
 * chat_id is stored as `partner:<ns>:<chat_id>`, so it gets 256 minus that
 * prefix; thread_id is stored as sent. Group DO names are
 * `group:<org>:<chat_id>[:<thread_id>]` (resolveDOId), so a ':' could make two
 * different (chat, thread) pairs produce the same name — `a:b` + `c` vs
 * `a` + `b:c`. (user_id is the last segment of its DO name, so it cannot
 * collide that way and keeps the general single-line rule.)
 */
function maxGroupIdLength(field: 'chat_id' | 'thread_id', key: PartnerKeyRecord): number {
  const prefix = field === 'chat_id' ? scopePartnerSubject(key, '').length : 0;
  return MAX_CHAT_ID_LENGTH - prefix;
}

/**
 * A non-empty single-line string of at most MAX_CHAT_ID_LENGTH (256) code
 * points, with no leading or trailing whitespace (refused, never trimmed:
 * ` alice` and `alice` would otherwise be two different users).
 */
export function isValidPartnerIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    codePointLength(value) <= MAX_CHAT_ID_LENGTH &&
    !hasLineBreakOrControl(value)
  );
}

/**
 * A partner user_id: a valid identifier that also stays addressable as the
 * `:userId` segment of the user routes (no USER_PATH_UNSAFE_CHARACTERS).
 */
export function isValidPartnerUserId(value: unknown): value is string {
  return isValidPartnerIdentifier(value) && isPathAddressableUserId(value);
}

/** user_id beyond the general rule: addressable in the user routes. */
function checkUserIdPath(value: unknown): PartnerPolicyResult | null {
  if (typeof value !== 'string' || isPathAddressableUserId(value)) return null;
  const listed = USER_PATH_UNSAFE_CHARACTERS.map((char) => `'${char}'`).join(', ');
  return reject(
    400,
    'partner_user_id',
    `user_id must not contain ${listed}: it must stay addressable in the /users/:userId routes`
  );
}

/** An identifier field: absent/null, or a bounded single-line non-empty string. */
function checkIdentifier(
  value: unknown,
  field: 'user_id' | 'chat_id' | 'thread_id',
  required: boolean
): PartnerPolicyResult | null {
  if (!isPresent(value) && !required) return null;
  if (isValidPartnerIdentifier(value)) return null;
  return reject(
    400,
    `partner_${field}`,
    `${field} ${required ? 'is required and ' : ''}must be a non-empty single-line string of at most ${MAX_CHAT_ID_LENGTH} characters, without leading or trailing whitespace`
  );
}

/** chat_id / thread_id beyond the general rule: admin-route characters minus ':', and length. */
function checkGroupId(
  value: unknown,
  field: 'chat_id' | 'thread_id',
  key: PartnerKeyRecord
): PartnerPolicyResult | null {
  if (typeof value !== 'string') return null;
  const max = maxGroupIdLength(field, key);
  const problem = chatIdProblem(value, { maxLength: max, allowColon: false });
  if (problem === null) return null;
  const error =
    problem === 'too_long'
      ? `${field} must be at most ${max} characters`
      : `${field} may contain only letters, digits, '_', '.' and '-' (no ':' or other characters)`;
  return reject(400, `partner_${field}`, error);
}

/**
 * Identifiers must be bounded single-line strings for partners: user_id and
 * chat_id so the namespacing below always applies, and all three because they
 * reach DO names and logs. (Internal callers keep validateChatBody's rules.)
 */
function checkIdentifiers(
  body: Record<string, unknown>,
  key: PartnerKeyRecord
): PartnerPolicyResult | null {
  return (
    checkIdentifier(body.user_id, 'user_id', true) ??
    checkUserIdPath(body.user_id) ??
    checkIdentifier(body.chat_id, 'chat_id', false) ??
    checkIdentifier(body.thread_id, 'thread_id', false) ??
    checkGroupId(body.chat_id, 'chat_id', key) ??
    checkGroupId(body.thread_id, 'thread_id', key) ??
    checkSpeakerType(body.speaker)
  );
}

/** Longest `speaker` a partner may send (code points); the UserDO then stores it cut to 64. */
export const MAX_PARTNER_SPEAKER_LENGTH = 256;

/**
 * `speaker` is optional text (`null` = absent) of at most 256 code points;
 * normalizeSpeaker / sanitizeSpeaker do the rest.
 */
function checkSpeakerType(speaker: unknown): PartnerPolicyResult | null {
  if (!isPresent(speaker)) return null;
  if (typeof speaker !== 'string') {
    return reject(400, 'partner_speaker', 'speaker must be a string');
  }
  if (codePointLength(speaker) > MAX_PARTNER_SPEAKER_LENGTH) {
    return reject(
      400,
      'partner_speaker',
      `speaker must be at most ${MAX_PARTNER_SPEAKER_LENGTH} characters`
    );
  }
  return null;
}

/**
 * Apply the partner rules to a parsed chat body (already known to be a JSON
 * object: the chat handler rejects anything else for every caller). On
 * success returns a NEW body; the input is untouched:
 * - org forced to the key's org; client_id set by the server;
 * - user_id / chat_id namespaced;
 * - org_id and a null chat_id dropped (audio fields pass through unchanged).
 * `speaker` is bounded here (256); the UserDO normalizes a partner's speaker (normalizeSpeaker).
 */
export function applyPartnerChatPolicy(
  raw: Record<string, unknown>,
  key: PartnerKeyRecord
): PartnerPolicyResult {
  const failure = checkOrg(raw, key.org) ?? checkIdentifiers(raw, key);
  if (failure) return failure;

  const { org_id: _orgId, chat_id: _chatId, ...rest } = raw;
  const scoped: Record<string, unknown> = {
    ...rest,
    org: key.org,
    client_id: partnerClientId(key.userNamespace),
    user_id: scopePartnerSubject(key, raw.user_id as string),
    ...(typeof raw.chat_id === 'string' ? { chat_id: scopePartnerSubject(key, raw.chat_id) } : {}),
  };
  return { ok: true, body: scoped as unknown as ChatRequest };
}
