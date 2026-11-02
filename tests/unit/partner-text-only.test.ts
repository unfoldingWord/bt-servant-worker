/**
 * Partner API keys are text-only (decided 2026-11-02, admin-portal#354).
 *
 * Unit coverage for the pieces that implement it:
 * - callerAllowsAudio: the single predicate the DO reads from `body._caller`;
 * - buildAllTools / buildExecuteCodeTool with `hasAudio: false`: no tool that
 *   yields an audio URL is offered or named;
 * - the system prompt with `audioEnabled: false`: no request_audio guidance;
 * - validateChatBody's callback-field message for partners does not point at
 *   /api/v1/chat/callback, while the internal message is unchanged.
 *
 * End-to-end (tools actually sent to the model, dispatch refusal) lives in
 * tests/e2e/partner-api-keys.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIO_TOOL_NAMES,
  buildAllTools,
  buildExecuteCodeTool,
} from '../../src/services/claude/tools.js';
import { buildSystemPrompt } from '../../src/services/claude/system-prompt.js';
import { buildToolCatalog } from '../../src/services/mcp/catalog.js';
import { DEFAULT_PROMPT_VALUES } from '../../src/types/prompt-overrides.js';
import type { ChatRequest } from '../../src/types/engine.js';
import { callerAllowsAudio, validateChatBody } from '../../src/utils/chat-validation.js';

const catalog = buildToolCatalog([], []);
const prefs = { response_language: 'en', first_interaction: false };
const toolNames = (hasAudio?: boolean): string[] =>
  buildAllTools(catalog, hasAudio === undefined ? {} : { hasAudio }).map((t) => t.name);

describe('callerAllowsAudio', () => {
  it('is false only for partner callers', () => {
    expect(callerAllowsAudio('partner')).toBe(false);
    expect(callerAllowsAudio('internal')).toBe(true);
    expect(callerAllowsAudio(undefined)).toBe(true);
  });
});

describe('audio tools for text-only callers', () => {
  it('internal (default) keeps every audio tool', () => {
    const names = toolNames();
    for (const audioTool of AUDIO_TOOL_NAMES) expect(names).toContain(audioTool);
    expect(toolNames(true)).toEqual(names);
  });

  it('hasAudio:false drops request_audio, attach_audio and read_r2_object only', () => {
    const names = toolNames(false);
    for (const audioTool of AUDIO_TOOL_NAMES) expect(names).not.toContain(audioTool);
    const expected = toolNames().filter((n) => !AUDIO_TOOL_NAMES.has(n));
    expect(names).toEqual(expected);
  });

  it('leaves out the internal-tools parenthetical when no internal tool remains', () => {
    // Text-only caller + suppress_memory: nothing left to name.
    const description = buildExecuteCodeTool({ hasAudio: false, hasMemory: false }).description;
    expect(description).toContain('Function constructor, internal tools\n');
    expect(description).not.toContain('( —');
    expect(description).not.toContain('call these directly');
  });

  it('execute_code guidance stops naming the audio tools', () => {
    const textOnly = buildExecuteCodeTool({ hasAudio: false }).description ?? '';
    for (const audioTool of AUDIO_TOOL_NAMES) expect(textOnly).not.toContain(audioTool);
    expect(buildExecuteCodeTool().description).toContain('request_audio');
  });
});

describe('system prompt for text-only callers', () => {
  it('omits the request_audio guidance only when audioEnabled is false', () => {
    const internal = buildSystemPrompt(catalog, prefs, [], DEFAULT_PROMPT_VALUES);
    const textOnly = buildSystemPrompt(catalog, prefs, [], DEFAULT_PROMPT_VALUES, {
      audioEnabled: false,
    });
    expect(internal).toContain('request_audio');
    expect(textOnly).not.toContain('request_audio');
    expect(textOnly).not.toContain('## Audio Response');
  });
});

describe('callback-field message', () => {
  const body = {
    client_id: 'app',
    user_id: 'u',
    message: 'hi',
    message_type: 'text',
    progress_callback_url: 'https://x.example/cb',
  } as ChatRequest;

  it('internal wording is unchanged', () => {
    expect(validateChatBody(body, 'final')).toBe(
      'progress_callback_url is not valid on /api/v1/chat — use /api/v1/chat/callback'
    );
  });

  it('partner wording does not point at /chat/callback', () => {
    for (const transport of ['final', 'stream'] as const) {
      const error = validateChatBody(body, transport, { callbackAvailable: false });
      expect(error).toContain('progress_callback_url is not valid');
      expect(error).toContain('not available with partner API keys');
      expect(error).not.toContain('/api/v1/chat/callback');
    }
  });
});
