/**
 * R2 object storage for audio (TTS output and inbound voice submissions).
 *
 * Two key families share the `AUDIO_BUCKET` namespace, distinguished by
 * prefix:
 *
 * - **`audio/{org}/{user_id}/{uuid}.opus`** — TTS output (assistant → user).
 *   Synthesized after every voice-out turn; served via
 *   `GET /api/v1/audio/:key`.
 *
 * - **`voice-submissions/{org}/{chatId|user_id}/{speaker|user_id}/{uuid}.ogg`** —
 *   Inbound voice submissions (user → assistant), archived after transcription
 *   so they can be replayed later (e.g. spoken-mode "play me Amara's story").
 *   Served via `GET /api/v1/voice-submissions/:key`. Separate route from TTS
 *   output so we can diverge on auth/cache policy later without entangling
 *   the two.
 *
 * Chat history entries store only the lightweight R2 key, not the audio
 * bytes, so audio persists across page refreshes and stays well under the
 * 2 MB per-value DO storage limit.
 */

import { RequestLogger } from '../../utils/logger.js';

/** Generate a unique R2 key for a TTS audio object. */
export function generateAudioKey(org: string, userId: string): string {
  const id = crypto.randomUUID();
  return `audio/${org}/${userId}/${id}.opus`;
}

/** Build the public-facing URL path for an audio key. */
export function audioKeyToUrl(audioKey: string, baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/api/v1/audio/${audioKey}`;
}

/** Upload raw audio bytes to R2. */
export async function uploadAudio(
  bucket: R2Bucket,
  key: string,
  audioBytes: Uint8Array,
  logger: RequestLogger
): Promise<void> {
  const start = Date.now();
  await bucket.put(key, audioBytes, {
    httpMetadata: { contentType: 'audio/ogg' },
  });
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
  const object = await bucket.get(key);
  if (!object) {
    logger.warn('r2_audio_not_found', { key, get_ms: Date.now() - start });
    return null;
  }
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
  return `${VOICE_SUBMISSION_PREFIX}/${org}/${slugSegment(chatScope)}/${slugSegment(speakerScope)}/${id}.ogg`;
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
  await bucket.put(key, audioBytes, {
    httpMetadata: { contentType: mimeType },
  });
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
