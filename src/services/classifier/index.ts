/**
 * LLM-driven intent classifier for #<mode> and @<language> trigger tokens.
 *
 * Extracts trigger tokens from the head of a user message using a lightweight
 * Haiku call for forgiving/fuzzy matching. The classifier only fires when the
 * message head contains `#` or `@` characters — the vast majority of messages
 * skip the LLM call entirely.
 */

import { RequestLogger } from '../../utils/logger.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface ClassifierResult {
  /** Resolved mode name (slug), or undefined if no #mode token found */
  modeName: string | undefined;
  /** Resolved language name (slug), or undefined if no @language token found */
  languageName: string | undefined;
  /** User message with trigger tokens stripped from the head */
  strippedMessage: string;
  /** Whether the classifier LLM call actually ran (false when pre-filter skipped it) */
  classifierRan: boolean;
  /** Latency of the classifier call in ms (only set when classifierRan is true) */
  classifierLatencyMs?: number;
  /** Soft warnings for unrecognized tokens */
  warnings: string[];
}

export interface ClassifierContext {
  apiKey: string;
  availableModes: Array<{ name: string; label?: string | undefined }>;
  availableLanguages: Array<{ name: string; label?: string | undefined }>;
  logger: RequestLogger;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const CLASSIFIER_MAX_TOKENS = 256;
const CLASSIFIER_TIMEOUT_MS = 5_000;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const CLASSIFIER_TOOL_NAME = 'extract_triggers';

const CLASSIFIER_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    mode: {
      type: 'string',
      description:
        'Matched mode slug from the available list. Omit if no #token is present at the start of the message, or if the #token does not fuzzy-match any available mode.',
    },
    mode_raw: {
      type: 'string',
      description:
        'Raw #token text with the leading # removed. Omit if no #token is present at the start of the message.',
    },
    language: {
      type: 'string',
      description:
        'Matched language slug from the available list. Omit if no @token is present at the start of the message, or if the @token does not fuzzy-match any available language.',
    },
    language_raw: {
      type: 'string',
      description:
        'Raw @token text with the leading @ removed. Omit if no @token is present at the start of the message.',
    },
    stripped_message: {
      type: 'string',
      description:
        'The message with any leading #/@ trigger tokens removed and leading whitespace trimmed. If no triggers are present, return the original message unchanged.',
    },
  },
  required: ['stripped_message'],
};

/**
 * Number of leading characters to scan for trigger-like tokens.
 * If neither `#` nor `@` appears in this prefix, the LLM call is skipped.
 */
const PRE_FILTER_PREFIX_LENGTH = 100;

// ─── Classifier prompt ──────────────────────────────────────────────────────

function buildClassifierSystemPrompt(
  modes: Array<{ name: string; label?: string | undefined }>,
  languages: Array<{ name: string; label?: string | undefined }>
): string {
  const modesList = modes.map((m) => (m.label ? `${m.name} ("${m.label}")` : m.name)).join(', ');
  const langsList = languages
    .map((l) => (l.label ? `${l.name} ("${l.label}")` : l.name))
    .join(', ');

  return `You are a message preprocessor. Extract trigger tokens from the START of a user message.

Rules:
- A mode trigger looks like #<word> at the very beginning of the message (before any natural language).
- A language trigger looks like @<word> at the very beginning of the message (before any natural language).
- Both are optional. There can be zero, one, or both.
- When both are present, they can appear in either order.
- Tokens are case-insensitive. Fuzzy-match against the available options (e.g. "#mast" matches "mast-methodology", "@arab" matches "arabic").
- After extracting tokens, return the remaining message with the trigger tokens stripped and leading whitespace trimmed.
- If a token is present but does not fuzzy-match any available option, set the matched field to null but still report the raw token text in the corresponding _raw field.

Available modes: ${modesList || '(none)'}
Available languages: ${langsList || '(none)'}

Use the ${CLASSIFIER_TOOL_NAME} tool to report your findings. Omit any field that is not applicable; only stripped_message is always required.`;
}

// ─── Local token stripping ──────────────────────────────────────────────────

/**
 * Strip leading `#word` and `@word` tokens from the message head.
 * Derived deterministically — never trusts the LLM to rewrite user text.
 */
function stripLeadingTriggerTokens(message: string): string {
  let remaining = message.trimStart();
  while (remaining.length > 0) {
    const ch = remaining[0];
    if (ch !== '#' && ch !== '@') break;
    const spaceIdx = remaining.search(/\s/);
    if (spaceIdx === -1) return '';
    remaining = remaining.slice(spaceIdx).trimStart();
  }
  return remaining;
}

// ─── Pre-filter ─────────────────────────────────────────────────────────────

/**
 * Fast check: does the message head look like it could contain trigger tokens?
 * This is a gate to decide whether to invoke the LLM, not a parser.
 */
function hasTriggerPrefix(message: string): boolean {
  const prefix = message.slice(0, PRE_FILTER_PREFIX_LENGTH);
  return prefix.includes('#') || prefix.includes('@');
}

// ─── LLM response parsing ──────────────────────────────────────────────────

interface RawClassifierResponse {
  mode: string | null;
  mode_raw: string | null;
  language: string | null;
  language_raw: string | null;
  stripped_message: string;
}

// ─── API call ───────────────────────────────────────────────────────────────

async function callClassifierAPI(
  messageText: string,
  systemPrompt: string,
  apiKey: string
): Promise<Response> {
  const requestBody = JSON.stringify({
    model: CLASSIFIER_MODEL,
    max_tokens: CLASSIFIER_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: messageText }],
    tools: [
      {
        name: CLASSIFIER_TOOL_NAME,
        description:
          'Report extracted #mode and @language trigger tokens from the start of a user message.',
        input_schema: CLASSIFIER_TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: CLASSIFIER_TOOL_NAME },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    return await globalThis.fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: requestBody,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateClassifierMatches(
  parsed: RawClassifierResponse,
  ctx: ClassifierContext
): { modeName: string | undefined; languageName: string | undefined; warnings: string[] } {
  const warnings: string[] = [];
  let modeName: string | undefined;
  let languageName: string | undefined;

  if (parsed.mode) {
    const found = ctx.availableModes.find((m) => m.name === parsed.mode);
    if (found) {
      modeName = found.name;
    } else {
      warnings.push(`Mode '#${parsed.mode}' was not recognized. Using your default mode.`);
    }
  } else if (parsed.mode_raw) {
    // LLM detected a #token but couldn't match it — warn the user
    warnings.push(`Mode '#${parsed.mode_raw}' was not recognized. Using your default mode.`);
  }

  if (parsed.language) {
    const found = ctx.availableLanguages.find((l) => l.name === parsed.language);
    if (found) {
      languageName = found.name;
    } else {
      warnings.push(
        `Language '@${parsed.language}' was not recognized. No language guidance applied.`
      );
    }
  } else if (parsed.language_raw) {
    // LLM detected an @token but couldn't match it — warn the user
    warnings.push(
      `Language '@${parsed.language_raw}' was not recognized. No language guidance applied.`
    );
  }

  return { modeName, languageName, warnings };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** True when the value is a non-null, non-array object (a record). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Locate the classifier tool_use block in an Anthropic Messages API response.
 * Returns the raw `input` record if found, otherwise null.
 */
function findClassifierToolBlock(apiResponse: unknown): Record<string, unknown> | null {
  if (!isRecord(apiResponse) || !Array.isArray(apiResponse.content)) return null;

  for (const block of apiResponse.content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'tool_use' || block.name !== CLASSIFIER_TOOL_NAME) continue;
    return isRecord(block.input) ? block.input : null;
  }
  return null;
}

/**
 * Coerce a verified tool_use input record into a RawClassifierResponse.
 * Returns null when stripped_message is missing or non-string.
 */
function coerceClassifierInput(input: Record<string, unknown>): RawClassifierResponse | null {
  if (typeof input.stripped_message !== 'string') return null;
  return {
    mode: typeof input.mode === 'string' ? input.mode : null,
    mode_raw: typeof input.mode_raw === 'string' ? input.mode_raw : null,
    language: typeof input.language === 'string' ? input.language : null,
    language_raw: typeof input.language_raw === 'string' ? input.language_raw : null,
    stripped_message: input.stripped_message,
  };
}

/**
 * Extract the classifier tool_use input from an Anthropic Messages API response.
 * Returns null if no matching tool_use block is present or its input is not the
 * shape we expect.
 */
function extractToolUseInput(apiResponse: unknown): RawClassifierResponse | null {
  const input = findClassifierToolBlock(apiResponse);
  if (!input) return null;
  return coerceClassifierInput(input);
}

/** Build a no-op result that passes the original message through unchanged. */
function noTriggerResult(messageText: string): ClassifierResult {
  return {
    modeName: undefined,
    languageName: undefined,
    strippedMessage: messageText,
    classifierRan: false,
    warnings: [],
  };
}

/** Build a fallback result when the classifier ran but failed. */
function fallbackResult(messageText: string, latencyMs: number): ClassifierResult {
  return { ...noTriggerResult(messageText), classifierRan: true, classifierLatencyMs: latencyMs };
}

// ─── Result builders ────────────────────────────────────────────────────────

/** Build the final result after a successful classifier response. */
function buildSuccessResult(
  parsed: RawClassifierResponse,
  messageText: string,
  latencyMs: number,
  ctx: ClassifierContext
): ClassifierResult {
  const { modeName, languageName, warnings } = validateClassifierMatches(parsed, ctx);
  // Strip tokens locally — never trust the LLM to rewrite user text
  const stripped = stripLeadingTriggerTokens(messageText);
  return {
    modeName,
    languageName,
    strippedMessage: stripped || messageText,
    classifierRan: true,
    classifierLatencyMs: latencyMs,
    warnings,
  };
}

// ─── Main classifier ────────────────────────────────────────────────────────

/**
 * Classify trigger tokens (#mode, @language) at the head of a user message.
 *
 * Uses a lightweight Haiku call for fuzzy matching. If the message head has no
 * trigger-like characters, returns immediately without calling the LLM.
 * On any failure, degrades gracefully by returning the original message.
 */
export async function classifyTriggers(
  messageText: string,
  ctx: ClassifierContext
): Promise<ClassifierResult> {
  if (!hasTriggerPrefix(messageText)) return noTriggerResult(messageText);
  if (ctx.availableModes.length === 0 && ctx.availableLanguages.length === 0) {
    return noTriggerResult(messageText);
  }

  const startTime = Date.now();

  try {
    const systemPrompt = buildClassifierSystemPrompt(ctx.availableModes, ctx.availableLanguages);
    const response = await callClassifierAPI(messageText, systemPrompt, ctx.apiKey);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text().catch(() => '(unreadable)');
      ctx.logger.error('classifier_http_error', null, {
        status: response.status,
        body_preview: errorText.slice(0, 300),
        latency_ms: latencyMs,
      });
      return fallbackResult(messageText, latencyMs);
    }

    const apiResponse: unknown = await response.json();
    const parsed = extractToolUseInput(apiResponse);
    if (!parsed) {
      ctx.logger.warn('classifier_tool_use_missing', {
        response_preview: JSON.stringify(apiResponse).slice(0, 300),
        latency_ms: latencyMs,
      });
      return fallbackResult(messageText, latencyMs);
    }

    return buildSuccessResult(parsed, messageText, latencyMs, ctx);
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    ctx.logger.error('classifier_call_failed', error, { latency_ms: latencyMs });
    return fallbackResult(messageText, latencyMs);
  }
}
