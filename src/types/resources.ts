/**
 * Aggregated MCP resource listing — canonical types (worker#257, portal#230).
 *
 * The worker owns per-server adapters that normalize each MCP server's
 * listing output into the canonical shape below. Servers are NOT asked to
 * conform (translation-helps is near-identity; aquifer's markdown is parsed
 * and mapped). The portal mirrors these types verbatim.
 *
 * Contract locked on portal#230 (2026-07-07 / signed off 2026-07-13):
 *   GET /api/v1/admin/orgs/:org/resources?language=xx
 */

/** Maximum length for the `language` query param (defensive bound). */
export const MAX_RESOURCE_LANGUAGE_LENGTH = 16;

/**
 * Language code pattern: IETF-style tag as used by translation-helps
 * (e.g. "en", "id", "sw", "es-419"). Adapters translate to each server's
 * own vocabulary where it differs (aquifer wants ISO 639-3, e.g. "eng").
 */
export const RESOURCE_LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;

/**
 * Canonical subject (category) slugs. The worker normalizes each server's
 * vocabulary onto these keys so the portal sees stable category names:
 *
 * - translation-helps subjects: "Bible" → bible, "Aligned Bible" →
 *   aligned-bible, "Translation Words" → translation-words, "Translation
 *   Academy" → translation-academy, "TSV Translation Notes" →
 *   translation-notes, "TSV Translation Questions" → translation-questions,
 *   "TSV Translation Words Links" → translation-words-links
 * - aquifer display types: "Bible Dictionary" → dictionary, "Study Notes" →
 *   study-notes, "Translation Guide" → translation-notes, "Bible Translation
 *   Manual" → translation-academy, "Translation Glossary" →
 *   translation-words, "Comprehension Testing" → translation-questions,
 *   "Foundational Bible Stories" → bible-stories, "Images, Maps, Videos" →
 *   media, "Thematic Dictionary" → dictionary, "Semantic Lexicon" → lexicon,
 *   "Bible" → bible
 *
 * The key set is OPEN: a server vocabulary term with no mapping is
 * slugified as-is (lowercase kebab-case) rather than dropped, so new server
 * categories degrade to "unknown but visible" instead of disappearing.
 */
export const KNOWN_SUBJECTS = [
  'bible',
  'aligned-bible',
  'bible-stories',
  'dictionary',
  'lexicon',
  'media',
  'study-notes',
  'translation-academy',
  'translation-notes',
  'translation-questions',
  'translation-words',
  'translation-words-links',
] as const;

export type KnownSubject = (typeof KNOWN_SUBJECTS)[number];

/** Display labels for the known subject slugs (portal may override). */
export const SUBJECT_LABELS: Record<KnownSubject, string> = {
  bible: 'Bible Translations',
  'aligned-bible': 'Aligned Bible Translations',
  'bible-stories': 'Bible Stories',
  dictionary: 'Dictionaries',
  lexicon: 'Lexicons',
  media: 'Images, Maps & Videos',
  'study-notes': 'Study Notes',
  'translation-academy': 'Translation Academy',
  'translation-notes': 'Translation Notes',
  'translation-questions': 'Translation Questions',
  'translation-words': 'Translation Words',
  'translation-words-links': 'Translation Words Links',
};

/**
 * One resource, normalized. Field provenance:
 * - translation-helps: identity on {name, subject, organization, version?,
 *   url?}; `label` left unset (names like "en_ult" are already the display
 *   handle there).
 * - aquifer: `name` = resource_code (e.g. "BiblicaStudyNotes"), `label` =
 *   display title (e.g. "Biblica Study Notes"), `organization` derived from
 *   the resource_code prefix where known, `articleCount` parsed from the
 *   listing. No version/url in its listing output.
 */
export interface ResourceItem {
  /** Server-scoped identifier (resource slug / code). */
  name: string;
  /** Canonical subject slug (see KNOWN_SUBJECTS; open set). */
  subject: string;
  /** Which MCP server supplied this item (MCPServerConfig.id). */
  serverId: string;
  /** Human-readable title, when it differs from `name`. */
  label?: string;
  /** Publishing organization, where the server exposes/implies one. */
  organization?: string;
  /** Resource version, where the server exposes one. */
  version?: string;
  /** Resource URL, where the server exposes one. */
  url?: string;
  /** Number of articles/entries, where the server exposes a count. */
  articleCount?: number;
}

/**
 * Resources grouped by canonical subject slug. Within a subject, items keep
 * server-default order, servers concatenated in ascending `priority` order
 * (the same comparator the chat path uses).
 */
export type ResourcesBySubject = Record<string, ResourceItem[]>;

/**
 * Per-server outcome for the aggregation fan-out — the "honest gap"
 * mechanism from worker#257:
 * - `ok` — listing succeeded (possibly zero resources for this language)
 * - `unsupported` — server exposes no known listing tool (e.g. FIA);
 *   permanent until the server gains the capability
 * - `error` — discovery or the listing call failed (transient; retryable)
 */
export type ResourceServerStatus = 'ok' | 'unsupported' | 'error';

export interface ResourceServerReport {
  serverId: string;
  serverName: string;
  status: ResourceServerStatus;
  /** Present iff status === 'error'. */
  error?: string;
}

/** Response body for GET /api/v1/admin/orgs/:org/resources?language=xx */
export interface AggregatedResourcesResponse {
  org: string;
  language: string;
  resources: ResourcesBySubject;
  servers: ResourceServerReport[];
}

/**
 * Item 2 of worker#257 (not served by the endpoint above; defined here so
 * the full contract lives in one file): per-mode category prioritization,
 * stored as a new optional field on PromptMode. Stores ordering INTENT over
 * subject slugs — never a resolved resource snapshot.
 */
export interface ResourcePriority {
  /** Subject slugs, most-preferred first. */
  order: string[];
  /** Subject slugs to exclude — honored only where the backing server
   * supports category filtering (translation-helps `subject`, aquifer
   * `type`); soft prompt-bias elsewhere. */
  excluded?: string[];
}

/**
 * Validate the `language` query param. Returns an error message if invalid,
 * null if valid. Mirrors the validator style in languages.ts.
 */
export function validateResourceLanguage(language: unknown): string | null {
  if (typeof language !== 'string' || language.length === 0) {
    return 'Query param "language" is required (e.g. ?language=en)';
  }
  if (language.length > MAX_RESOURCE_LANGUAGE_LENGTH) {
    return `Language exceeds maximum length of ${MAX_RESOURCE_LANGUAGE_LENGTH} characters`;
  }
  if (!RESOURCE_LANGUAGE_PATTERN.test(language)) {
    return 'Language must be an IETF-style code (e.g. "en", "sw", "es-419")';
  }
  return null;
}
