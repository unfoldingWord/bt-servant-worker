/**
 * Legacy import, audio (admin-portal#354). A copied conversation's history
 * points at R2 audio by key: `voice_audio_key` (TTS replies, `audio/...`),
 * `inbound_voice_audio_key` (archived voice messages,
 * `voice-submissions/...`) and each audio entry of `attachments[]`
 * (`r2_key` plus its download `url`, from attach_audio). Those keys name
 * the shared-key user (or, for an attachment, the recording's owner), so a partner
 * key could never download them (partnerOwnsAudioKey). For each referenced
 * object this copies it into the partner partition (partnerAudioKeyFor: same
 * family and file, owner `partner:<ns>:<user_id>`) and rewrites the key in
 * the copied history (an attachment's `url` is pointed at the copy too).
 * The source objects are never changed or deleted.
 *
 * Rules:
 * - A target key that already exists (an earlier run wrote it) is reused,
 *   never overwritten, and never listed in `written` — so a cleanup can only
 *   ever delete objects THIS run created.
 * - A source object that is truly missing (`get` → null) keeps its history
 *   entry but loses that audio key, or that attachment (logged; counted as
 *   `missing`).
 * - Any other failure (an R2 error, an unrecognised key) fails the whole
 *   user (`ok: false`): the caller writes nothing to the destination and
 *   removes `written`, and a re-run can retry.
 * Copies are streamed (`object.body`), never buffered.
 */

import { audioKeyToUrl, partnerAudioKeyFor, voiceSubmissionKeyToUrl } from '../audio/index.js';
import type { RequestLogger } from '../../utils/logger.js';
import { HISTORY_KEY } from '../../durable-objects/user-do-storage-keys.js';

/** The history fields that hold an R2 audio key. */
const AUDIO_KEY_FIELDS = ['voice_audio_key', 'inbound_voice_audio_key'] as const;
/** Objects copied at once. */
const COPY_CONCURRENCY = 5;
/** R2 operations one referenced object can take at most: head, get, put. */
export const R2_OPERATIONS_PER_AUDIO_OBJECT = 3;
/**
 * During a long copy, `keepGoing` (the import lease renewal) is called before
 * every batch that starts at a multiple of this many objects, so a long copy
 * never outlives the lease.
 */
export const AUDIO_RENEW_EVERY = 25;

export type AudioCopyCounts = { copied: number; existing: number; missing: number };

export type AudioTarget = { org: string; namespace: string; subject: string };

export type RehomeResult =
  | { ok: true; entries: [string, unknown][]; counts: AudioCopyCounts; written: string[] }
  /** `stopped`: `keepGoing` said no (lease lost); otherwise a copy failed. */
  | { ok: false; written: string[]; stopped: boolean };

type Outcome =
  { result: 'copied' | 'existing'; key: string } | { result: 'missing' | 'failed'; key: null };

/** Every distinct audio key the exported history references (to budget before copying). */
export function referencedAudioKeys(entries: [string, unknown][]): string[] {
  const history = entries.find(([name]) => name === HISTORY_KEY)?.[1];
  if (!Array.isArray(history)) return [];
  const keys = new Set<string>();
  for (const item of history) {
    if (typeof item !== 'object' || item === null) continue;
    for (const field of AUDIO_KEY_FIELDS) {
      const value: unknown = Reflect.get(item, field);
      if (typeof value === 'string' && value !== '') keys.add(value);
    }
    for (const attachment of audioAttachments(item)) keys.add(attachment.r2_key);
  }
  return [...keys];
}

type AudioAttachmentLike = { type: 'audio'; r2_key: string; url?: unknown };

/** The entry's audio attachments that name an R2 key (attach_audio's `{type:'audio', r2_key, url}`). */
function audioAttachments(item: object): AudioAttachmentLike[] {
  const attachments: unknown = Reflect.get(item, 'attachments');
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(isAudioAttachment);
}

function isAudioAttachment(value: unknown): value is AudioAttachmentLike {
  if (typeof value !== 'object' || value === null) return false;
  const key: unknown = Reflect.get(value, 'r2_key');
  return Reflect.get(value, 'type') === 'audio' && typeof key === 'string' && key !== '';
}

/**
 * Copy the audio referenced by `entries`' history into the partner partition
 * and return the entries with the keys rewritten. On any non-missing failure
 * returns `ok: false` with the keys this run wrote, for the caller to remove.
 */
export async function rehomeHistoryAudio(
  bucket: R2Bucket,
  entries: [string, unknown][],
  target: AudioTarget,
  logger: RequestLogger,
  keepGoing: () => Promise<boolean> = async () => true
): Promise<RehomeResult> {
  const keys = referencedAudioKeys(entries);
  const { outcomes, stopped } = await copyAll(bucket, keys, { target, logger, keepGoing });
  const all = [...outcomes.values()];
  const written = all.flatMap((o) => (o.result === 'copied' ? [o.key] : []));
  if (stopped) return { ok: false, written, stopped: true };
  if (all.some((o) => o.result === 'failed')) return { ok: false, written, stopped: false };
  const counts: AudioCopyCounts = {
    copied: written.length,
    existing: all.filter((o) => o.result === 'existing').length,
    missing: all.filter((o) => o.result === 'missing').length,
  };
  const rewritten = entries.map(([name, value]): [string, unknown] => [
    name,
    name === HISTORY_KEY && Array.isArray(value)
      ? value.map((item: unknown) => rewriteEntry(item, outcomes))
      : value,
  ]);
  return { ok: true, entries: rewritten, counts, written };
}

/** Remove objects THIS run wrote, for an import that was then refused or failed (best effort, logged). */
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

async function copyAll(
  bucket: R2Bucket,
  keys: string[],
  opts: { target: AudioTarget; logger: RequestLogger; keepGoing: () => Promise<boolean> }
): Promise<{ outcomes: Map<string, Outcome>; stopped: boolean }> {
  const { target, logger, keepGoing } = opts;
  const outcomes = new Map<string, Outcome>();
  for (let i = 0; i < keys.length; i += COPY_CONCURRENCY) {
    if (i > 0 && i % AUDIO_RENEW_EVERY === 0 && !(await keepGoing())) {
      return { outcomes, stopped: true };
    }
    const batch = keys.slice(i, i + COPY_CONCURRENCY);
    const results = await Promise.all(batch.map((key) => copyOne(bucket, key, target, logger)));
    batch.forEach((key, j) => {
      const outcome = results.at(j);
      if (outcome) outcomes.set(key, outcome);
    });
  }
  return { outcomes, stopped: false };
}

/** Copy one object (streamed); never throws — the outcome says what happened, failures are logged. */
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
    return { result: 'failed', key: null };
  }
  try {
    if ((await bucket.head(destination)) !== null) return { result: 'existing', key: destination };
    const object = await bucket.get(key);
    if (object === null) {
      logger.warn('partner_key_legacy_import_audio_missing', fields);
      return { result: 'missing', key: null };
    }
    await bucket.put(destination, object.body, {
      ...(object.httpMetadata ? { httpMetadata: object.httpMetadata } : {}),
    });
    return { result: 'copied', key: destination };
  } catch (error) {
    logger.error('partner_key_legacy_import_audio_copy_failed', error, fields);
    return { result: 'failed', key: null };
  }
}

/** One history entry with each audio key replaced by its copy, or dropped (missing source). */
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
  const attachments: unknown = Reflect.get(copy, 'attachments');
  if (Array.isArray(attachments)) {
    Reflect.set(copy, 'attachments', rewriteAttachments(attachments, outcomes));
  }
  return copy;
}

/** Each audio attachment pointed at its copy (`r2_key` and `url`), or dropped (missing source). */
function rewriteAttachments(attachments: unknown[], outcomes: Map<string, Outcome>): unknown[] {
  return attachments.flatMap((attachment) => {
    if (!isAudioAttachment(attachment)) return [attachment];
    const copied = outcomes.get(attachment.r2_key)?.key;
    if (!copied) return [];
    return [
      { ...attachment, r2_key: copied, url: rehomedUrl(attachment.url, attachment.r2_key, copied) },
    ];
  });
}

/**
 * The attachment's download URL for the copy: the same URL with the old key
 * swapped for the new one when it ends with it, else built for the copy's
 * route on the old URL's origin (or as a path, if the old URL is unusable).
 */
function rehomedUrl(url: unknown, oldKey: string, newKey: string): string {
  if (typeof url === 'string' && url.endsWith(`/${oldKey}`)) {
    return `${url.slice(0, url.length - oldKey.length)}${newKey}`;
  }
  const origin = typeof url === 'string' ? (/^https?:\/\/[^/?#]+/i.exec(url)?.[0] ?? '') : '';
  return newKey.startsWith('audio/')
    ? audioKeyToUrl(newKey, origin)
    : voiceSubmissionKeyToUrl(newKey, origin);
}
