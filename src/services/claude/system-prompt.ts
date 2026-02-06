/**
 * System prompt builder for Claude orchestration
 */

import { ChatHistoryEntry } from '../../types/engine.js';
import { PromptSlot } from '../../types/prompt-overrides.js';
import { generateToolCatalog, ToolCatalog } from '../mcp/index.js';

/**
 * Orchestration preferences (subset of full user preferences)
 */
export interface OrchestrationPreferences {
  response_language: string;
  first_interaction: boolean;
}

/**
 * Build the full system prompt with tool catalog and user context.
 *
 * Assembly order:
 *   [identity] → [methodology] → [tool_guidance] → [tool catalog] →
 *   [instructions] → [user preferences] → [conversation context] →
 *   [first interaction] → [closing]
 */
export function buildSystemPrompt(
  catalog: ToolCatalog,
  preferences: OrchestrationPreferences,
  history: ChatHistoryEntry[],
  resolvedPromptValues: Required<Record<PromptSlot, string>>
): string {
  const sections: string[] = [];

  // Slot: identity
  sections.push(resolvedPromptValues.identity);

  // Slot: methodology
  sections.push(resolvedPromptValues.methodology);

  // Slot: tool_guidance
  sections.push(resolvedPromptValues.tool_guidance);

  // Tool catalog (always generated from MCP servers — NOT a slot)
  const toolCatalog = generateToolCatalog(catalog);
  sections.push(toolCatalog);

  // Slot: instructions
  sections.push(resolvedPromptValues.instructions);

  // Conditional: user preferences
  if (preferences.response_language !== 'en') {
    sections.push(
      `## User Preferences\n\nRespond in ${preferences.response_language} when possible.`
    );
  }

  // Conditional: conversation context
  if (history.length > 0) {
    sections.push(
      '## Recent Conversation Context\nThe user has been in conversation. Consider this context when responding.'
    );
  }

  // Conditional: first interaction
  if (preferences.first_interaction) {
    sections.push("This is the user's first interaction. Briefly welcome them.");
  }

  // Slot: closing
  sections.push(resolvedPromptValues.closing);

  return sections.join('\n\n');
}

/**
 * Convert chat history to Anthropic message format
 *
 * @param history - Full chat history from storage
 * @param maxForLLM - Maximum number of turns to include (for token efficiency)
 */
export function historyToMessages(
  history: ChatHistoryEntry[],
  maxForLLM?: number
): Array<{ role: 'user' | 'assistant'; content: string }> {
  // Truncate history to most recent entries if limit is specified
  const truncated = maxForLLM !== undefined ? history.slice(-maxForLLM) : history;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const entry of truncated) {
    messages.push({ role: 'user', content: entry.user_message });
    messages.push({ role: 'assistant', content: entry.assistant_response });
  }

  return messages;
}
