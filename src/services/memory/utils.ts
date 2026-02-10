/** Calculate byte size of a string using TextEncoder */
export function byteLength(str: string): number {
  return new TextEncoder().encode(str).byteLength;
}
