/**
 * System prompt builder for Claude orchestration
 */

import { ChatHistoryEntry } from '../../types/engine.js';
import { generateToolCatalog, ToolCatalog } from '../mcp/index.js';

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

## How to Use Tools

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
\`\`\`

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

  // Add tool catalog (compact format - name + one-liner only)
  const toolCatalog = generateToolCatalog(catalog);
  sections.push('\n\n' + toolCatalog);

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
    sections.push("\n\nThis is the user's first interaction. Briefly welcome them.");
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
