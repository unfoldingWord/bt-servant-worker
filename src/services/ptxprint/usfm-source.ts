/**
 * Resolve a (translation, book) pair to a `sources[]` entry suitable for
 * ptxprint-mcp's `submit_typeset` payload.
 *
 * Pipeline:
 *   1. Map (translation, book) → DCS raw URL.
 *   2. Fetch the USFM bytes from DCS.
 *   3. Compute sha256 of the bytes (ptxprint-mcp's PayloadSchema requires it).
 *   4. Upload to PTXPRINT_BUCKET at a content-addressed key (idempotent —
 *      we `bucket.head()` first and skip the put on hit).
 *   5. Return `{ book, filename, url, sha256 }` where `url` is our public
 *      `/public/ptxprint/usfm/...` URL — the ptxprint container fetches
 *      this directly during typesetting.
 *
 * The container at klappy.workers.dev cannot satisfy our /api/* auth
 * middleware, which is why we serve these via /public/* instead.
 */

import { RequestLogger } from '../../utils/logger.js';
import { BOOK_INDEX } from './presets.js';
import { PayloadSource } from './types.js';

/** Translation IDs we know how to resolve to DCS in v1. */
export const SUPPORTED_TRANSLATIONS = ['en_ult', 'en_ust', 'en_t4t', 'en_ueb'] as const;
export type SupportedTranslation = (typeof SUPPORTED_TRANSLATIONS)[number];

export function isSupportedTranslation(value: unknown): value is SupportedTranslation {
  return typeof value === 'string' && (SUPPORTED_TRANSLATIONS as readonly string[]).includes(value);
}

export class UsfmSourceError extends Error {
  constructor(
    message: string,
    public readonly cause:
      | 'unsupported_translation'
      | 'unknown_book'
      | 'fetch_failed'
      | 'r2_upload_failed'
  ) {
    super(message);
    this.name = 'UsfmSourceError';
  }
}

export interface ResolveUsfmSourceInput {
  translation: SupportedTranslation;
  /** 3-letter Paratext book code, e.g. "JHN". */
  book: string;
  bucket: R2Bucket;
  /** Worker public origin (e.g. "https://bt-servant-worker.example.com"). */
  baseUrl: string;
  logger: RequestLogger;
}

/**
 * Build the DCS raw URL for a translation+book. Pattern is uniform across
 * unfoldingWord's en_* repos: `<paratext-num>-<BOOK3>.usfm`.
 *
 * Smoke testing will tell us quickly if any translation diverges from this
 * pattern. The fail mode is a 404 on fetch, which we log loudly — easy fix
 * by adding a per-translation override here.
 */
export function buildDcsUrl(translation: SupportedTranslation, book: string): string {
  // eslint-disable-next-line security/detect-object-injection -- book validated upstream
  const num = BOOK_INDEX[book];
  if (!num) {
    throw new UsfmSourceError(`Unknown book code: ${book}`, 'unknown_book');
  }
  return `https://git.door43.org/unfoldingWord/${translation}/raw/branch/master/${num}-${book}.usfm`;
}

/**
 * Build the source filename PTXprint expects in `sources[].filename`.
 *
 * Pattern is `{N}{BOOK}test.usfm` (e.g. `44JHNtest.usfm`) to match the
 * canon-validated `bsb-empirical` preset's Settings.xml convention
 * (`FileNamePostPart=test.usfm`). The container resolves source files
 * by walking the `FileNamePrePart + bookcode + FileNamePostPart` template
 * out of Settings.xml — if our filenames don't match the template the
 * container can't find them, which surfaces as
 * "PTXprint produced no output (silent exit)".
 *
 * If/when we move past the bsb-empirical preset, this should grow a
 * preset-aware path or move into the docs+raw-tools loop.
 */
export function buildParatextFilename(book: string): string {
  // eslint-disable-next-line security/detect-object-injection -- book validated upstream
  const num = BOOK_INDEX[book];
  if (!num) {
    throw new UsfmSourceError(`Unknown book code: ${book}`, 'unknown_book');
  }
  return `${num}${book}test.usfm`;
}

/** Build the R2 key for a USFM source. Content-addressed by sha256 — same bytes get the same key. */
export function buildUsfmR2Key(translation: string, sha256: string, filename: string): string {
  return `usfm/${translation}/${sha256}/${filename}`;
}

/** Build the public URL for a USFM source served from PTXPRINT_BUCKET. */
export function buildUsfmPublicUrl(baseUrl: string, key: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/public/ptxprint/${key}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchUsfmBytes(url: string, logger: RequestLogger): Promise<Uint8Array> {
  const start = Date.now();
  logger.log('usfm_dcs_fetch_start', { url });
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'bt-servant-worker/ptxprint-integration' },
    });
  } catch (error) {
    logger.error('usfm_dcs_fetch_network_error', error, {
      url,
      duration_ms: Date.now() - start,
    });
    throw new UsfmSourceError(`Network error fetching USFM from DCS: ${url}`, 'fetch_failed');
  }
  if (!response.ok) {
    const bodyPeek = await response.text().catch(() => '<unreadable>');
    logger.error('usfm_dcs_fetch_http_error', null, {
      url,
      status: response.status,
      status_text: response.statusText,
      body_peek: bodyPeek.slice(0, 500),
      duration_ms: Date.now() - start,
    });
    throw new UsfmSourceError(`DCS returned HTTP ${response.status} for ${url}`, 'fetch_failed');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  logger.log('usfm_dcs_fetch_complete', {
    url,
    size_bytes: bytes.byteLength,
    duration_ms: Date.now() - start,
  });
  return bytes;
}

async function checkUsfmCache(
  bucket: R2Bucket,
  key: string,
  logger: RequestLogger
): Promise<R2Object | null> {
  const headStart = Date.now();
  try {
    const head = await bucket.head(key);
    logger.log(head ? 'usfm_r2_cache_hit' : 'usfm_r2_cache_miss', {
      key,
      ...(head ? { size_bytes: head.size } : {}),
      head_ms: Date.now() - headStart,
    });
    return head;
  } catch (error) {
    logger.error('usfm_r2_head_error', error, { key, duration_ms: Date.now() - headStart });
    throw new UsfmSourceError(
      `R2 head failed for key ${key}: ${error instanceof Error ? error.message : String(error)}`,
      'r2_upload_failed'
    );
  }
}

async function uploadUsfmIfMissing(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  logger: RequestLogger
): Promise<{ uploaded: boolean }> {
  const head = await checkUsfmCache(bucket, key, logger);
  if (head) return { uploaded: false };
  const putStart = Date.now();
  try {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
  } catch (error) {
    logger.error('usfm_r2_put_error', error, {
      key,
      size_bytes: bytes.byteLength,
      duration_ms: Date.now() - putStart,
    });
    throw new UsfmSourceError(
      `R2 put failed for key ${key}: ${error instanceof Error ? error.message : String(error)}`,
      'r2_upload_failed'
    );
  }
  logger.log('usfm_r2_uploaded', {
    key,
    size_bytes: bytes.byteLength,
    put_ms: Date.now() - putStart,
  });
  return { uploaded: true };
}

/**
 * Resolve a USFM source for the ptxprint payload. See module docstring.
 */
export async function resolveUsfmSource(input: ResolveUsfmSourceInput): Promise<PayloadSource> {
  const { translation, book, bucket, baseUrl, logger } = input;
  const overall = Date.now();
  logger.log('usfm_resolve_start', { translation, book });

  const dcsUrl = buildDcsUrl(translation, book);
  const filename = buildParatextFilename(book);
  logger.log('usfm_resolve_resolved_locations', {
    translation,
    book,
    dcs_url: dcsUrl,
    paratext_filename: filename,
  });

  const bytes = await fetchUsfmBytes(dcsUrl, logger);
  const hashStart = Date.now();
  const sha256 = await sha256Hex(bytes);
  logger.log('usfm_sha256_computed', {
    book,
    sha256,
    size_bytes: bytes.byteLength,
    hash_ms: Date.now() - hashStart,
  });

  const key = buildUsfmR2Key(translation, sha256, filename);
  await uploadUsfmIfMissing(bucket, key, bytes, logger);

  const publicUrl = buildUsfmPublicUrl(baseUrl, key);
  logger.log('usfm_resolve_complete', {
    translation,
    book,
    sha256,
    public_url: publicUrl,
    total_ms: Date.now() - overall,
  });

  return {
    book,
    filename,
    url: publicUrl,
    sha256,
  };
}
