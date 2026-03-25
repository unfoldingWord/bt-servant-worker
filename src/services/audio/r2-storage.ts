/**
 * R2 object storage for TTS audio.
 *
 * Audio is uploaded after synthesis and served via an authenticated worker
 * endpoint. Chat history entries store only the lightweight R2 key, not the
 * audio bytes, so audio persists across page refreshes and stays well under
 * the 2 MB per-value DO storage limit.
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
