/**
 * Language scaffold types and validation
 *
 * Per-org default template for new language documents. Stored in
 * PROMPT_OVERRIDES KV at `${org}:language-scaffold`. When no org-level
 * override exists, the bundled DEFAULT_LANGUAGE_SCAFFOLD is returned.
 */

import { stripControlChars } from './prompt-overrides.js';

/** Maximum length for a scaffold document (markdown) */
export const MAX_SCAFFOLD_DOCUMENT_LENGTH = 64000;

/**
 * A per-org scaffold — the markdown template pre-populated into newly
 * created language documents.
 */
export interface LanguageScaffold {
  /** Markdown template with H2 sections and %% guidance comments */
  document: string;
}

/**
 * Bundled default scaffold returned when no org-level override exists.
 * Admins can override this per-org via PUT.
 */
export const DEFAULT_LANGUAGE_SCAFFOLD: LanguageScaffold = {
  document: `## Tone & Register
%% Describe the appropriate tone (formal, informal, colloquial) and register for this language. Consider audience, context, and cultural expectations.

## Word Choice
%% Note any preferred vocabulary, phrasing conventions, or word-level translation preferences for this language.

## Lexicon (DCV Overrides)
%% List any terms where the default DCV glossary entries should be overridden for this language. Format: Term → Override.

## Cultural Notes
%% Capture cultural context that affects translation choices — idioms, metaphors, taboo words, honorific systems, or other pragmatic considerations.

## Examples
%% Provide example translations that illustrate the above guidelines. Include source text and target text pairs where possible.
`,
};

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a language scaffold object (for PUT requests).
 * Returns an error message if invalid, null if valid.
 */
export function validateLanguageScaffold(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return 'Language scaffold must be a JSON object';
  }

  const obj = input as Record<string, unknown>;

  if (obj.document === undefined || obj.document === null) {
    return 'Language scaffold must include a "document" string';
  }
  if (typeof obj.document !== 'string') {
    return 'Language scaffold document must be a string';
  }
  if (obj.document.length > MAX_SCAFFOLD_DOCUMENT_LENGTH) {
    return `Language scaffold document exceeds maximum length of ${MAX_SCAFFOLD_DOCUMENT_LENGTH} characters (got ${obj.document.length})`;
  }

  return null;
}

/**
 * Sanitize a scaffold document by stripping control characters.
 * Mirrors sanitizeLanguageDocument in languages.ts.
 */
export function sanitizeScaffoldDocument(document: string): string {
  return stripControlChars(document);
}
