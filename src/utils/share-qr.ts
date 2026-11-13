/**
 * Shareable QR code for the user's current mode (#474).
 *
 * The QR encodes the same `wa.me` link the portal's share panel and the #311
 * welcome use: `https://wa.me/<number>?text=%23<code>`, where `<code>` is the
 * mode's chat code (`<slug>` for an unfoldingWord mode, `<orgslug>/<slug>` for
 * another org's published mode, admin-portal#345). A user with no mode gets
 * the bare `https://wa.me/<number>` link, which opens BT Servant with no
 * prefilled text.
 *
 * The image is served by the public route `GET /public/share-qr/<code>.png`
 * (or `/public/share-qr.png` for the bare link). It renders on demand and is
 * deterministic from `WHATSAPP_NUMBER` + code, so nothing is stored.
 *
 * The route is not an open QR generator: it only ever encodes a link to our
 * own WhatsApp number, and the code must have the shape of a mode name
 * (`MODE_NAME_PATTERN`, optionally qualified by one org slug). It does NOT
 * check that the mode exists: that would cost KV reads on every fetch, and a
 * QR for a code that matches nothing only opens BT Servant with that text.
 */

import { uiString } from '../i18n/ui-strings.js';
import type { ChatRequest, ShareQrMedia } from '../types/engine.js';
import { MODE_NAME_PATTERN } from '../types/prompt-overrides.js';
import { buildModeShareLink, normalizeWhatsAppNumber, WA_ME_ORIGIN } from './mode-share-link.js';

/** Public path prefix for share QR images. */
export const SHARE_QR_PATH_PREFIX = '/public/share-qr';

/** The bare link's image path (no mode). */
export const SHARE_QR_BARE_PATH = `${SHARE_QR_PATH_PREFIX}.png`;

/**
 * Validate a share code: one mode slug, or `<orgslug>/<slug>`. Both parts use
 * the mode-name alphabet (lowercase letters, digits, inner hyphens, ≤64).
 */
export function isValidShareCode(code: string): boolean {
  const parts = code.split('/');
  if (parts.length > 2) return false;
  return parts.every((part) => MODE_NAME_PATTERN.test(part));
}

/**
 * The link a share QR encodes, or null when it cannot be built (no valid
 * WhatsApp number, an invalid code, or a reserved clear token such as
 * `default`). `code === null` means the bare link.
 */
export function buildShareQrLink(
  rawNumber: string | null | undefined,
  code: string | null
): string | null {
  if (code === null) {
    const digits = normalizeWhatsAppNumber(rawNumber);
    return digits ? `${WA_ME_ORIGIN}/${digits}` : null;
  }
  if (!isValidShareCode(code)) return null;
  return buildModeShareLink(rawNumber, code);
}

/** Path of the share QR image for `code` (null ⇒ the bare link). */
export function shareQrImagePath(code: string | null): string {
  return code === null ? SHARE_QR_BARE_PATH : `${SHARE_QR_PATH_PREFIX}/${code}.png`;
}

/**
 * Parse a request path back into a share code. Returns `{ code: null }` for
 * the bare image, `{ code }` for a valid code, and null for anything else.
 */
export function parseShareQrPath(path: string): { code: string | null } | null {
  if (path === SHARE_QR_BARE_PATH) return { code: null };
  const prefix = `${SHARE_QR_PATH_PREFIX}/`;
  if (!path.startsWith(prefix) || !path.endsWith('.png')) return null;
  const code = path.slice(prefix.length, -'.png'.length);
  return isValidShareCode(code) ? { code } : null;
}

// ── Per-turn decision (used by the UserDO) ───────────────────────────────────

/** v1 scope (#474, decided 2026-11-05): unfoldingWord users on WhatsApp only. */
export const SHARE_QR_ORG = 'unfoldingWord';
export const SHARE_QR_CLIENT_ID = 'whatsapp';

/** DO storage prefix of the once-per-mode flag: `share_qr_sent:<code>`. */
export const SHARE_QR_SENT_PREFIX = 'share_qr_sent:';

/** Flag suffix for the bare (no-mode) QR. `@` cannot appear in a share code. */
const BARE_FLAG_SUFFIX = '@bare';

/** The once-per-mode DO storage flag for `code` (null ⇒ the bare QR). */
export function shareQrFlagKey(code: string | null): string {
  return `${SHARE_QR_SENT_PREFIX}${code ?? BARE_FLAG_SUFFIX}`;
}

export type ShareQrRequestSkip =
  | 'not_opted_in'
  | 'not_whatsapp'
  | 'not_callback'
  | 'group_chat'
  | 'other_org'
  | 'welcome_suppressed';

/**
 * Why this request can never carry a share QR, or null when it can. Every
 * condition is about the request alone, so the DO checks this before any
 * storage read.
 */
export function shareQrRequestSkip(body: ChatRequest, org: string): ShareQrRequestSkip | null {
  if (body.accepts_share_qr !== true) return 'not_opted_in';
  if (body.client_id !== SHARE_QR_CLIENT_ID) return 'not_whatsapp';
  if (!body.progress_callback_url) return 'not_callback';
  if (body.chat_type !== undefined && body.chat_type !== 'private') return 'group_chat';
  if (org !== SHARE_QR_ORG) return 'other_org';
  // #392: a client that owns the conversation's opening gets no greeting extras.
  if (body.suppress_welcome === true) return 'welcome_suppressed';
  return null;
}

/**
 * Which QR, if any, this turn is due, before the once-per-mode flag check.
 *
 * - The user ENTERED a mode this turn (`endMode` differs from the mode the
 *   turn started in: a `#mode` scan or typed trigger, or the `switch_mode`
 *   tool), or is brand new and already in a mode ⇒ that mode's QR.
 * - A brand-new user with no mode ⇒ the bare BT Servant QR.
 * - Anything else (a later turn in the same mode, a user clearing their
 *   mode) ⇒ none.
 */
export function dueShareQrCode(facts: {
  startMode: string | undefined;
  endMode: string | undefined;
  firstInteraction: boolean;
}): { code: string | null } | null {
  const { startMode, endMode, firstInteraction } = facts;
  if (endMode !== undefined) {
    return endMode !== startMode || firstInteraction ? { code: endMode } : null;
  }
  return firstInteraction ? { code: null } : null;
}

/**
 * Build the QR media for `code`, or null when it cannot be built (no valid
 * WhatsApp number, an invalid or reserved code, or a non-HTTPS origin, since
 * Meta only fetches media over HTTPS). The caption is localized through the
 * worker UI string table and ends with the link, so a user who cannot scan
 * their own screen can still tap or forward it.
 */
export function buildShareQrMedia(input: {
  whatsappNumber: string | null | undefined;
  workerOrigin: string;
  code: string | null;
  locale: string | null | undefined;
}): ShareQrMedia | null {
  const link = buildShareQrLink(input.whatsappNumber, input.code);
  if (!link || !input.workerOrigin.startsWith('https://')) return null;
  const origin = input.workerOrigin.replace(/\/+$/, '');
  return {
    url: `${origin}${shareQrImagePath(input.code)}`,
    caption: `${uiString(input.locale, 'share_qr_caption')}\n${link}`,
    code: input.code,
  };
}
