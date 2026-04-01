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

export interface GroupChatContext {
  /** Whether this is a group or supergroup chat */
  isGroupChat: boolean;
  /** Display name of the current speaker */
  currentSpeaker?: string;
}

interface SystemPromptOptions {
  memoryTOC?: string | undefined;
  clientId?: string | undefined;
  groupContext?: GroupChatContext | undefined;
}

const AUDIO_GUIDANCE =
  '## Audio Response (IMPORTANT)\n\n' +
  'You have a `request_audio` tool. You MUST call it when any of these apply:\n' +
  '- The user asks to "hear", "listen to", or "read aloud" something\n' +
  '- The user says "I want to listen to..." or similar\n' +
  '- The user explicitly requests audio, voice, or spoken output\n\n' +
  'Call `request_audio` FIRST, before writing your text response. ' +
  'Your text response will then be automatically converted to speech.';

/** Build the client platform + client_instructions section. */
function buildClientSection(clientId: string | undefined, clientInstructions: string): string {
  const parts: string[] = [];
  if (clientId) {
    parts.push(`## Client Platform\nThe user is communicating via: ${clientId}`);
  }
  parts.push(clientInstructions);
  return parts.join('\n\n');
}

/** Build the group chat context section, or null if not a group chat. */
function buildGroupSection(groupContext: GroupChatContext | undefined): string | null {
  if (!groupContext?.isGroupChat) return null;
  const lines = [
    '## Group Chat Context',
    'You are in a group conversation. Messages come from different participants.',
  ];
  if (groupContext.currentSpeaker) {
    lines.push(`The current speaker is: ${groupContext.currentSpeaker}.`);
    lines.push('Address the current speaker by name when responding.');
  }
  lines.push('Previous messages show [Speaker Name] attribution.');
  return lines.join('\n');
}

/** Build conditional tail sections (preferences, history context, first interaction). */
function buildConditionalSections(
  preferences: OrchestrationPreferences,
  history: ChatHistoryEntry[]
): string[] {
  const sections: string[] = [];
  if (preferences.response_language !== 'en') {
    sections.push(
      `## User Preferences\n\nRespond in ${preferences.response_language} when possible.`
    );
  }
  if (history.length > 0) {
    sections.push(
      '## Recent Conversation Context\nThe user has been in conversation. Consider this context when responding.'
    );
  }
  if (preferences.first_interaction) {
    sections.push("This is the user's first interaction. Briefly welcome them.");
  }
  return sections;
}

/**
 * Build the full system prompt with tool catalog and user context.
 *
 * Assembly order:
 *   [identity] → [methodology] → [tool_guidance] → [tool catalog] →
 *   [instructions] → [client_instructions] → [group context] →
 *   [memory_instructions + TOC] → [audio guidance] →
 *   [user preferences] → [conversation context] → [first interaction] → [closing]
 */
export function buildSystemPrompt(
  catalog: ToolCatalog,
  preferences: OrchestrationPreferences,
  history: ChatHistoryEntry[],
  resolvedPromptValues: Required<Record<PromptSlot, string>>,
  options?: SystemPromptOptions
): string {
  const { memoryTOC, clientId, groupContext } = options ?? {};
  const sections: string[] = [
    resolvedPromptValues.identity,
    resolvedPromptValues.methodology,
    resolvedPromptValues.tool_guidance,
    generateToolCatalog(catalog),
    resolvedPromptValues.instructions,
    buildClientSection(clientId, resolvedPromptValues.client_instructions),
  ];

  const groupSection = buildGroupSection(groupContext);
  if (groupSection) sections.push(groupSection);

  sections.push(resolvedPromptValues.memory_instructions);
  if (memoryTOC) sections.push(memoryTOC);
  sections.push(AUDIO_GUIDANCE);
  sections.push(...buildConditionalSections(preferences, history));
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
    const userContent = entry.speaker
      ? `[${entry.speaker}]: ${entry.user_message}`
      : entry.user_message;
    messages.push({ role: 'user', content: userContent });
    messages.push({ role: 'assistant', content: entry.assistant_response });
  }

  return messages;
}
