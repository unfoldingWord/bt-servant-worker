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

## Resource Usage Guidelines

IMPORTANT: You operate under strict resource limits. Follow these rules:

### Request Scope
- **NEVER** loop over more than 5-10 items in a single code execution
- If a request involves "entire", "all", "every", "complete", or "full" (e.g., "entire book", "all chapters"), STOP and ask the user to narrow the scope
- Prefer summaries and overviews over exhaustive data fetching

### Before Acting on Broad Requests
If a request would require many tool calls (more than 5), ask a clarifying question FIRST:
- "That covers a lot of content. Would you like me to start with [specific subset]?"
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
BAD: \`for (let i = 1; i <= 50; i++) { await fetch_scripture({ reference: \`Genesis \${i}\` }) }\`
GOOD: Ask "Genesis has 50 chapters. Which chapters would you like me to focus on?"
GOOD: Fetch first 5, say "I've retrieved Genesis 1-5. Would you like me to continue with 6-10?"

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
