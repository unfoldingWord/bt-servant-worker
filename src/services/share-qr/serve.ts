/**
 * Public share QR image route (#474): `GET /public/share-qr/<code>.png?s=<sig>`
 * and `GET /public/share-qr.png?s=<sig>` for the bare link.
 *
 * Public because Meta's media fetcher loads the image by link when the
 * WhatsApp gateway sends it, so it cannot carry our API key. Three guards keep
 * it cheap and closed:
 *
 *  1. the signature (`s`) must be the worker's HMAC over the code, so only
 *     URLs the worker issued are rendered (utils/share-qr.ts);
 *  2. the image only ever encodes a wa.me link to WHATSAPP_NUMBER;
 *  3. a rendered PNG is kept in the colo's Cache API under a canonical key
 *     (the SHA-256 of the encoded link), so replaying a URL, or adding query
 *     parameters to it, re-serves the cached bytes instead of rendering again.
 */

import type { Env } from '../../config/types.js';
import { sha256Hex } from '../../utils/crypto.js';
import { createRequestLogger, type RequestLogger } from '../../utils/logger.js';
import { normalizeWhatsAppNumber } from '../../utils/mode-share-link.js';
import {
  buildShareQrLink,
  parseShareQrPath,
  SHARE_QR_SIGNATURE_PARAM,
  verifyShareQrSignature,
} from '../../utils/share-qr.js';
import { renderQrPngForText } from '../../utils/share-qr-png.js';

/** A day, not immutable, so a WHATSAPP_NUMBER change reaches cached copies. */
const CACHE_CONTROL = 'public, max-age=86400';

/** Origin of the synthetic Cache API keys. Never fetched. */
const CACHE_KEY_ORIGIN = 'https://share-qr.cache.internal';

const notFound = () => Response.json({ error: 'Not found' }, { status: 404 });

/**
 * Check the request and return the link to encode, or the error response.
 * 404 for a bad path, a missing or wrong signature, or a reserved clear
 * token; 503 when WHATSAPP_NUMBER is unset or invalid (a config fault).
 */
async function authorizeLink(
  url: URL,
  env: Env,
  logger: RequestLogger
): Promise<{ link: string; code: string | null } | Response> {
  const parsed = parseShareQrPath(url.pathname);
  if (!parsed) {
    logger.warn('share_qr_invalid_path', { path: url.pathname });
    return notFound();
  }
  const signature = url.searchParams.get(SHARE_QR_SIGNATURE_PARAM);
  if (!(await verifyShareQrSignature(env.ENGINE_API_KEY, parsed.code, signature))) {
    logger.warn('share_qr_bad_signature', { code: parsed.code, has_signature: !!signature });
    return notFound();
  }
  if (!normalizeWhatsAppNumber(env.WHATSAPP_NUMBER)) {
    logger.error('share_qr_number_missing', new Error('WHATSAPP_NUMBER is unset or invalid'), {
      code: parsed.code,
    });
    return Response.json({ error: 'Share QR unavailable' }, { status: 503 });
  }
  const link = buildShareQrLink(env.WHATSAPP_NUMBER, parsed.code);
  if (!link) {
    logger.warn('share_qr_reserved_code', { code: parsed.code });
    return notFound();
  }
  return { link, code: parsed.code };
}

/** Cache lookup. A failing cache is logged and treated as a miss. */
async function cacheMatch(key: Request, logger: RequestLogger): Promise<Response | undefined> {
  try {
    return await caches.default.match(key);
  } catch (error) {
    logger.warn('share_qr_cache_match_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Cache store. A failing cache is logged; the response still goes out. */
async function cachePut(key: Request, response: Response, logger: RequestLogger): Promise<void> {
  try {
    await caches.default.put(key, response);
  } catch (error) {
    logger.warn('share_qr_cache_put_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function pngResponse(png: Uint8Array): Response {
  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Cache-Control': CACHE_CONTROL,
    },
  });
}

/** Serve the share QR PNG for `requestUrl`. */
export async function serveShareQrPng(requestUrl: string, env: Env): Promise<Response> {
  const start = Date.now();
  // Public route: no request-scoped logger exists (same as /public/ptxprint).
  const logger = createRequestLogger(crypto.randomUUID());
  const authorized = await authorizeLink(new URL(requestUrl), env, logger);
  if (authorized instanceof Response) return authorized;
  const { link, code } = authorized;
  const cacheKey = new Request(`${CACHE_KEY_ORIGIN}/v1/${await sha256Hex(link)}.png`);
  const cached = await cacheMatch(cacheKey, logger);
  if (cached) {
    logger.log('share_qr_served', { code, cache: 'hit', total_ms: Date.now() - start });
    return cached;
  }
  let png: Uint8Array;
  try {
    png = await renderQrPngForText(link);
  } catch (error) {
    logger.error('share_qr_render_failed', error, { code });
    return Response.json({ error: 'Failed to render QR code' }, { status: 500 });
  }
  const response = pngResponse(png);
  await cachePut(cacheKey, response.clone(), logger);
  // prettier-ignore
  logger.log('share_qr_served', { code, cache: 'miss', size_bytes: png.length, total_ms: Date.now() - start });
  return response;
}
