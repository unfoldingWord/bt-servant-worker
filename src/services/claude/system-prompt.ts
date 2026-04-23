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
  isVoiceMessage?: boolean | undefined;
}

/** Max length for speaker names (prevents prompt bloat). */
const MAX_SPEAKER_LENGTH = 64;

/** Sanitize a speaker name: strip brackets, trim, and limit length. */
export function sanitizeSpeaker(name: string): string {
  return name.replace(/[[\]]/g, '').trim().slice(0, MAX_SPEAKER_LENGTH) || 'Unknown';
}

const AUDIO_GUIDANCE =
  '## Audio Response (IMPORTANT)\n\n' +
  'You have a `request_audio` tool. You MUST call it when any of these apply:\n' +
  '- The user asks to "hear", "listen to", or "read aloud" something\n' +
  '- The user says "I want to listen to..." or similar\n' +
  '- The user explicitly requests audio, voice, or spoken output\n\n' +
  'Call `request_audio` FIRST, before writing your text response. ' +
  'Your text response will then be automatically converted to speech.';

/**
 * Core voice-friendly writing rules. Shared between the system prompt
 * (voice-to-voice flow) and the request_audio tool result (text-to-audio flow).
 */
export const VOICE_WRITING_RULES =
  'Write for LISTENING, not reading:\n' +
  '- Use natural, conversational language as if speaking to someone\n' +
  '- Do NOT use any markdown formatting — no bold, italic, headers, bullet lists, or code blocks\n' +
  '- Use verbal transitions ("First,", "Now,", "The key thing here is") instead of visual structure\n' +
  '- Keep sentences short and clear — a listener cannot re-read a confusing sentence\n' +
  '- Spell out abbreviations and reference notations that would sound awkward spoken aloud\n' +
  '- For scripture references, say the full book name naturally ("Genesis chapter one, verse one") rather than shorthand\n' +
  '- Summarize key points — oral learners benefit from brief repetition\n' +
  '- Keep your response concise — audio responses over two minutes feel long\n' +
  '- Do NOT narrate your actions (avoid "Let me look that up" or "I\'ll search for that") — just give the answer';

/**
 * Planning-scope rules for voice mode. Prevents Claude from cascading into
 * follow-up tool calls to enrich a voice answer beyond what the user literally
 * asked for. Targets planning (how many tools to call), not tone — the sibling
 * VOICE_WRITING_RULES covers tone. Only injected when isVoiceMessage=true; text
 * mode responses are unchanged.
 */
const VOICE_PLANNING_RULES =
  'Plan for a spoken answer:\n' +
  '- Answer what was asked, nothing more. Use the minimum tool calls needed to answer the literal question.\n' +
  '- Do NOT cascade into follow-up tool calls to enrich the answer. Example: if the user asks for a LIST of items, give the list — do not then fetch per-item details for each one. If the user wants details, they will ask.\n' +
  '- Multiple tool calls ARE fine when they are required to answer the literal question (e.g., fetching two translations to compare them). The rule is: no enrichment beyond what was asked.\n' +
  '- A brief answer that ends with "Would you like me to go deeper on any of these?" is better than a comprehensive answer that blows past the original question.';

const VOICE_RESPONSE_GUIDANCE =
  '## Voice Response Mode (ACTIVE)\n\n' +
  'The user sent a voice message and will hear your response as spoken audio.\n\n' +
  VOICE_WRITING_RULES +
  '\n\n' +
  VOICE_PLANNING_RULES;

// Non-overridable rendering contract. Downstream clients (web, WhatsApp) parse
// Claude's output for media URLs and render them natively — this rule set is
// the wire format between the worker and those clients. Do not move this into
// a prompt-override slot: an org accidentally clobbering it breaks inline
// media rendering across every conversation for that org.
//
// Not injected in voice mode: VOICE_WRITING_RULES forbids markdown, and the
// TTS path strips markdown before synthesis — so emitting media URLs in
// markdown shapes there would either contradict the voice guidance or lose
// the URL entirely when it reaches the user as audio.
const MEDIA_FORMATTING_RULES =
  '## Media URL formatting (REQUIRED)\n\n' +
  'When referencing a URL returned by a tool, use EXACTLY these formats:\n\n' +
  '- **Image URLs** ending in `.jpg`, `.jpeg`, `.png`, `.webp`, or `.gif` → use markdown image syntax: `![descriptive alt text](url)`. ' +
  'NEVER use link syntax `[text](url)` for an image URL. NEVER emit a bare image URL.\n' +
  '- **Video URLs** ending in `.mp4`, `.webm`, `.mov`, `.m4v`, or `.ogv` → use markdown link syntax: `[descriptive label](url)`. ' +
  'NEVER wrap a video URL with `!` (never `![…](url.mp4)`). NEVER emit a bare video URL.\n\n' +
  '## Never invent URLs\n\n' +
  "You may ONLY reference media URLs that were explicitly present in a tool's return value.\n" +
  '- If a tool result has an empty or missing field for a media item (e.g., `Video:` with no URL), DO NOT emit a reference for that item. ' +
  'Skip it or say "no video available for this passage."\n' +
  '- NEVER construct a URL by pattern-matching from another field (e.g., do not derive a video URL from a photo URL by swapping path segments like `photos/…` → `videos/…`).\n' +
  '- Copy URLs verbatim from tool output.\n\n' +
  '## One media item per response\n\n' +
  "When sharing multiple media items (images or videos), emit each one as its own response, with the relevant context or caption as that response's prose.\n" +
  '- DO NOT combine multiple `![alt](url)` or `[label](url)` items into a single response.\n' +
  '- A single image accompanied by prose context in the same response is fine; the constraint is on multi-item responses, not on prose-plus-one-media.\n\n' +
  '## No pre-labeled markdown images\n\n' +
  "The markdown alt text IS the image's label — downstream clients render it as the caption.\n" +
  '- Write `![Mount Tabor Map](url)`, NOT `Mount Tabor Map:\\n![Mount Tabor Map](url)`.\n' +
  '- Pre-labeling in prose creates duplicate captions on the rendered message.';

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
    const safe = sanitizeSpeaker(groupContext.currentSpeaker);
    lines.push(`The current speaker is: ${safe}.`);
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
 *   [memory_instructions + TOC] → [audio guidance] → [voice guidance] →
 *   [user preferences] → [conversation context] → [first interaction] →
 *   [media formatting rules (non-overridable, text mode only)] → [closing]
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
  if (options?.isVoiceMessage) {
    sections.push(VOICE_RESPONSE_GUIDANCE);
  }
  sections.push(...buildConditionalSections(preferences, history));
  if (!options?.isVoiceMessage) {
    sections.push(MEDIA_FORMATTING_RULES);
  }
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
      ? `[${sanitizeSpeaker(entry.speaker)}]: ${entry.user_message}`
      : entry.user_message;
    messages.push({ role: 'user', content: userContent });
    messages.push({ role: 'assistant', content: entry.assistant_response });
  }

  return messages;
}
