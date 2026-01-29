/**
 * System prompt builder for Claude orchestration
 */

import { ChatHistoryEntry } from '../../types/engine.js';
import { generateToolDescriptions, ToolCatalog } from '../mcp/index.js';

/**
 * Orchestration preferences (subset of full user preferences)
 */
export interface OrchestrationPreferences {
  response_language: string;
  first_interaction: boolean;
}

const BASE_SYSTEM_PROMPT = `You are BT Servant, a helpful assistant for Bible translators. You help with:
- Looking up scripture passages and references
- Checking translation notes and resources
- Answering questions about biblical languages (Hebrew, Greek, Aramaic)
- Providing translation suggestions and alternatives
- Explaining cultural and historical context

You have access to various tools to help with these tasks. When a user asks a question:
1. If you need specific scripture or translation data, use the available MCP tools
2. For complex operations requiring multiple lookups or data transformation, use execute_code
3. For simple lookups, call MCP tools directly

Always be accurate and cite your sources when providing information about scripture.`;

/**
 * Build the full system prompt with tool catalog and user context
 */
export function buildSystemPrompt(
  catalog: ToolCatalog,
  preferences: OrchestrationPreferences,
  history: ChatHistoryEntry[]
): string {
  const sections: string[] = [BASE_SYSTEM_PROMPT];

  // Add tool descriptions
  const toolDescriptions = generateToolDescriptions(catalog);
  sections.push('\n\n## Available Tools\n\n' + toolDescriptions);

  // Add user preferences
  if (preferences.response_language !== 'en') {
    sections.push(
      `\n\n## User Preferences\n\nRespond in ${preferences.response_language} when possible.`
    );
  }

  // Add conversation context if there's history
  if (history.length > 0) {
    sections.push('\n\n## Recent Conversation Context');
    sections.push('The user has been in conversation. Consider this context when responding.');
  }

  // Add first interaction note
  if (preferences.first_interaction) {
    sections.push("\n\nThis is the user's first interaction. Welcome them briefly.");
  }

  return sections.join('');
}

/**
 * Convert chat history to Anthropic message format
 */
export function historyToMessages(
  history: ChatHistoryEntry[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const entry of history) {
    messages.push({ role: 'user', content: entry.user_message });
    messages.push({ role: 'assistant', content: entry.assistant_response });
  }

  return messages;
}
