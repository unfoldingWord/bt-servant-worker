/**
 * Partner key material (admin-portal#354): the plaintext format, its keyed
 * tag, and the hash used as the storage key.
 *
 *   bts_<8 hex>_<43 base64url>_<11 base64url>
 *   └─ prefix ─┘ └ 256 random ┘ └── tag ───┘
 *
 * The tag is the first 8 bytes of HMAC-SHA-256(PARTNER_KEY_TAG_SECRET, body),
 * where body is the fixed-length first 56 characters (`bts_<8 hex>_<43>`,
 * TAGGED_BODY_LENGTH) and the tag is the 11 characters after the `_` at
 * offset 56. The token is sliced at those fixed offsets, never split on `_`:
 * base64url text (body and tag alike) can itself contain `_`. The auth middleware checks it
 * locally (no I/O) before the KV lookup, so a random or guessed token can
 * never cost a KV read: forging a tag needs the secret (a 64-bit tag is
 * 1 in 2^64 by chance). The tag is NOT the credential — the 256 random bits
 * are; the tag only gates the lookup.
 *
 * Changing PARTNER_KEY_TAG_SECRET invalidates every issued key (their tags
 * stop verifying), so it is set once per environment and never rotated
 * casually.
 */

import {
  bytesToBase64Url,
  bytesToHex,
  constantTimeCompare,
  hmacSha256,
  sha256Hex,
} from '../../utils/crypto.js';

/** API_KEYS KV key of a key's auth projection: `key:<sha256 of the plaintext>`. */
export const PARTNER_KEY_KV_PREFIX = 'key:';

const PLAINTEXT_PREFIX = 'bts_';
/** `bts_<8 hex>_<43 base64url = 256 bits>_<11 base64url = 64-bit tag>`. */
const PLAINTEXT_PATTERN = /^bts_[0-9a-f]{8}_[A-Za-z0-9_-]{43}_[A-Za-z0-9_-]{11}$/;
/** Length of `bts_<8 hex>_<43>`, the part the tag signs. */
const TAGGED_BODY_LENGTH = PLAINTEXT_PREFIX.length + 8 + 1 + 43;
const TAG_BYTES = 8;

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

async function tagFor(secret: string, body: string): Promise<string> {
  const mac = await hmacSha256(secret, body);
  return bytesToBase64Url(mac.slice(0, TAG_BYTES));
}

/** The non-secret display prefix (`bts_<8 hex>`) of a partner-shaped token. */
export function partnerKeyPrefix(token: string): string {
  return token.slice(0, PLAINTEXT_PREFIX.length + 8);
}

/** Cheap shape check (pure, no crypto). */
export function looksLikePartnerKey(token: string): boolean {
  return PLAINTEXT_PATTERN.test(token);
}

/**
 * Keyed check, still with no I/O: true only for a token whose tag was made
 * with `secret`. Call after looksLikePartnerKey.
 */
export async function hasValidPartnerKeyTag(token: string, secret: string): Promise<boolean> {
  const body = token.slice(0, TAGGED_BODY_LENGTH);
  const tag = token.slice(TAGGED_BODY_LENGTH + 1);
  return constantTimeCompare(tag, await tagFor(secret, body));
}

/** Storage key material for a token: SHA-256 hex of the full plaintext. */
export function partnerKeyHash(token: string): Promise<string> {
  return sha256Hex(token);
}

/** Fresh key material: public id, display prefix, one-time plaintext and its hash. */
export async function generatePartnerKeyMaterial(
  secret: string
): Promise<{ id: string; prefix: string; plaintext: string; hash: string }> {
  const prefix = `${PLAINTEXT_PREFIX}${bytesToHex(randomBytes(4))}`;
  const body = `${prefix}_${bytesToBase64Url(randomBytes(32))}`;
  const plaintext = `${body}_${await tagFor(secret, body)}`;
  return {
    id: `pk_${bytesToHex(randomBytes(8))}`,
    prefix,
    plaintext,
    hash: await partnerKeyHash(plaintext),
  };
}
