/**
 * Single-line text rules shared by every place that takes a short label from
 * outside and puts it on one line of a prompt, a log or a stored record:
 * group-chat speaker names (all platforms), partner identifiers, and partner
 * key labels (name, app, createdBy, revokedBy).
 *
 * "Line-breaking" means any character that can start a new line or carry an
 * invisible control in some renderer or model tokenizer: C0 controls
 * (U+0000–U+001F, which include \t \n \r), DEL (U+007F), C1 controls
 * (U+0080–U+009F, which include NEL U+0085), and the Unicode line and
 * paragraph separators U+2028 / U+2029. One definition, checked one code
 * point at a time, in one pass (no regex, so no control characters in source).
 *
 * Lengths are counted in code points, never UTF-16 units, so truncation can
 * never split a surrogate pair into a lone surrogate.
 */

/** True for a code point that must never appear in single-line text. */
function isLineBreaking(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

/** True when `value` contains a control character or any line break. */
export function hasLineBreakOrControl(value: string): boolean {
  for (const char of value) {
    if (isLineBreaking(char.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** Number of code points in `value` (what a person would count as characters, roughly). */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _char of value) count++;
  return count;
}

/**
 * Flatten `value` to one line in a single pass: every run of whitespace,
 * controls and line breaks becomes one space, characters in `drop` are
 * removed, leading/trailing space is trimmed, and the result is capped at
 * `maxCodePoints` code points (never splitting a surrogate pair).
 */
export function toSingleLine(value: string, maxCodePoints: number, drop = ''): string {
  let out = '';
  let count = 0;
  let pendingSpace = false;
  for (const char of value) {
    if (drop.includes(char)) continue;
    if (isLineBreaking(char.codePointAt(0) ?? 0) || char.trim() === '') {
      pendingSpace = count > 0;
      continue;
    }
    const needed = pendingSpace ? 2 : 1;
    if (count + needed > maxCodePoints) break;
    if (pendingSpace) out += ' ';
    out += char;
    count += needed;
    pendingSpace = false;
  }
  return out;
}
