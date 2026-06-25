/**
 * Prompt override types and utilities
 *
 * Org admins can override individual prompt "slots" to customize Claude's behavior
 * without redeploying the worker. Resolution order: user → mode → org → hardcoded default.
 */

/** Valid prompt slot names */
export const PROMPT_OVERRIDE_SLOTS = [
  'identity',
  'methodology',
  'tool_guidance',
  'instructions',
  'client_instructions',
  'memory_instructions',
  'closing',
] as const;

export type PromptSlot = (typeof PROMPT_OVERRIDE_SLOTS)[number];

/** Max characters per slot */
export const MAX_OVERRIDE_LENGTH = 8000;

/**
 * Prompt overrides — each slot is optional.
 * - undefined = not set (inherit from next level)
 * - null = used in PUT requests to delete an override; after merge it becomes
 *   undefined in storage, so resolution only ever sees string | undefined
 * - string = override value
 */
export interface PromptOverrides {
  identity?: string | null;
  methodology?: string | null;
  tool_guidance?: string | null;
  instructions?: string | null;
  client_instructions?: string | null;
  memory_instructions?: string | null;
  closing?: string | null;
}

// ─── Mode types ────────────────────────────────────────────────────────────────

/** Maximum number of modes per org */
export const MAX_MODES_PER_ORG = 20;

/** Maximum length for a mode name (slug) */
export const MAX_MODE_NAME_LENGTH = 64;

/**
 * Maximum number of aliases a single mode may carry. Aliases accumulate one
 * per rename/retire, so this bounds pathological growth from repeated renames.
 * Comfortably above any realistic number of renames for one mode.
 */
export const MAX_MODE_ALIASES = 20;

/** Maximum length for a mode label */
export const MAX_MODE_LABEL_LENGTH = 100;

/** Maximum length for a mode description */
export const MAX_MODE_DESCRIPTION_LENGTH = 500;

/**
 * Maximum length for a mode markdown document (Phase 1 of #200).
 * Comfortably above the worst case of 7 × MAX_OVERRIDE_LENGTH plus heading
 * overhead.
 */
export const MAX_MODE_DOCUMENT_LENGTH = 64_000;

/** Valid mode name pattern: lowercase alphanumeric + hyphens, no leading/trailing hyphen */
export const MODE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * A named mode — org-level preset of prompt overrides.
 * Modes sit between org and user in the override hierarchy.
 *
 * Storage shape: exactly one of `overrides` or `document` is present at a
 * time (Phase 1 of issue #200). Legacy modes carry `overrides` (a slot map);
 * modes saved through the new portal markdown editor carry `document` (a
 * single markdown blob with H2 sections per slot). Phase 2 will backfill the
 * remaining legacy records and drop the slot-map shape entirely.
 *
 * Chat-time consumers read `mode.overrides` indirectly via
 * `getEffectiveOverrides()` (see `./mode-markdown.ts`) so they never need to
 * care which shape is in storage.
 */
export interface PromptMode {
  /** Unique slug identifier within the org (e.g., "mast-methodology") */
  name: string;
  /**
   * Old slugs that also resolve to this mode (issue #284). When a mode is
   * renamed/reslugged, its previous slug is kept here so subscribers whose
   * persisted `selected_mode` still holds the old slug are rerouted at lookup
   * time instead of being stranded on the org default.
   *
   * Resolve-time only: aliases are honored by `findModeBySlug` but are NEVER
   * surfaced as selectable options (list_modes / switch_mode / the `#`-trigger
   * show only the canonical `name`/`label`). Each alias must be unique across
   * every name and alias within the org (see `checkModeSlugUniqueness`).
   */
  aliases?: string[];
  /** Human-readable display name (e.g., "MAST Methodology") */
  label?: string;
  /** Description of what this mode does */
  description?: string;
  /**
   * Whether this mode is visible to end users via list_modes/switch_mode.
   * `true` => user-visible. Anything else (`false`, `undefined`, missing) => draft.
   * Admin endpoints always return all modes regardless of this flag.
   */
  published?: boolean;
  /**
   * Whether this mode requires a group chat (Telegram group/supergroup) to
   * function. Group-only modes depend on multi-speaker attribution, ambient
   * voice capture, and leader gating that do not exist in 1:1 chats. When
   * `true`, the mode is hidden from list_modes / the `#`-trigger and is not
   * applied at chat time for non-group, non-admin requests. Absent/`false`
   * => available everywhere (unchanged behavior).
   */
  requires_group?: boolean;
  /** Legacy slot-map storage shape. Present iff this mode has not been migrated. */
  overrides?: PromptOverrides;
  /** Markdown storage shape (H2 per slot). Present iff this mode has been migrated. */
  document?: string;
}

/**
 * Collection of modes stored per org.
 * Stored in PROMPT_OVERRIDES KV at key "{org}:modes".
 */
export interface OrgModes {
  /** All defined modes for this org */
  modes: PromptMode[];
}

/**
 * Mode context passed to the orchestrator for list_modes / switch_mode tools.
 */
export interface ModeContext {
  /** All modes available for this org */
  availableModes: PromptMode[];
  /** Currently active mode name (if any) */
  activeModeName: string | undefined;
  /** Callback to persist the user's mode selection */
  setSelectedMode: (name: string | null) => Promise<void>;
}

/**
 * Hardcoded defaults — used when neither org nor user has set a value.
 * Each value is the COMPLETE text injected at that slot position, headers included.
 */
export const DEFAULT_PROMPT_VALUES: Required<Record<PromptSlot, string>> = {
  identity: `You are BT Servant, a helpful assistant for Bible translators. You help with:
- Looking up scripture passages and references
- Checking translation notes and resources
- Answering questions about biblical languages (Hebrew, Greek, Aramaic)
- Providing translation suggestions and alternatives
- Explaining cultural and historical context`,

  methodology: `## Teaching Framework and Methodology

Help the user understand God's word better. Make the user a better translator.`,

  tool_guidance: `## How to Use Tools

You have access to MCP tools. To use them:

1. **Review the catalog below** to identify which tools you need
2. **Call get_tool_definitions** with the tool names to get their full schemas
3. **Use execute_code** to call the tools with the correct parameters from the schema`,

  instructions: `## Resource Usage Guidelines

IMPORTANT: You operate under strict resource limits. Follow these rules:

### Request Scope
- **NEVER** loop over more than 10 items in a single code execution
- If a request involves "entire", "all", "every", "complete", or "full" scope, STOP and ask the user to narrow it
- Prefer summaries and overviews over exhaustive data fetching

### Before Acting on Broad Requests
If a request would require many tool calls (more than 5), ask a clarifying question FIRST:
- "That covers a lot of content. Would you like me to start with a specific subset?"
- "Should I provide a high-level summary first?"

### Resource Limits
- Maximum 10 MCP tool calls per code execution
- If you exceed this limit, execution will fail - plan accordingly
- Break large tasks into multiple interactions with user confirmation

### Partial Results Pattern
When you can only fetch part of what the user asked for:
1. Fetch a reasonable batch (5-10 items max)
2. Present what you have so far
3. Offer to continue with the next batch
4. Wait for user confirmation before fetching more`,

  client_instructions: `Adapt your response style to the client platform the user is on.
For messaging clients like WhatsApp, be EXTREMELY concise. Short sentences. No walls of text. Get to the point immediately. Users are on small screens and reading long messages is painful — treat every word as expensive. WhatsApp has a 1600 character limit per message — stay comfortably under that. Use emojis extremely sparingly — one or two at most, not scattered throughout.`,

  memory_instructions: `## User Memory

Below is a table of contents of this user's persistent memory. Use the read_memory tool to retrieve specific sections when needed for context. Use the update_memory tool to save important information that should persist across conversations — such as user preferences discovered through interaction and key decisions.

Keep memory organized with clear section names. Remove outdated information when updating. Be concise — store conclusions and decisions, not full conversation transcripts.`,

  closing: `Always be accurate and cite your sources when providing information.`,
};

/** Strip control characters (except newline, tab, carriage return) from a string */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: stripping control chars for safety
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Validate prompt overrides.
 * Returns an error message if invalid, null if valid.
 */
export function validatePromptOverrides(overrides: unknown): string | null {
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return 'Prompt overrides must be a JSON object';
  }

  const obj = overrides as Record<string, unknown>;
  const validKeys = new Set<string>(PROMPT_OVERRIDE_SLOTS);

  for (const key of Object.keys(obj)) {
    if (!validKeys.has(key)) {
      return `Unknown prompt slot: "${key}". Valid slots: ${PROMPT_OVERRIDE_SLOTS.join(', ')}`;
    }

    // eslint-disable-next-line security/detect-object-injection -- key validated above
    const value = obj[key];
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value !== 'string') {
      return `Slot "${key}" must be a string or null`;
    }

    if (value.length > MAX_OVERRIDE_LENGTH) {
      return `Slot "${key}" exceeds maximum length of ${MAX_OVERRIDE_LENGTH} characters (got ${value.length})`;
    }
  }

  return null;
}

// ─── Mode validation ───────────────────────────────────────────────────────────

/**
 * Validate a mode name (slug).
 * Returns an error message if invalid, null if valid.
 */
export function validateModeName(name: unknown): string | null {
  if (typeof name !== 'string') {
    return 'Mode name must be a string';
  }
  if (name.length === 0) {
    return 'Mode name must not be empty';
  }
  if (name.length > MAX_MODE_NAME_LENGTH) {
    return `Mode name exceeds maximum length of ${MAX_MODE_NAME_LENGTH} characters`;
  }
  if (!MODE_NAME_PATTERN.test(name)) {
    return 'Mode name must be lowercase alphanumeric with hyphens (e.g., "mast-methodology")';
  }
  return null;
}

/**
 * Validate a mode's `aliases` field (format only — cross-mode uniqueness is
 * enforced separately by `checkModeSlugUniqueness`, which needs the full org
 * mode list). `undefined` / missing is accepted (no aliases).
 *
 * Returns an error message if invalid, null if valid.
 */
export function validateModeAliases(aliases: unknown): string | null {
  if (aliases === undefined) return null;
  if (!Array.isArray(aliases)) return 'Mode aliases must be an array of strings';
  if (aliases.length > MAX_MODE_ALIASES) {
    return `Mode cannot have more than ${MAX_MODE_ALIASES} aliases`;
  }
  const seen = new Set<string>();
  for (const alias of aliases) {
    const nameError = validateModeName(alias);
    if (nameError) return `Invalid alias: ${nameError}`;
    if (seen.has(alias as string)) {
      return `Duplicate alias "${alias as string}"`;
    }
    seen.add(alias as string);
  }
  return null;
}

/**
 * Find the mode that owns `slug`, matching either its canonical `name` or any
 * of its `aliases` (issue #284). Single source of truth for slug → mode
 * resolution: every lookup site (chat-time resolver, switch_mode, the
 * `#`-trigger classifier's exact tier, admin get-by-slug) routes through this
 * so a renamed mode keeps answering to its old slug.
 *
 * Returns the matched mode (whose `.name` is the canonical slug) or undefined.
 */
export function findModeBySlug(modes: PromptMode[], slug: string): PromptMode | undefined {
  return modes.find((m) => m.name === slug || m.aliases?.includes(slug) === true);
}

/**
 * Enforce the org-wide slug uniqueness invariant for issue #284: a candidate's
 * slugs (its `name` plus every alias) may not collide with any OTHER mode's
 * `name` or aliases within the org, and may not contain internal duplicates.
 *
 * `excludeNames` lists the canonical names of modes that should NOT be checked
 * against — the candidate itself on an in-place rename, or a soon-to-be-deleted
 * source mode on retire-and-forward.
 *
 * Returns an error message naming the colliding slug, or null if unique.
 */
export function checkModeSlugUniqueness(
  modes: PromptMode[],
  candidateSlugs: string[],
  excludeNames: ReadonlyArray<string> = []
): string | null {
  const excluded = new Set(excludeNames);
  const taken = new Set<string>();
  for (const mode of modes) {
    if (excluded.has(mode.name)) continue;
    taken.add(mode.name);
    for (const alias of mode.aliases ?? []) taken.add(alias);
  }

  const seen = new Set<string>();
  for (const slug of candidateSlugs) {
    if (seen.has(slug)) {
      return `Slug "${slug}" is duplicated`;
    }
    seen.add(slug);
    if (taken.has(slug)) {
      return `Slug "${slug}" already belongs to another mode (as a name or alias) in this org`;
    }
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
  if (typeof value !== 'boolean') return `Mode ${field} must be a boolean`;
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
  if (typeof value !== 'string') return `Mode ${field} must be a string`;
  if (value.length > maxLength) {
    return `Mode ${field} exceeds maximum length of ${maxLength} characters`;
  }
  return null;
}

/** Validate the content portion (overrides vs document) of a mode payload. */
function validateModeContentField(obj: Record<string, unknown>): string | null {
  const hasOverrides = 'overrides' in obj;
  const hasDocument = 'document' in obj;

  if (hasOverrides && hasDocument) {
    return 'Mode must specify either "document" or "overrides", not both';
  }
  if (!hasOverrides && !hasDocument) {
    return 'Mode must include either a "document" string or an "overrides" object';
  }

  if (hasOverrides) {
    const overridesError = validatePromptOverrides(obj.overrides);
    return overridesError ? `Mode overrides invalid: ${overridesError}` : null;
  }

  // Inline document validation (avoid cross-module circular import by
  // duplicating the small check; mode-markdown.ts has the canonical helper
  // that admin handlers can also call for explicit-error paths).
  const doc = obj.document;
  if (typeof doc !== 'string') return 'Mode document must be a string';
  if (doc.length > MAX_MODE_DOCUMENT_LENGTH) {
    return `Mode document exceeds maximum length of ${MAX_MODE_DOCUMENT_LENGTH} characters (got ${doc.length})`;
  }
  return null;
}

/**
 * Validate a prompt mode object (for create/update requests).
 *
 * Accepts either of two shapes:
 *   - Legacy: `{ ..., overrides: PromptOverrides }`
 *   - Markdown (post-#200 portal): `{ ..., document: string }`
 *
 * Rejects bodies that include both fields (forces the caller to pick a
 * shape — accepting both invites ambiguity about precedence) or neither.
 *
 * Returns an error message if invalid, null if valid.
 */
export function validatePromptMode(mode: unknown): string | null {
  const obj = asPlainObject(mode);
  if (!obj) return 'Mode must be a JSON object';

  const scalarError =
    ('name' in obj ? validateModeName(obj.name) : null) ??
    validateOptionalString(obj, 'label', MAX_MODE_LABEL_LENGTH) ??
    validateOptionalString(obj, 'description', MAX_MODE_DESCRIPTION_LENGTH) ??
    validateOptionalBoolean(obj, 'published') ??
    validateOptionalBoolean(obj, 'requires_group') ??
    validateModeAliases(obj.aliases);
  if (scalarError) return scalarError;

  return validateModeContentField(obj);
}

/**
 * Whether a mode should be visible to (and usable by) the caller in the
 * current chat context. Single source of truth shared by list_modes /
 * switch_mode (`buildModeContext`), the `#`-trigger classifier, and
 * active-mode application (`resolveEffectiveMode`).
 *
 * - Admins (admin-origin client) see every mode regardless of context.
 * - Otherwise the mode must be published AND, if it requires a group chat,
 *   the current chat must be a group.
 */
export function isModeVisible(
  mode: Pick<PromptMode, 'published' | 'requires_group'>,
  opts: { isGroupChat: boolean; isAdmin: boolean }
): boolean {
  if (opts.isAdmin) return true;
  if (mode.published !== true) return false;
  return mode.requires_group !== true || opts.isGroupChat;
}

// ─── Mode resolution ───────────────────────────────────────────────────────────

/**
 * Determine the active mode name.
 * Returns the user-selected mode, or undefined if no mode is set.
 */
export function resolveActiveModeName(userSelectedMode: string | undefined): string | undefined {
  return userSelectedMode;
}

// `resolveEffectiveMode` lives in `./mode-markdown.ts` because it needs to
// parse the markdown storage shape back into slots on demand, and keeping it
// there avoids a circular import between this file and `mode-markdown.ts`.

/**
 * Type-safe merge of prompt override updates into an existing overrides object.
 * - null values delete the slot (revert to inherited behavior)
 * - string values set the slot (after stripping control characters)
 * - undefined values are ignored
 */
export function mergePromptOverrides(
  existing: PromptOverrides,
  updates: PromptOverrides
): PromptOverrides {
  const merged: PromptOverrides = { ...existing };
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    const value = updates[slot];
    if (value === null) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
      delete merged[slot];
    } else if (typeof value === 'string') {
      // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
      merged[slot] = stripControlChars(value);
    }
  }
  return merged;
}

/**
 * Resolve prompt overrides: user → mode → org → default.
 * Only non-empty string values override; null/undefined/empty are skipped
 * (inherit from next level). This provides defensive validation against
 * corrupted or manually-edited KV/DO data.
 */
export function resolvePromptOverrides(
  orgOverrides: PromptOverrides,
  modeOverrides: PromptOverrides,
  userOverrides: PromptOverrides
): Required<Record<PromptSlot, string>> {
  const resolved = { ...DEFAULT_PROMPT_VALUES };
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    const orgVal = orgOverrides[slot];
    if (typeof orgVal === 'string' && orgVal.trim()) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
      resolved[slot] = stripControlChars(orgVal);
    }
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    const modeVal = modeOverrides[slot];
    if (typeof modeVal === 'string' && modeVal.trim()) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
      resolved[slot] = stripControlChars(modeVal);
    }
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    const userVal = userOverrides[slot];
    if (typeof userVal === 'string' && userVal.trim()) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
      resolved[slot] = stripControlChars(userVal);
    }
  }
  return resolved;
}
