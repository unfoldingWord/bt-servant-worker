/**
 * Written-language detection for a single user turn (#404).
 *
 * Contract:
 *   - Telemetry only. The result is recorded on the `chat_turn` log record
 *     and echoed as `ChatResponse.input_language`; it never drives the reply
 *     language (`response_language` is set only through `PUT /preferences`
 *     and the per-turn `response_language_hint`).
 *   - `{ code, confidence }` is a confident ISO 639-1 read. `null` means "no
 *     confident read", never "English", and is recorded as
 *     {@link UNDETERMINED_LANGUAGE}.
 *   - `confidence` is the relative margin between the detector's top two
 *     candidates, `1 - second / top`, in [0, 1].
 *   - Never throws. A detector failure is logged once as
 *     `language_detect_failed` on the request logger and treated as `null`.
 *
 * Backed by `tinyld/light` (24 languages). The franc-min bake-off and the
 * threshold calibration are in the #404 PR body. Callers pass the
 * classifier's already-stripped message, so matched `#mode` / `@language`
 * tokens never reach the detector.
 */

import { detectAll } from 'tinyld/light';
import type { RequestLogger } from '../../utils/logger.js';

export interface DetectedLanguage {
  /** ISO 639-1 code, lowercase (e.g. `pt`). */
  code: string;
  /** Relative margin over the runner-up candidate, in [0, 1]. */
  confidence: number;
}

/**
 * Recorded as `input_language` when detection returns `null`: ISO 639-2's
 * "undetermined" code, so the field is always a string and can never collide
 * with a real ISO 639-1 value.
 */
export const UNDETERMINED_LANGUAGE = 'und';

/**
 * Upper bound on the characters handed to the detector. Detection cost grows
 * with input length, and the first two thousand characters carry all the
 * signal a per-turn read needs. Applied before any other processing.
 */
export const MAX_DETECT_CHARS = 2000;

/** Minimum letters (Unicode `\p{L}`) in the prepared text; below this there is nothing to detect. */
export const MIN_LETTERS = 20;

/**
 * Minimum distinct words in the prepared text. tinyld scores word by word,
 * so one token repeated is one vote counted many times, not evidence of a
 * language (`xyzzy xyzzy xyzzy xyzzy xyzzy` otherwise reads as pl @ 0.99).
 */
export const MIN_DISTINCT_WORDS = 4;

/**
 * Minimum tinyld `accuracy` for the top candidate. Below a unique-n-gram hit
 * (1.0), accuracy is roughly (words voting for the top language) / letters,
 * so under 0.06 well under half the words agree. That is the band where the
 * 24-language light set lands on languages it does not know (Indonesian → tr
 * 0.057, Swahili → fi 0.047). It costs one in-set fixture, an English
 * sentence at 0.041, which is recorded as "und": precision over recall.
 */
export const MIN_ACCURACY = 0.06;

/**
 * Minimum {@link DetectedLanguage.confidence}. Rejects in-set near-ties
 * (pt/it/es at 0.07) and mixed-language sentences (en/es at 0.02); the lowest
 * correct fixture read is 0.42.
 */
export const MIN_CONFIDENCE = 0.3;

// ── Pre-strip patterns ────────────────────────────────────────────────────────
// Only tokens that carry no information about the language the user WRITES
// in. Digits and punctuation are left alone: they never count as letters and
// tinyld's own cleaner discards them. Scripture references stay too, because
// the book name (João / John / Juan / Yohana) is a word in the user's language.

/** `https://…`, `http://…`, `www.…` up to the next whitespace. */
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;

/**
 * Residual `#hashtag` / `@handle` words. The classifier has already removed
 * leading trigger tokens that matched a configured mode or language; whatever
 * still starts with `#` or `@` (unmatched tokens the classifier leaves in
 * place, social hashtags, email handles, addressee mentions) carries no
 * signal about the language the user writes in.
 */
const HASHTAG_OR_HANDLE_PATTERN = /(?<![\p{L}\p{N}])[#@][\p{L}\p{N}_-]+/gu;

/** Pictographic emoji plus the variation selector / ZWJ that join sequences. */
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu;

const LETTER_PATTERN = /\p{L}/gu;
const WORD_PATTERN = /\p{L}+/gu;

/**
 * Remove URLs, residual hashtags / handles and emoji, collapsing the
 * whitespace they leave behind. Exported for direct testing.
 */
export function stripNonLinguistic(text: string): string {
  return text
    .replace(URL_PATTERN, ' ')
    .replace(HASHTAG_OR_HANDLE_PATTERN, ' ')
    .replace(EMOJI_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The exact text handed to the detector: the first {@link MAX_DETECT_CHARS}
 * characters, then {@link stripNonLinguistic}. Exported for direct testing.
 */
export function prepareForDetection(text: string): string {
  return stripNonLinguistic(text.slice(0, MAX_DETECT_CHARS));
}

function countLetters(text: string): number {
  return text.match(LETTER_PATTERN)?.length ?? 0;
}

/**
 * Distinct word tokens after normalization: NFC, case-folded, letters only.
 * Punctuation and case variants of one token (`xyzzy, Xyzzy. XYZZY!`) must
 * collapse to one word, or the repeated-token safeguard is trivially bypassed.
 */
function countDistinctWords(text: string): number {
  return new Set(text.normalize('NFC').toLowerCase().match(WORD_PATTERN) ?? []).size;
}

/** Enough letters and enough distinct words for the detector's vote to mean anything. */
function hasEnoughSignal(prepared: string): boolean {
  return (
    countLetters(prepared) >= MIN_LETTERS && countDistinctWords(prepared) >= MIN_DISTINCT_WORDS
  );
}

function roundConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Reduce tinyld's ranked candidates to one confident read, or `null`.
 * Candidates arrive sorted by `accuracy` descending. `lang` is ISO 639-1 for
 * every language in the light set (pinned by a test over
 * `supportedLanguages`), so no further shape check is needed here.
 */
function pickConfident(
  candidates: ReadonlyArray<{ lang: string; accuracy: number }>
): DetectedLanguage | null {
  const [top, second] = candidates;
  if (!top || top.accuracy < MIN_ACCURACY) return null;
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
  logger: RequestLogger
): DetectedLanguage | null {
  try {
    const prepared = prepareForDetection(text);
    if (!hasEnoughSignal(prepared)) return null;
    return pickConfident(detectAll(prepared));
  } catch (error) {
    logger.warn('language_detect_failed', {
      error: error instanceof Error ? error.message : String(error),
      text_length: text.length,
    });
    // Explicitly degrade to "no read": detection is telemetry and must never
    // fail a chat turn.
    return null;
  }
}
