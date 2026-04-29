/**
 * Mirror a finished PDF from ptxprint-mcp's R2 into our own R2 so the
 * user-facing URL points at our domain. Re-hosting (vs pass-through) gives
 * us URL-shape control, retention control, and insulation from ptxprint-mcp
 * R2 hiccups during downstream consumer fetches.
 */

import { RequestLogger } from '../../utils/logger.js';

export class PdfMirrorError extends Error {
  constructor(
    message: string,
    public readonly cause: 'fetch_failed' | 'r2_upload_failed'
  ) {
    super(message);
    this.name = 'PdfMirrorError';
  }
}

export interface MirrorPdfInput {
  /** ptxprint-mcp-served PDF URL (e.g. https://ptxprint-mcp.klappy.workers.dev/r2/outputs/.../foo.pdf). */
  sourceUrl: string;
  /** Where in our PTXPRINT_BUCKET to store the mirrored PDF. */
  key: string;
  bucket: R2Bucket;
  /** Worker public origin for the returned URL. */
  baseUrl: string;
  logger: RequestLogger;
}

export interface MirrorPdfResult {
  /** Our public URL — `<base>/public/ptxprint/<key>`. */
  url: string;
  /** Stored object size. Useful for ChatResponse.attachments[].size_bytes. */
  size_bytes: number;
}

export function buildPdfPublicUrl(baseUrl: string, key: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/public/ptxprint/${key}`;
}

/**
 * Build the R2 key under which a PDF gets stored. Org/user-scoped + job-id
 * suffix mirrors the audio key shape (`audio/{org}/{user}/{uuid}.opus`) but
 * with the job_id from ptxprint-mcp standing in for the random UUID — we
 * already get a unique-per-payload identifier and re-using it makes
 * ptxprint-side and bt-servant-side logs trivially correlatable.
 */
export function buildPdfR2Key(org: string, userId: string, jobId: string): string {
  return `pdfs/${org}/${userId}/${jobId}.pdf`;
}

async function checkPdfCache(
  bucket: R2Bucket,
  key: string,
  logger: RequestLogger
): Promise<R2Object | null> {
  const headStart = Date.now();
  try {
    const head = await bucket.head(key);
    logger.log(head ? 'pdf_mirror_cache_hit' : 'pdf_mirror_cache_miss', {
      key,
      ...(head ? { size_bytes: head.size } : {}),
      head_ms: Date.now() - headStart,
    });
    return head;
  } catch (error) {
    logger.error('pdf_mirror_r2_head_error', error, {
      key,
      duration_ms: Date.now() - headStart,
    });
    throw new PdfMirrorError(
      `R2 head failed for ${key}: ${error instanceof Error ? error.message : String(error)}`,
      'r2_upload_failed'
    );
  }
}

async function fetchPdfBytes(sourceUrl: string, logger: RequestLogger): Promise<Uint8Array> {
  const fetchStart = Date.now();
  logger.log('pdf_mirror_fetch_start', { source_url: sourceUrl });
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'bt-servant-worker/ptxprint-integration' },
    });
  } catch (error) {
    logger.error('pdf_mirror_fetch_network_error', error, {
      source_url: sourceUrl,
      duration_ms: Date.now() - fetchStart,
    });
    throw new PdfMirrorError(`Network error fetching PDF from ${sourceUrl}`, 'fetch_failed');
  }
  if (!response.ok) {
    const bodyPeek = await response.text().catch(() => '<unreadable>');
    logger.error('pdf_mirror_fetch_http_error', null, {
      source_url: sourceUrl,
      status: response.status,
      status_text: response.statusText,
      body_peek: bodyPeek.slice(0, 500),
      duration_ms: Date.now() - fetchStart,
    });
    throw new PdfMirrorError(
      `Source returned HTTP ${response.status} for ${sourceUrl}`,
      'fetch_failed'
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  logger.log('pdf_mirror_fetch_complete', {
    source_url: sourceUrl,
    size_bytes: bytes.byteLength,
    duration_ms: Date.now() - fetchStart,
  });
  return bytes;
}

async function uploadPdf(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  logger: RequestLogger
): Promise<void> {
  const putStart = Date.now();
  try {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: 'application/pdf' },
    });
  } catch (error) {
    logger.error('pdf_mirror_r2_put_error', error, {
      key,
      size_bytes: bytes.byteLength,
      duration_ms: Date.now() - putStart,
    });
    throw new PdfMirrorError(
      `R2 put failed for ${key}: ${error instanceof Error ? error.message : String(error)}`,
      'r2_upload_failed'
    );
  }
  logger.log('pdf_mirror_uploaded', {
    key,
    size_bytes: bytes.byteLength,
    put_ms: Date.now() - putStart,
  });
}

export async function mirrorPdf(input: MirrorPdfInput): Promise<MirrorPdfResult> {
  const { sourceUrl, key, bucket, baseUrl, logger } = input;
  const overall = Date.now();
  logger.log('pdf_mirror_start', { source_url: sourceUrl, target_key: key });

  // Same job_id → same key; duplicate calls during retries become free.
  const head = await checkPdfCache(bucket, key, logger);
  if (head) {
    return { url: buildPdfPublicUrl(baseUrl, key), size_bytes: head.size };
  }

  const bytes = await fetchPdfBytes(sourceUrl, logger);
  await uploadPdf(bucket, key, bytes, logger);
  logger.log('pdf_mirror_complete', {
    key,
    size_bytes: bytes.byteLength,
    total_ms: Date.now() - overall,
  });
  return { url: buildPdfPublicUrl(baseUrl, key), size_bytes: bytes.byteLength };
}
