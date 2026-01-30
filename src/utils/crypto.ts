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
