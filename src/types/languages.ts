/**
 * Language types and validation
 *
 * Per-language tuning files (tone, register, lexicon, DCV overrides) that
 * compose with mode files at chat time. Stored in PROMPT_OVERRIDES KV at
 * `${org}:languages`. Mirrors the modes surface (auth, response shape,
 * read-modify-write) but with a single markdown `document` instead of
 * slotted overrides.
 */

import { stripControlChars } from './prompt-overrides.js';

/** Maximum number of languages per org */
export const MAX_LANGUAGES_PER_ORG = 20;

/** Maximum length for a language name (slug) */
export const MAX_LANGUAGE_NAME_LENGTH = 64;

/** Maximum length for a language label */
export const MAX_LANGUAGE_LABEL_LENGTH = 100;

/** Maximum length for a language document (markdown) */
export const MAX_LANGUAGE_DOCUMENT_LENGTH = 64000;

/** Valid language name pattern: lowercase alphanumeric + hyphens, no leading/trailing hyphen */
export const LANGUAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * A named language — org-level markdown document used to shape per-language
 * behavior (tone, register, lexicon).
 */
export interface Language {
  /** Unique slug identifier within the org (e.g., "arabic") */
  name: string;
  /** Human-readable display name (e.g., "Arabic") */
  label?: string;
  /** Single markdown document — the editable per-language tuning file */
  document: string;
  /**
   * Whether this language is visible to end users.
   * `true` => user-visible. Anything else (`false`, `undefined`, missing) => draft.
   * Admin endpoints always return all languages regardless of this flag.
   */
  published?: boolean;
}

/**
 * Collection of languages stored per org.
 * Stored in PROMPT_OVERRIDES KV at key "{org}:languages".
 */
export interface OrgLanguages {
  /** All defined languages for this org */
  languages: Language[];
}

/**
 * Language context passed to the orchestrator for list_languages / switch_language tools.
 * Mirrors `ModeContext` from prompt-overrides.ts.
 */
export interface LanguageContext {
  /** All languages available for this org (filtered by publish status for non-admins) */
  availableLanguages: Language[];
  /** Currently active language name (if any) */
  activeLanguageName: string | undefined;
  /** Callback to persist the user's language selection */
  setSelectedLanguage: (name: string | null) => Promise<void>;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a language name (slug).
 * Returns an error message if invalid, null if valid.
 */
export function validateLanguageName(name: unknown): string | null {
  if (typeof name !== 'string') {
    return 'Language name must be a string';
  }
  if (name.length === 0) {
    return 'Language name must not be empty';
  }
  if (name.length > MAX_LANGUAGE_NAME_LENGTH) {
    return `Language name exceeds maximum length of ${MAX_LANGUAGE_NAME_LENGTH} characters`;
  }
  if (!LANGUAGE_NAME_PATTERN.test(name)) {
    return 'Language name must be lowercase alphanumeric with hyphens (e.g., "arabic")';
  }
  return null;
}

/** Narrow `unknown` to a plain object (not array, not null). */
function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Validate an optional boolean field. `undefined` / missing are accepted. */
function validateOptionalBoolean(obj: Record<string, unknown>, field: string): string | null {
  const value = obj[field]; // eslint-disable-line security/detect-object-injection -- field is hardcoded
  if (value === undefined) return null;
  if (typeof value !== 'boolean') return `Language ${field} must be a boolean`;
  return null;
}

/** Validate an optional string field with a max length. */
function validateOptionalString(
  obj: Record<string, unknown>,
  field: string,
  maxLength: number
): string | null {
  const value = obj[field]; // eslint-disable-line security/detect-object-injection -- field is hardcoded
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return `Language ${field} must be a string`;
  if (value.length > maxLength) {
    return `Language ${field} exceeds maximum length of ${maxLength} characters`;
  }
  return null;
}

/** Validate the required `document` field. */
function validateLanguageDocument(value: unknown): string | null {
  if (value === undefined || value === null) {
    return 'Language must include a "document" string';
  }
  if (typeof value !== 'string') {
    return 'Language document must be a string';
  }
  if (value.length > MAX_LANGUAGE_DOCUMENT_LENGTH) {
    return `Language document exceeds maximum length of ${MAX_LANGUAGE_DOCUMENT_LENGTH} characters (got ${value.length})`;
  }
  return null;
}

/**
 * Validate a language object (for create/update requests).
 * Returns an error message if invalid, null if valid.
 */
export function validateLanguage(language: unknown): string | null {
  const obj = asPlainObject(language);
  if (!obj) return 'Language must be a JSON object';

  const scalarError =
    ('name' in obj ? validateLanguageName(obj.name) : null) ??
    validateOptionalString(obj, 'label', MAX_LANGUAGE_LABEL_LENGTH) ??
    validateOptionalBoolean(obj, 'published') ??
    validateLanguageDocument(obj.document);
  if (scalarError) return scalarError;

  return null;
}

/**
 * Sanitize a language's document by stripping control characters.
 * Mirrors the treatment of mode override slot values.
 */
export function sanitizeLanguageDocument(document: string): string {
  return stripControlChars(document);
}
