/**
 * Cryptographic utilities
 */

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    // Length check above guarantees valid indices - use non-null assertion
    // eslint-disable-next-line security/detect-object-injection -- i is a controlled loop index
    result |= aBytes[i]! ^ bBytes[i]!;
  }

  return result === 0;
}
