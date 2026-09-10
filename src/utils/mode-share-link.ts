/**
 * Worker-side builder for the per-mode WhatsApp share link (#311).
 *
 * This MIRRORS the portal's builder EXACTLY
 * (bt-servant-admin-portal/src/lib/mode-share-link.ts, `buildModeShareLink`)
 * so a link the worker embeds in a first-contact welcome and a link the portal
 * renders in its share panel are byte-identical:
 *
 *   https://wa.me/<digits>?text=%23<slug>
 *
 * Scanning/sending it drops `#<slug>` into the BT Servant chat, which the
 * worker's leading-token classifier resolves back to this mode.
 *
 * The number is an operator-set env var (typo-prone), so it is treated as
 * untrusted and normalized/validated before it reaches the URL. Unlike the
 * portal, this builder is only ever handed a mode's CANONICAL slug (the mode's
 * own `name`, already validated by `MODE_NAME_PATTERN` at authoring time), so
 * it does not re-run the slug/reserved-token verdicts the portal panel needs.
 */

export const WA_ME_ORIGIN = 'https://wa.me';

// E.164 caps a number at 15 digits and forbids a leading zero. The lower bound
// is a typo guard — no live country-code + subscriber number is shorter — not a
// formal E.164 minimum. Identical to the portal's `E164_DIGITS`.
const E164_DIGITS = /^[1-9][0-9]{6,14}$/;

// #311 FIX 5: the classifier reads these tokens as "clear the active mode"
// BEFORE any mode match (worker `CLEAR_TOKENS`, src/services/classifier/index.ts;
// the portal mirrors them as `RESERVED_TRIGGERS`). A mode whose canonical slug
// is one of these would produce `wa.me/…?text=%23default`, and scanning that QR
// would DEACTIVATE the recipient's mode instead of selecting it — a self-
// defeating link. Kept as a local copy (like the portal builder) so this module
// stays dependency-free; `CLEAR_TOKENS` is the canonical source if they change.
const RESERVED_CLEAR_TRIGGERS: ReadonlySet<string> = new Set(['default', 'none', 'clear']);

/**
 * Reduce an operator-entered WhatsApp number to the digit string `wa.me`
 * expects. Accepts the `+`, spaces, hyphens, dots, and parentheses people
 * paste from a contact card; returns `null` when what is left is not a
 * plausible E.164 number.
 */
export function normalizeWhatsAppNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw
    .trim()
    .replace(/^\+/, '')
    .replace(/[\s().-]/g, '');
  return E164_DIGITS.test(digits) ? digits : null;
}

/** The message the share link pre-fills: the worker's mode trigger for `slug`. */
export function modeShareTrigger(slug: string): string {
  return `#${slug}`;
}

/**
 * Build the `wa.me` share link for `slug`, or `null` when it cannot be built.
 * Returning `null` (rather than throwing) is deliberate: the caller degrades to
 * "no share line, authored copy still emitted", never a crashed turn. `null` is
 * returned when:
 *
 *  - `WHATSAPP_NUMBER` is unset or a typo (not a plausible E.164 number), or
 *  - the slug is a reserved clear-token (#311 FIX 5) — a QR for it would clear
 *    the recipient's mode rather than select it.
 *
 * `encodeURIComponent` turns the `#` into `%23`; the slug's own alphabet
 * ([a-z0-9-]) is untouched, which keeps the link legible and matches the
 * portal's output character-for-character.
 */
export function buildModeShareLink(
  rawNumber: string | null | undefined,
  slug: string
): string | null {
  if (RESERVED_CLEAR_TRIGGERS.has(slug)) return null;
  const digits = normalizeWhatsAppNumber(rawNumber);
  if (!digits) return null;
  const trigger = modeShareTrigger(slug);
  return `${WA_ME_ORIGIN}/${digits}?text=${encodeURIComponent(trigger)}`;
}
