/**
 * Written-language detection for a single user turn (#404).
 *
 * Deterministic and local: no LLM call, no network, no per-org configuration.
 * Backed by `tinyld/light` — chosen over `franc-min` because on the
 * Portuguese / English / Spanish / Italian fixture set it separated pt from
 * es/it on every sentence where franc-min misread 3 of 10 Portuguese
 * sentences as Spanish, and because it returns ISO 639-1 codes directly
 * (franc returns ISO 639-3 and would need a mapping table). See the #404 PR
 * body for the measurements.
 *
 * What callers get back:
 *   - `{ code, confidence }` when the text carries enough linguistic signal
 *     AND the detector's top candidate wins by a clear margin, or
 *   - `null` — meaning "no confident read", never "English". Short acks,
 *     bare scripture references, `#mode` / `@language` trigger tokens, emoji
 *     and URLs are stripped first; if fewer than {@link MIN_LETTERS} letters
 *     remain there is nothing to detect.
 *
 * Confidence is the relative margin between the top two candidates,
 * `1 - second / top`, in [0, 1]. tinyld's raw per-language `accuracy` is NOT
 * used as the cutoff because it is not calibrated across its two passes: a
 * unique-n-gram hit scores 1.0, while a correct multi-word statistical read
 * scores roughly 1 / average-word-length (0.04–0.12 on the fixture set). The
 * margin is comparable across both and separates the fixture set cleanly
 * (lowest correct read 0.41; the one genuine pt/it/es near-tie 0.07).
 *
 * This function never throws. A detector failure is logged once as
 * `language_detect_failed` on the request logger and treated as `null`.
 * `logger` is optional only so the function stays a pure utility for callers
 * outside a request context (tests, scripts); every request-path caller MUST
 * pass the request logger so a failure stays observable and correlated.
 */

import { detectAll } from 'tinyld/light';
import type { RequestLogger } from '../../utils/logger.js';

export interface DetectedLanguage {
  /** ISO 639-1 code, lowercase (e.g. `pt`). */
  code: string;
  /** Relative margin over the runner-up candidate, in [0, 1]. */
  confidence: number;
}

/** Minimum letters (Unicode `\p{L}`) remaining after the pre-strip. */
export const MIN_LETTERS = 20;

/** Minimum {@link DetectedLanguage.confidence} for a non-null result. */
export const MIN_CONFIDENCE = 0.3;

// ── Pre-strip patterns ────────────────────────────────────────────────────────
// Anything that carries no information about the language the user WRITES in.

/** `https://…`, `http://…`, `www.…` up to the next whitespace. */
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;

/** `#mode` / `@language` trigger tokens (any hashtag or handle — never prose). */
const TRIGGER_TOKEN_PATTERN = /(?<![\p{L}\p{N}])[#@][\p{L}\p{N}_-]+/gu;

/**
 * `book chapter:verse[-verse][, verse…]` with an optional leading book number:
 * `João 3:16`, `Gen 1:1-5`, `1 Cor 13:4-7`, `Rom. 8:28, 31`.
 */
const CHAPTER_VERSE_REF_PATTERN =
  /(?<![\p{L}\p{N}])(?:[1-3]\s*)?\p{L}+\.?\s*\d+\s*:\s*\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*/gu;

/** `N book chapter` without a verse: `1 Cor 13`, `2 Reis 5`. */
const NUMBERED_BOOK_REF_PATTERN = /(?<![\p{L}\p{N}])[1-3]\s*\p{L}+\.?\s*\d+(?![\p{L}\p{N}])/gu;

/** Pictographic emoji plus the variation selector / ZWJ that join sequences. */
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu;

const LETTER_PATTERN = /\p{L}/gu;
const ISO_639_1_PATTERN = /^[a-z]{2}$/;

/**
 * Remove URLs, scripture references, trigger tokens and emoji, collapsing the
 * whitespace they leave behind. Exported for direct testing.
 */
export function stripNonLinguistic(text: string): string {
  return text
    .replace(URL_PATTERN, ' ')
    .replace(TRIGGER_TOKEN_PATTERN, ' ')
    .replace(CHAPTER_VERSE_REF_PATTERN, ' ')
    .replace(NUMBERED_BOOK_REF_PATTERN, ' ')
    .replace(EMOJI_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countLetters(text: string): number {
  return text.match(LETTER_PATTERN)?.length ?? 0;
}

function roundConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Reduce tinyld's ranked candidates to one confident read, or `null`.
 * Candidates arrive sorted by `accuracy` descending.
 */
function pickConfident(
  candidates: ReadonlyArray<{ lang: string; accuracy: number }>
): DetectedLanguage | null {
  const [top, second] = candidates;
  if (!top || !(top.accuracy > 0)) return null;
  // tinyld/light reports ISO 639-1 for every language in its light set, but
  // the wider tinyld table carries a few 3-letter codes; `response_language`
  // is validated as ISO 639-1 downstream, so anything else is not a usable read.
  if (!ISO_639_1_PATTERN.test(top.lang)) return null;
  const confidence = roundConfidence(second ? 1 - second.accuracy / top.accuracy : 1);
  if (confidence < MIN_CONFIDENCE) return null;
  return { code: top.lang, confidence };
}

/**
 * Detect the language `text` is written in. See the module comment for the
 * contract; in short: a confident ISO 639-1 read, or `null`. Never throws.
 */
export function detectWrittenLanguage(
  text: string,
  logger?: RequestLogger
): DetectedLanguage | null {
  const stripped = stripNonLinguistic(text);
  if (countLetters(stripped) < MIN_LETTERS) return null;
  try {
    return pickConfident(detectAll(stripped));
  } catch (error) {
    logger?.warn('language_detect_failed', {
      error: error instanceof Error ? error.message : String(error),
      text_length: text.length,
      stripped_length: stripped.length,
    });
    // Explicitly degrade to "no read": detection is advisory input to the
    // response-language preference and must never fail a chat turn.
    return null;
  }
}
