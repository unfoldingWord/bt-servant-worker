/**
 * Deterministic first-contact welcome text for a mode (#311).
 *
 * The worker — not the model — assembles this so the `wa.me` share link is
 * always present and correct ("keeps the forwarding path alive", per Elsy).
 * The shape is:
 *
 *   <authored welcome_message>
 *
 *   <SHARE_LINE_PREFIX><wa.me share link>
 *
 * When no WhatsApp number is configured the share link cannot be built, so the
 * share line is omitted and only the authored copy is returned. That is a
 * defined degraded fallback, not a crash: the welcome still goes out, just
 * without the forwarding link (the caller logs the misconfiguration).
 */

import { buildModeShareLink } from './mode-share-link.js';

/**
 * Label that precedes the share link. Kept as a single module-level constant
 * (English, minimal) rather than an authored/i18n string for V1: the link
 * itself is the payload, the prefix is a thin affordance. Easy to localize
 * later without touching call sites.
 */
export const SHARE_LINE_PREFIX = 'Share this mode: ';

/**
 * Build the welcome message a user sees the first time they reach `slug`.
 *
 * `welcomeMessage` is the mode's authored copy (already confirmed non-empty by
 * the caller). `whatsappNumber` is the operator-set env var; when it is
 * absent/invalid the share line is dropped and only the copy is returned.
 */
export function buildModeWelcomeText(
  welcomeMessage: string,
  slug: string,
  whatsappNumber: string | null | undefined
): string {
  const copy = welcomeMessage.trim();
  const shareUrl = buildModeShareLink(whatsappNumber, slug);
  if (!shareUrl) return copy;
  return `${copy}\n\n${SHARE_LINE_PREFIX}${shareUrl}`;
}
