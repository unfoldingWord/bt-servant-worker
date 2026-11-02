/**
 * What a partner API key may do (admin-portal#354).
 *
 * Three rules, each kept in one function so it is easy to find and change:
 *
 * 1. isPartnerRouteAllowed — a partner key reaches ONLY the two end-user chat
 *    endpoints. Everything else under /api/* (admin, callback transport,
 *    path-addressed user preferences/history, audio) is denied by default.
 * 2. applyPartnerChatPolicy — on those chat endpoints the body is locked to
 *    the key: org is the key's org, client_id is set by the server (so a
 *    partner can neither claim another platform nor put its own text in the
 *    prompt), identifiers are bounded, speaker is neutralised, and audio
 *    requests are refused (their replies are URLs under /api/v1/audio/*, which
 *    a partner key cannot fetch). progress_callback_url needs no rule here:
 *    validateChatBody already rejects it on /chat and /chat/stream, the only
 *    routes a partner key reaches (the DO would send ENGINE_API_KEY to it; #40).
 * 3. scopePartnerSubject — end-user ids are namespaced per partner so one
 *    partner can never address another tenant's (or a WhatsApp user's)
 *    Durable Object. PROPOSAL pending team answer (portal#354 question 6).
 */

import type { PartnerKeyRecord } from '../../types/partner-keys.js';
import type { ChatRequest } from '../../types/engine.js';
import { stripControlChars } from '../../types/prompt-overrides.js';
import { partnerClientId } from '../../utils/chat-validation.js';

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

export function isPartnerRouteAllowed(method: string, path: string): boolean {
  return PARTNER_ROUTES.has(`${method.toUpperCase()} ${path}`);
}

/**
 * PROPOSAL (portal#354 Q6): the identity a partner end user has inside the
 * worker. Prefixing with the key's user namespace (stable across rotation)
 * makes the DO name `user:{org}:partner:{ns}:{user_id}`, which no other
 * partner key can produce because the prefix is set server-side, never by the
 * caller. Change this one function if the team picks a different scheme.
 */
export function scopePartnerSubject(key: PartnerKeyRecord, subject: string): string {
  return `partner:${key.userNamespace}:${subject}`;
}

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
 * Body fields that send audio IN. Partner keys are text-only (by default,
 * 2026-11-02): a voice message would be transcribed, archived under
 * /api/v1/voice-submissions/* and answered with TTS, none of which a partner
 * key can use, so the request is refused up front. `voice_format` only shapes
 * audio OUT, which partners never get (callerAllowsAudio), so it is dropped
 * rather than refused — see applyPartnerChatPolicy.
 */
const AUDIO_INPUT_FIELDS = ['audio_base64', 'audio_format'] as const;

function checkAudio(body: Record<string, unknown>): PartnerPolicyResult | null {
  const field =
    body.message_type === 'audio'
      ? 'message_type "audio"'
      : AUDIO_INPUT_FIELDS.find((name) => isPresent(Reflect.get(body, name)));
  if (field === undefined) return null;
  return reject(
    400,
    'partner_audio',
    `${field} is not available with partner API keys; send text messages (message_type "text")`
  );
}

/** Max length of a partner-supplied identifier (user_id, chat_id, thread_id). */
export const MAX_PARTNER_ID_LENGTH = 256;
/** Max length of a partner-supplied speaker name after neutralising. */
export const MAX_PARTNER_SPEAKER_LENGTH = 64;

/**
 * C1 controls (U+0080–U+009F, which include NEL U+0085) and the Unicode line
 * and paragraph separators. Treated exactly like C0 controls and \r \n \t:
 * each can break a line in some renderer or model tokenizer.
 */
const C1_AND_LINE_SEPARATORS = /[\u0080-\u009f\u2028\u2029]/g;

/** True when `value` contains a C0/C1 control or any line-break character. */
function hasControlOrLineBreak(value: string): boolean {
  return (
    stripControlChars(value) !== value ||
    /[\r\n\t]/.test(value) ||
    new RegExp(C1_AND_LINE_SEPARATORS.source).test(value)
  );
}

/** An identifier field: absent/null, or a bounded single-line non-empty string. */
function checkIdentifier(
  value: unknown,
  field: 'user_id' | 'chat_id' | 'thread_id',
  required: boolean
): PartnerPolicyResult | null {
  if (!isPresent(value) && !required) return null;
  const valid =
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PARTNER_ID_LENGTH &&
    !hasControlOrLineBreak(value);
  if (valid) return null;
  return reject(
    400,
    `partner_${field}`,
    `${field} ${required ? 'is required and ' : ''}must be a non-empty single-line string of at most ${MAX_PARTNER_ID_LENGTH} characters`
  );
}

/**
 * Identifiers must be bounded single-line strings for partners: user_id and
 * chat_id so the namespacing below always applies, and all three because they
 * reach DO names and logs. (Internal callers keep validateChatBody's rules.)
 */
function checkIdentifiers(body: Record<string, unknown>): PartnerPolicyResult | null {
  return (
    checkIdentifier(body.user_id, 'user_id', true) ??
    checkIdentifier(body.chat_id, 'chat_id', false) ??
    checkIdentifier(body.thread_id, 'thread_id', false)
  );
}

/**
 * A partner's speaker name reaches the system prompt and the history prefix.
 * Neutralise it: control characters removed, every whitespace run (newlines
 * included) collapsed to one space, capped. Non-strings and names that end up
 * empty are dropped. A name can therefore never start a new prompt line.
 */
export function neutralizePartnerSpeaker(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = stripControlChars(value)
    .replace(C1_AND_LINE_SEPARATORS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.slice(0, MAX_PARTNER_SPEAKER_LENGTH).trim() || undefined;
}

/**
 * Apply the partner rules to a parsed chat body (already known to be a JSON
 * object: the chat handler rejects anything else for every caller). On
 * success returns a NEW body; the input is untouched:
 * - org forced to the key's org; client_id set by the server;
 * - user_id / chat_id namespaced; speaker neutralised;
 * - org_id, voice_format (no TTS for partners) and null chat_id/speaker dropped.
 */
export function applyPartnerChatPolicy(
  raw: Record<string, unknown>,
  key: PartnerKeyRecord
): PartnerPolicyResult {
  const failure = checkAudio(raw) ?? checkOrg(raw, key.org) ?? checkIdentifiers(raw);
  if (failure) return failure;

  const {
    org_id: _orgId,
    voice_format: _voiceFormat,
    chat_id: _chatId,
    speaker: _speaker,
    ...rest
  } = raw;
  const speaker = neutralizePartnerSpeaker(raw.speaker);
  const scoped: Record<string, unknown> = {
    ...rest,
    org: key.org,
    client_id: partnerClientId(key.userNamespace),
    user_id: scopePartnerSubject(key, raw.user_id as string),
    ...(typeof raw.chat_id === 'string' ? { chat_id: scopePartnerSubject(key, raw.chat_id) } : {}),
    ...(speaker !== undefined ? { speaker } : {}),
  };
  return { ok: true, body: scoped as unknown as ChatRequest };
}
