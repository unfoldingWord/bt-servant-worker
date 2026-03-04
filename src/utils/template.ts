/**
 * Template variable replacement for prompt overrides.
 *
 * Supports {{name}} placeholders in prompt text. Unknown variables are left as-is.
 */

import { APP_VERSION } from '../generated/version.js';
import { PromptSlot, PROMPT_OVERRIDE_SLOTS } from '../types/prompt-overrides.js';

/** Built-in template variables available in all prompt slots. */
const TEMPLATE_VARIABLES: Record<string, string> = {
  version: APP_VERSION,
};

/**
 * Replace {{name}} placeholders in text with values from the variables map.
 * Unknown variables are left as-is so they don't silently disappear.
 */
export function replaceTemplateVariables(
  text: string,
  variables: Record<string, string> = TEMPLATE_VARIABLES
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    // eslint-disable-next-line security/detect-object-injection -- name is from regex match on \w+
    const value = variables[name];
    return value !== undefined ? value : match;
  });
}

/**
 * Apply template variable replacement across all prompt slots.
 */
export function applyTemplateVariables(
  resolved: Required<Record<PromptSlot, string>>
): Required<Record<PromptSlot, string>> {
  const result = { ...resolved };
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    result[slot] = replaceTemplateVariables(result[slot]);
  }
  return result;
}
