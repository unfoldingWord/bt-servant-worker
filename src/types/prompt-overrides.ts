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
export const MAX_OVERRIDE_LENGTH = 4000;

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

/** Maximum length for a mode label */
export const MAX_MODE_LABEL_LENGTH = 100;

/** Maximum length for a mode description */
export const MAX_MODE_DESCRIPTION_LENGTH = 500;

/** Valid mode name pattern: lowercase alphanumeric + hyphens, no leading/trailing hyphen */
export const MODE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * A named mode — org-level preset of prompt overrides.
 * Modes sit between org and user in the override hierarchy.
 */
export interface PromptMode {
  /** Unique slug identifier within the org (e.g., "mast-methodology") */
  name: string;
  /** Human-readable display name (e.g., "MAST Methodology") */
  label?: string;
  /** Description of what this mode does */
  description?: string;
  /** The prompt overrides for this mode — same 7 slots */
  overrides: PromptOverrides;
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
function stripControlChars(value: string): string {
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

/**
 * Validate a prompt mode object (for create/update requests).
 * Returns an error message if invalid, null if valid.
 */
export function validatePromptMode(mode: unknown): string | null {
  if (typeof mode !== 'object' || mode === null || Array.isArray(mode)) {
    return 'Mode must be a JSON object';
  }

  const obj = mode as Record<string, unknown>;

  // name is required and must pass mode name validation
  if ('name' in obj) {
    const nameError = validateModeName(obj.name);
    if (nameError) return nameError;
  }

  const labelError = validateOptionalString(obj, 'label', MAX_MODE_LABEL_LENGTH);
  if (labelError) return labelError;

  const descError = validateOptionalString(obj, 'description', MAX_MODE_DESCRIPTION_LENGTH);
  if (descError) return descError;

  if (!('overrides' in obj)) {
    return 'Mode must include an "overrides" object';
  }

  const overridesError = validatePromptOverrides(obj.overrides);
  if (overridesError) return `Mode overrides invalid: ${overridesError}`;

  return null;
}

// ─── Mode resolution ───────────────────────────────────────────────────────────

/**
 * Determine the active mode name.
 * Returns the user-selected mode, or undefined if no mode is set.
 */
export function resolveActiveModeName(userSelectedMode: string | undefined): string | undefined {
  return userSelectedMode;
}

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
