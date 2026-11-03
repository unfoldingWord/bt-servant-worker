/**
 * Legacy import, audio (admin-portal#354). A copied conversation's history
 * points at R2 audio by key: `voice_audio_key` (TTS replies, `audio/...`)
 * and `inbound_voice_audio_key` (archived voice messages,
 * `voice-submissions/...`). Those keys name the shared-key user, so a partner
 * key could never download them (partnerOwnsAudioKey). For each referenced
 * object this copies it into the partner partition (partnerAudioKeyFor: same
 * family and file, owner `partner:<ns>:<user_id>`) and rewrites the key in
 * the copied history. The source objects are never changed or deleted.
 *
 * A missing object, or one whose copy fails, keeps its history entry but
 * loses that audio key (logged; counted as `missing` / `failed`), so the
 * imported history never points outside the partner partition.
 */

import { partnerAudioKeyFor } from '../audio/index.js';
import type { RequestLogger } from '../../utils/logger.js';

/** The history fields that hold an R2 audio key. */
const AUDIO_KEY_FIELDS = ['voice_audio_key', 'inbound_voice_audio_key'] as const;
/** Storage key of the history list in a UserDO. */
const HISTORY_KEY = 'history';
/** Objects copied at once. */
const COPY_CONCURRENCY = 5;

export type AudioCopyCounts = { copied: number; failed: number; missing: number };

export type AudioTarget = { org: string; namespace: string; subject: string };

type Outcome = { key: string | null; result: keyof AudioCopyCounts };

/**
 * Copy the audio referenced by `entries`' history into the partner partition
 * and return the entries with the keys rewritten, plus the counts and the
 * new keys written (so a refused import can remove them again).
 */
export async function rehomeHistoryAudio(
  bucket: R2Bucket,
  entries: [string, unknown][],
  target: AudioTarget,
  logger: RequestLogger
): Promise<{ entries: [string, unknown][]; counts: AudioCopyCounts; written: string[] }> {
  const history = entries.find(([name]) => name === HISTORY_KEY)?.[1];
  const counts: AudioCopyCounts = { copied: 0, failed: 0, missing: 0 };
  if (!Array.isArray(history)) return { entries, counts, written: [] };
  const outcomes = await copyAll(bucket, referencedKeys(history), target, logger);
  for (const outcome of outcomes.values()) {
    if (outcome.result === 'copied') counts.copied += 1;
    else if (outcome.result === 'missing') counts.missing += 1;
    else counts.failed += 1;
  }
  const rewritten = history.map((item: unknown) => rewriteEntry(item, outcomes));
  const written = [...outcomes.values()].flatMap((o) =>
    o.result === 'copied' && o.key ? [o.key] : []
  );
  return {
    entries: entries.map(([name, value]) => [name, name === HISTORY_KEY ? rewritten : value]),
    counts,
    written,
  };
}

/** Remove objects written for an import that was then refused (best effort, logged). */
export async function removeRehomedAudio(
  bucket: R2Bucket,
  written: string[],
  logger: RequestLogger
): Promise<void> {
  if (written.length === 0) return;
  try {
    await bucket.delete(written);
  } catch (error) {
    logger.error('partner_key_legacy_import_audio_cleanup_failed', error, {
      count: written.length,
    });
  }
}

/** Every distinct audio key the history references. */
function referencedKeys(history: unknown[]): string[] {
  const keys = new Set<string>();
  for (const item of history) {
    if (typeof item !== 'object' || item === null) continue;
    for (const field of AUDIO_KEY_FIELDS) {
      const value: unknown = Reflect.get(item, field);
      if (typeof value === 'string' && value !== '') keys.add(value);
    }
  }
  return [...keys];
}

async function copyAll(
  bucket: R2Bucket,
  keys: string[],
  target: AudioTarget,
  logger: RequestLogger
): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  for (let i = 0; i < keys.length; i += COPY_CONCURRENCY) {
    const batch = keys.slice(i, i + COPY_CONCURRENCY);
    const results = await Promise.all(batch.map((key) => copyOne(bucket, key, target, logger)));
    batch.forEach((key, j) => {
      const outcome = results.at(j);
      if (outcome) outcomes.set(key, outcome);
    });
  }
  return outcomes;
}

/** Copy one object; never throws (the outcome says what happened, and failures are logged). */
async function copyOne(
  bucket: R2Bucket,
  key: string,
  target: AudioTarget,
  logger: RequestLogger
): Promise<Outcome> {
  const fields = { user_id: target.subject, source_key: key };
  const destination = partnerAudioKeyFor(key, target);
  if (destination === null) {
    logger.warn('partner_key_legacy_import_audio_unrecognized', fields);
    return { key: null, result: 'failed' };
  }
  try {
    const object = await bucket.get(key);
    if (object === null) {
      logger.warn('partner_key_legacy_import_audio_missing', fields);
      return { key: null, result: 'missing' };
    }
    const bytes = await object.arrayBuffer();
    await bucket.put(destination, bytes, {
      ...(object.httpMetadata ? { httpMetadata: object.httpMetadata } : {}),
    });
    return { key: destination, result: 'copied' };
  } catch (error) {
    logger.error('partner_key_legacy_import_audio_copy_failed', error, fields);
    return { key: null, result: 'failed' };
  }
}

/** One history entry with each audio key replaced by its copy, or dropped. */
function rewriteEntry(item: unknown, outcomes: Map<string, Outcome>): unknown {
  if (typeof item !== 'object' || item === null) return item;
  const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const field of AUDIO_KEY_FIELDS) {
    const value: unknown = Reflect.get(copy, field);
    if (typeof value !== 'string' || value === '') continue;
    const outcome = outcomes.get(value);
    if (outcome?.key) Reflect.set(copy, field, outcome.key);
    else Reflect.deleteProperty(copy, field);
  }
  return copy;
}
