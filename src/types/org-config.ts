/**
 * Organization-level configuration
 *
 * These settings are stored in the ORG_CONFIG KV namespace and allow
 * per-organization customization of conversation history limits.
 */

/**
 * Organization configuration for history limits
 */
export interface OrgConfig {
  /** Max turns to STORE per user. Default: 50 */
  max_history_storage?: number;

  /** Max turns to SEND to Claude. Default: 5 */
  max_history_llm?: number;
}

/**
 * Default org config values used when not specified
 */
export const DEFAULT_ORG_CONFIG: Required<OrgConfig> = {
  max_history_storage: 50, // Store 50 for browsing
  max_history_llm: 5, // Send 5 to Claude
};

/**
 * Validation limits for org config values
 */
export const ORG_CONFIG_LIMITS = {
  max_history_storage: { min: 1, max: 100 },
  max_history_llm: { min: 1, max: 50 },
} as const;

/**
 * Validate a single integer field within a range.
 * Returns an error message if invalid, null if valid or undefined.
 */
function validateIntegerField(
  value: unknown,
  fieldName: string,
  min: number,
  max: number
): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `${fieldName} must be an integer`;
  }
  if (value < min || value > max) {
    return `${fieldName} must be between ${min} and ${max}`;
  }
  return null;
}

/**
 * Validate org config values.
 * Returns an error message if invalid, null if valid.
 */
export function validateOrgConfig(config: OrgConfig): string | null {
  const storageError = validateIntegerField(
    config.max_history_storage,
    'max_history_storage',
    ORG_CONFIG_LIMITS.max_history_storage.min,
    ORG_CONFIG_LIMITS.max_history_storage.max
  );
  if (storageError) return storageError;

  const llmError = validateIntegerField(
    config.max_history_llm,
    'max_history_llm',
    ORG_CONFIG_LIMITS.max_history_llm.min,
    ORG_CONFIG_LIMITS.max_history_llm.max
  );
  if (llmError) return llmError;

  // Cross-field validation: LLM limit should not exceed storage limit
  const storageMax = config.max_history_storage ?? DEFAULT_ORG_CONFIG.max_history_storage;
  const llmMax = config.max_history_llm ?? DEFAULT_ORG_CONFIG.max_history_llm;

  if (llmMax > storageMax) {
    return 'max_history_llm cannot exceed max_history_storage';
  }

  return null;
}
