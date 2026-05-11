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
 * are out of luck for now. Document the limitation in PR notes.
 */

export interface StripResult {
  cleaned: string;
  hadUnbalancedSpan: boolean;
}

const LINE_MARKER = '%%';
const SPAN_DELIM = '++';

/**
 * Span pass: remove every `++…++` matched pair (greedy, left-to-right). If a
 * lone `++` remains, leave it literal and report it.
 */
function stripSpans(text: string): StripResult {
  let cleaned = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(SPAN_DELIM, i);
    if (open === -1) {
      cleaned += text.slice(i);
      return { cleaned, hadUnbalancedSpan: false };
    }
    const close = text.indexOf(SPAN_DELIM, open + SPAN_DELIM.length);
    if (close === -1) {
      // Lone `++` with no closing pair — leave the remainder literal.
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
