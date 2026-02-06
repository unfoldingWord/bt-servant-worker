/**
 * Prompt override types and utilities
 *
 * Org admins can override individual prompt "slots" to customize Claude's behavior
 * without redeploying the worker. Resolution order: user → org → hardcoded default.
 */

/** Valid prompt slot names */
export const PROMPT_OVERRIDE_SLOTS = [
  'identity',
  'methodology',
  'tool_guidance',
  'instructions',
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
  closing?: string | null;
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

You have access to MCP tools for Bible translation data. To use them:

1. **Review the catalog below** to identify which tools you need
2. **Call get_tool_definitions** with the tool names to get their full schemas
3. **Use execute_code** to call the tools with the correct parameters

Example workflow:
\`\`\`
// 1. First, call get_tool_definitions to learn the schema
// 2. Then use execute_code:
const scripture = await fetch_scripture({ book: "John", chapter: 3, verse: 16 });
__result__ = scripture;
\`\`\``,

  instructions: `## Resource Usage Guidelines

IMPORTANT: You operate under strict resource limits. Follow these rules:

### Request Scope
- **NEVER** loop over more than 10 items in a single code execution
- If a request involves "entire", "all", "every", "complete", or "full" (e.g., "entire book", "all chapters"), STOP and ask the user to narrow the scope
- Prefer summaries and overviews over exhaustive data fetching

### Before Acting on Broad Requests
If a request would require many tool calls (more than 5), ask a clarifying question FIRST:
- "That covers a lot of content. Would you like me to start with a specific subset?"
- "Which specific chapters or verses are most relevant to your translation work?"
- "Should I provide a high-level summary first?"

### Resource Limits
- Maximum 10 MCP tool calls per code execution
- If you exceed this limit, execution will fail - plan accordingly
- Break large tasks into multiple interactions with user confirmation

### Partial Results Pattern
When you can only fetch part of what the user asked for:
1. Fetch a reasonable batch (5-10 items max)
2. Present what you got: "I've fetched the first 10 chapters of Genesis..."
3. Offer to continue: "Would you like me to continue with chapters 11-20?"
4. Wait for user confirmation before fetching more

### Examples
BAD: Looping over all chapters: \`for (let i = 1; i <= 50; i++) { await fetch_scripture(...) }\`
GOOD: Ask "Genesis has 50 chapters. Which chapters would you like me to focus on?"
GOOD: Fetch first 5, say "I've retrieved Genesis 1-5. Would you like me to continue with 6-10?"`,

  closing: `Always be accurate and cite your sources when providing information about scripture.`,
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
 * Resolve prompt overrides: user → org → default.
 * Only non-empty string values override; null/undefined/empty are skipped
 * (inherit from next level). This provides defensive validation against
 * corrupted or manually-edited KV/DO data.
 */
export function resolvePromptOverrides(
  orgOverrides: PromptOverrides,
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
    const userVal = userOverrides[slot];
    if (typeof userVal === 'string' && userVal.trim()) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
      resolved[slot] = stripControlChars(userVal);
    }
  }
  return resolved;
}
