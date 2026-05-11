/**
 * Strip Ulysses-style editor comments from author-supplied content before it
 * is concatenated into Claude's system prompt.
 *
 * Two comment forms (per Tim Jore, Ulysses parity — issue #201):
 *
 *   `%%`     — Line comment. Everything from `%%` through end-of-line is a
 *              comment. Line-terminated (NOT paragraph-terminated), matching
 *              the admin portal's v1 parser
 *              (`bt-servant-admin-portal:src/lib/markdown-headings.ts`).
 *
 *   `++…++`  — Paired inline span. May span newlines. Removed wholesale,
 *              including the delimiters.
 *
 *              `++` is only recognized as a span delimiter at word
 *              boundaries: an opener cannot be immediately preceded by a
 *              word character (`[A-Za-z0-9_]`), and a closer cannot be
 *              immediately followed by one. This protects realistic prompt
 *              content that contains C-style increment operators like
 *              `for (let i = 1; i <= 50; i++) { … }` — the `++` after `i`
 *              is glued to a word character and never starts a span.
 *
 * Stripping happens on a copy of the input — the caller is expected to apply
 * it to in-flight prompt assembly only. Stored documents are never mutated.
 *
 * Unbalanced delimiters (a lone `++` with no closing pair) are LEFT AS
 * LITERAL content rather than stripped to end-of-document, and the caller is
 * informed via `hadUnbalancedSpan` so it can log a warning identifying the
 * source document. This avoids silently swallowing the rest of an author's
 * content when they typo a single `++`.
 *
 * Pass order: span-first, then line. Otherwise a multi-line `++…++` span
 * whose body contains `%%` would have its closing `++` orphaned after the
 * line pass dropped the rest of that line.
 *
 * No escape mechanism exists for literal `%%` or `++`. Ulysses does not
 * specify one; authors who need those characters verbatim in prompt content
 * should keep them adjacent to word characters (the word-boundary rule
 * means glued-to-identifier `++` is preserved) or avoid them otherwise.
 */

export interface StripResult {
  cleaned: string;
  hadUnbalancedSpan: boolean;
}

const LINE_MARKER = '%%';
const SPAN_DELIM = '++';
const WORD_OR_PLUS_RE = /[A-Za-z0-9_+]/;

/** True iff the character at `pos` is in `[A-Za-z0-9_+]` (out-of-bounds → false). */
function isWordOrPlusAt(text: string, pos: number): boolean {
  if (pos < 0 || pos >= text.length) return false;
  return WORD_OR_PLUS_RE.test(text[pos] as string);
}

/** True iff the character at `pos` is `+` (out-of-bounds → false). */
function isPlusAt(text: string, pos: number): boolean {
  return pos >= 0 && pos < text.length && text[pos] === '+';
}

/**
 * Find the next position of a `++` span delimiter starting at or after `from`,
 * filtered by word-boundary rules:
 *   - opener: char at pos-1 is NOT word-or-plus AND char at pos+2 is NOT `+`.
 *   - closer: char at pos-1 is NOT `+` AND char at pos+2 is NOT word-or-plus.
 *
 * The "or-plus" component in the opener's left side and the closer's right
 * side prevents `+++` runs from being interpreted as a `++` delimiter
 * adjacent to a stray `+`. The pure-`+` component on the opener's right and
 * the closer's left prevents `++++` (and longer) runs from being chopped
 * into multiple delimiters.
 */
function findSpanDelim(text: string, from: number, role: 'open' | 'close'): number {
  let i = from;
  while (i <= text.length - SPAN_DELIM.length) {
    const at = text.indexOf(SPAN_DELIM, i);
    if (at === -1) return -1;
    const blocked =
      role === 'open'
        ? isWordOrPlusAt(text, at - 1) || isPlusAt(text, at + SPAN_DELIM.length)
        : isPlusAt(text, at - 1) || isWordOrPlusAt(text, at + SPAN_DELIM.length);
    if (!blocked) return at;
    i = at + 1;
  }
  return -1;
}

/**
 * Span pass: remove every `++…++` matched pair (greedy, left-to-right),
 * respecting the word-boundary rule above. If a lone `++` opener with no
 * corresponding closer remains, leave it literal and report it.
 */
function stripSpans(text: string): StripResult {
  let cleaned = '';
  let i = 0;
  while (i < text.length) {
    const open = findSpanDelim(text, i, 'open');
    if (open === -1) {
      cleaned += text.slice(i);
      return { cleaned, hadUnbalancedSpan: false };
    }
    const close = findSpanDelim(text, open + SPAN_DELIM.length, 'close');
    if (close === -1) {
      // Opener with no valid closer — leave the remainder literal.
      cleaned += text.slice(i);
      return { cleaned, hadUnbalancedSpan: true };
    }
    cleaned += text.slice(i, open);
    i = close + SPAN_DELIM.length;
  }
  return { cleaned, hadUnbalancedSpan: false };
}

/** Line pass: drop `%%` and everything after it on each line. */
function stripLineComments(text: string): string {
  if (!text.includes(LINE_MARKER)) return text;
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf(LINE_MARKER);
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Strip both Ulysses comment forms from `text`. Returns the cleaned text and
 * a flag indicating whether the span pass encountered an unbalanced `++`.
 *
 * Fast path: if the input contains neither delimiter, return it unchanged
 * without allocating a new string. The vast majority of author-supplied
 * prompt content has no comments and short-circuits here.
 */
export function stripUlyssesComments(text: string): StripResult {
  if (!text.includes(LINE_MARKER) && !text.includes(SPAN_DELIM)) {
    return { cleaned: text, hadUnbalancedSpan: false };
  }
  const spanResult = stripSpans(text);
  return {
    cleaned: stripLineComments(spanResult.cleaned),
    hadUnbalancedSpan: spanResult.hadUnbalancedSpan,
  };
}
