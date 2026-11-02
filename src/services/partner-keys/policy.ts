/**
 * What a partner API key may do (admin-portal#354).
 *
 * Three rules, each kept in one function so it is easy to find and change:
 *
 * 1. isPartnerRouteAllowed — a partner key reaches ONLY the two end-user chat
 *    endpoints. Everything else under /api/* (admin, callback transport,
 *    path-addressed user preferences/history, audio) is denied by default.
 * 2. applyPartnerChatPolicy — on those chat endpoints the body is locked to
 *    the key: org is the key's org, the admin client id is refused, and audio
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
import { isAdminClient } from '../../utils/chat-validation.js';

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

/** Refusals that do not depend on the key's identity. */
function checkForbiddenFields(body: Record<string, unknown>): PartnerPolicyResult | null {
  if (isAdminClient(typeof body.client_id === 'string' ? body.client_id : undefined)) {
    return reject(403, 'partner_admin_client', `client_id '${String(body.client_id)}' is reserved`);
  }
  return checkAudio(body);
}

/**
 * Subject ids must be non-empty strings for partners so the namespacing in
 * applyPartnerChatPolicy always applies (internal callers keep today's looser
 * truthiness check in validateChatBody).
 */
function checkSubjectTypes(body: Record<string, unknown>): PartnerPolicyResult | null {
  if (typeof body.user_id !== 'string' || body.user_id.length === 0) {
    return reject(400, 'partner_user_id', 'user_id is required and must be a non-empty string');
  }
  if (isPresent(body.chat_id) && (typeof body.chat_id !== 'string' || !body.chat_id)) {
    return reject(400, 'partner_chat_id', 'chat_id must be a non-empty string');
  }
  return null;
}

/**
 * Apply the partner rules to a parsed chat body. On success returns a NEW
 * body with org forced and user_id/chat_id namespaced; the input is untouched.
 */
export function applyPartnerChatPolicy(body: unknown, key: PartnerKeyRecord): PartnerPolicyResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return reject(400, 'partner_body_shape', 'Request body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const failure = checkForbiddenFields(raw) ?? checkOrg(raw, key.org) ?? checkSubjectTypes(raw);
  if (failure) return failure;

  // org_id is replaced by the forced org; voice_format is ignored (no TTS for
  // partners); chat_id is re-added below only when present (null = absent).
  const { org_id: _orgId, voice_format: _voiceFormat, chat_id: _chatId, ...rest } = raw;
  const scoped: Record<string, unknown> = {
    ...rest,
    org: key.org,
    user_id: scopePartnerSubject(key, raw.user_id as string),
  };
  if (typeof raw.chat_id === 'string') {
    scoped.chat_id = scopePartnerSubject(key, raw.chat_id);
  }
  return { ok: true, body: scoped as unknown as ChatRequest };
}
