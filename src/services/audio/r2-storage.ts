/**
 * R2 object storage for audio (TTS output and inbound voice submissions).
 *
 * Two key families share the `AUDIO_BUCKET` namespace, distinguished by
 * prefix:
 *
 * - **`audio/{org}/{user_id}/{uuid}.{opus|aac}`** — TTS output
 *   (assistant → user). Synthesized after every voice-out turn in the
 *   request's `voice_format` (default opus); served via
 *   `GET /api/v1/audio/:key`.
 *
 * - **`voice-submissions/{org}/{chatId|user_id}/{speaker|user_id}/{uuid}.ogg`** —
 *   Inbound voice submissions (user → assistant), archived after transcription
 *   so they can be replayed later (e.g. spoken-mode "play me Amara's story").
 *   Served via `GET /api/v1/voice-submissions/:key`. Separate route from TTS
 *   output so we can diverge on auth/cache policy later without entangling
 *   the two.
 *
 * Partner API keys (admin-portal#354): a partner's users and groups have
 * ids `partner:<ns>:<id>` (set by the worker; reserved for internal callers),
 * so their audio lives under one partner partition per org — the third key
 * segment starts with `partner:<ns>:` — and `partnerOwnsAudioKey` is the
 * one ownership rule the download routes and the audio tools apply.
 *
 * Chat history entries store only the lightweight R2 key, not the audio
 * bytes, so audio persists across page refreshes and stays well under the
 * 2 MB per-value DO storage limit.
 */

import { RequestLogger } from '../../utils/logger.js';
import { withSpan, countMetric } from '../telemetry/index.js';
import { voiceFormatSpec } from './types.js';
import type { VoiceFormat } from '../../types/engine.js';
import {
  isOwnedByPartner,
  isReservedPartnerId,
  partnerSubjectPrefix,
  splitPartnerSubject,
} from '../../types/partner-namespace.js';

/** Generate a unique R2 key for a TTS audio object. */
export function generateAudioKey(
  org: string,
  userId: string,
  format: VoiceFormat = 'opus'
): string {
  const id = crypto.randomUUID();
  return `audio/${org}/${userId}/${id}.${voiceFormatSpec(format).extension}`;
}

/** Build the public-facing URL path for an audio key. */
export function audioKeyToUrl(audioKey: string, baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/api/v1/audio/${audioKey}`;
}

/** Upload raw audio bytes to R2 with the given content type. */
export async function uploadAudio(
  bucket: R2Bucket,
  key: string,
  audioBytes: Uint8Array,
  contentType: string,
  logger: RequestLogger
): Promise<void> {
  const start = Date.now();
  try {
    // Span carries only the bounded size; the key embeds org/user ids and never egresses.
    await withSpan('r2.put', { size_bytes: audioBytes.byteLength }, () =>
      bucket.put(key, audioBytes, { httpMetadata: { contentType } })
    );
  } catch (error) {
    countMetric('r2_operations_total', {
      op: 'put',
      status: 'error',
      error_name: error instanceof Error ? error.name : 'Error',
    });
    logger.error('r2_audio_upload_failed', error, {
      key,
      size_bytes: audioBytes.byteLength,
      upload_ms: Date.now() - start,
    });
    throw error;
  }
  countMetric('r2_operations_total', { op: 'put', status: 'success' });
  logger.log('r2_audio_uploaded', {
    key,
    size_bytes: audioBytes.byteLength,
    upload_ms: Date.now() - start,
  });
}

/** Fetch audio from R2. Returns null if not found. */
export async function getAudio(
  bucket: R2Bucket,
  key: string,
  logger: RequestLogger
): Promise<R2ObjectBody | null> {
  const start = Date.now();
  let object: R2ObjectBody | null;
  try {
    object = await withSpan('r2.get', {}, () => bucket.get(key));
  } catch (error) {
    countMetric('r2_operations_total', {
      op: 'get',
      status: 'error',
      error_name: error instanceof Error ? error.name : 'Error',
    });
    logger.error('r2_audio_get_failed', error, { key, get_ms: Date.now() - start });
    throw error;
  }
  if (!object) {
    countMetric('r2_operations_total', { op: 'get', status: 'not_found' });
    logger.warn('r2_audio_not_found', { key, get_ms: Date.now() - start });
    return null;
  }
  countMetric('r2_operations_total', { op: 'get', status: 'success' });
  logger.log('r2_audio_retrieved', { key, size: object.size, get_ms: Date.now() - start });
  return object;
}

// ── Voice submissions (inbound user audio) ──────────────────────────────────

/** R2 key prefix for archived inbound voice messages. Stable contract. */
export const VOICE_SUBMISSION_PREFIX = 'voice-submissions';

/**
 * Generate a unique R2 key for an inbound voice submission.
 *
 * `chatScope` is the chat-level partition: the group `chat_id` for group
 * chats, or the user id for private chats (where there is no separate chat
 * scope). `speakerScope` is the per-speaker partition: the display speaker
 * name for group chats (sanitized to a URL-safe slug), or the user id when
 * no speaker name is supplied. Both fields are sanitized to a strict
 * `[a-zA-Z0-9._-]` set so they round-trip through the URL path cleanly and
 * cannot escape the org's prefix.
 */
export function generateVoiceSubmissionKey(
  org: string,
  chatScope: string,
  speakerScope: string
): string {
  const id = crypto.randomUUID();
  return `${VOICE_SUBMISSION_PREFIX}/${org}/${chatSegment(chatScope)}/${slugSegment(speakerScope)}/${id}.ogg`;
}

/**
 * The chat segment of a voice-submission key. A partner chat scope
 * (`partner:<ns>:<id>`) keeps its `partner:<ns>:` prefix and slugs only the
 * rest, so the key stays in that partner's partition; slugSegment never
 * emits ':', so no other scope can produce that prefix.
 */
function chatSegment(chatScope: string): string {
  const partner = splitPartnerSubject(chatScope);
  if (!partner) return slugSegment(chatScope);
  return `${partnerSubjectPrefix(partner.namespace)}${slugSegment(partner.rest)}`;
}

/**
 * THE partner audio ownership rule: true only for a TTS key
 * (`audio/<org>/<user>/<file>`, 4 segments) or a voice-submission key
 * (`voice-submissions/<org>/<chat>/<speaker>/<file>`, 5 segments) in the
 * key's org whose owner segment (user / chat) starts with `partner:<ns>:`.
 * The exact segment count stops an id or org containing '/' from shifting
 * segments: partner ids never contain '/', and their org is the key's
 * validated org. Internal ids may not start with `partner:` (reserved), so
 * an internal user's or group's audio never matches.
 */
export function partnerOwnsAudioKey(key: string, org: string, namespace: string): boolean {
  const parts = key.split('/');
  const expected = parts[0] === 'audio' ? 4 : parts[0] === VOICE_SUBMISSION_PREFIX ? 5 : Number.NaN;
  return (
    parts.length === expected && parts[1] === org && isOwnedByPartner(parts[2] ?? '', namespace)
  );
}

/**
 * Where an existing audio key lives once its conversation moves into a
 * partner partition (the legacy import): same family and file, the key's
 * org, and the owner segment for `subject` (the user id) in namespace `ns` —
 * exactly the key the chat flow would have written for that partner user.
 * Null for a key that is not a TTS or voice-submission key.
 */
export function partnerAudioKeyFor(
  key: string,
  target: { org: string; namespace: string; subject: string }
): string | null {
  const parts = key.split('/');
  const owner = `${partnerSubjectPrefix(target.namespace)}${target.subject}`;
  if (parts[0] === 'audio' && parts.length === 4) {
    return ['audio', target.org, owner, parts[3]].join('/');
  }
  if (parts[0] === VOICE_SUBMISSION_PREFIX && parts.length === 5) {
    const chat = partnerVoiceSubmissionOwner(target);
    return [VOICE_SUBMISSION_PREFIX, target.org, chat, parts[3], parts[4]].join('/');
  }
  return null;
}

/**
 * The owner segment of `target`'s voice-submission copies (partnerAudioKeyFor).
 * It is slugged, so two distinct subjects (`Ann B`, `Ann-B`) can share it:
 * their copies of the same recording land on the same key.
 */
export function partnerVoiceSubmissionOwner(target: {
  namespace: string;
  subject: string;
}): string {
  return chatSegment(`${partnerSubjectPrefix(target.namespace)}${target.subject}`);
}

/** True when a voice-submission key sits in some partner's partition. */
export function isPartnerVoiceSubmissionKey(key: string): boolean {
  return isReservedPartnerId(key.split('/')[2] ?? '');
}

/** Build the public-facing URL path for a voice-submission R2 key. */
export function voiceSubmissionKeyToUrl(key: string, baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/api/v1/voice-submissions/${key}`;
}

/**
 * Upload raw inbound-voice bytes to R2 with the supplied content-type.
 *
 * Mirrors `uploadAudio` but accepts the source MIME so non-ogg uploads
 * (e.g. an `audio/mpeg` voice message from a future gateway) retain their
 * original content-type on retrieval.
 */
export async function uploadVoiceSubmission(
  bucket: R2Bucket,
  key: string,
  audioBytes: Uint8Array,
  mimeType: string,
  logger: RequestLogger
): Promise<void> {
  const start = Date.now();
  try {
    await withSpan('r2.put', { size_bytes: audioBytes.byteLength }, () =>
      bucket.put(key, audioBytes, { httpMetadata: { contentType: mimeType } })
    );
  } catch (error) {
    countMetric('r2_operations_total', {
      op: 'put',
      status: 'error',
      error_name: error instanceof Error ? error.name : 'Error',
    });
    logger.error('r2_voice_submission_upload_failed', error, {
      key,
      size_bytes: audioBytes.byteLength,
      mime_type: mimeType,
      upload_ms: Date.now() - start,
    });
    throw error;
  }
  countMetric('r2_operations_total', { op: 'put', status: 'success' });
  logger.log('r2_voice_submission_uploaded', {
    key,
    size_bytes: audioBytes.byteLength,
    mime_type: mimeType,
    upload_ms: Date.now() - start,
  });
}

/**
 * Sanitize a path segment for an R2 key. Allowed: alphanumerics, dot, dash,
 * underscore. Anything else collapses to `-`. Empty result falls back to
 * `unknown` so the key is always well-formed.
 */
function slugSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'unknown';
}
