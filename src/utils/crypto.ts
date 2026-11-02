/**
 * Cryptographic utilities
 */

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * This implementation does NOT short-circuit on length mismatch to prevent
 * attackers from determining the correct key length via timing analysis.
 * It always iterates over the longer string and XORs the length difference
 * into the result to ensure different-length strings fail comparison.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  const maxLength = Math.max(aBytes.length, bBytes.length);

  // XOR the lengths to include length difference in result
  // This ensures different-length strings fail without early return
  let result = aBytes.length ^ bBytes.length;

  for (let i = 0; i < maxLength; i++) {
    // Use 0 for out-of-bounds to avoid index errors while maintaining constant time
    // eslint-disable-next-line security/detect-object-injection -- i is a controlled loop index
    const aByte = i < aBytes.length ? aBytes[i]! : 0;
    // eslint-disable-next-line security/detect-object-injection -- i is a controlled loop index
    const bByte = i < bBytes.length ? bBytes[i]! : 0;
    result |= aByte ^ bByte;
  }

  return result === 0;
}

/** Lowercase hex encoding of a byte array. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 digest, lowercase hex. Strings are hashed as their UTF-8 bytes. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

/** Standard base64 encoding of a byte array (btoa over a binary string). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** URL-safe base64 without padding (RFC 4648 §5). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
