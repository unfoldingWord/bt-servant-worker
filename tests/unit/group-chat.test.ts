import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, historyToMessages } from '../../src/services/claude/system-prompt.js';
import { DEFAULT_PROMPT_VALUES } from '../../src/types/prompt-overrides.js';
import { buildToolCatalog } from '../../src/services/mcp/catalog.js';
import { ChatHistoryEntry } from '../../src/types/engine.js';

function createEmptyCatalog() {
  return buildToolCatalog([], []);
}

const defaultPrefs = { response_language: 'en', first_interaction: false };

describe('buildSystemPrompt - group context presence', () => {
  it('includes group context section when isGroupChat is true', () => {
    const prompt = buildSystemPrompt(
      createEmptyCatalog(),
      defaultPrefs,
      [],
      DEFAULT_PROMPT_VALUES,
      { groupContext: { isGroupChat: true } }
    );
    expect(prompt).toContain('## Group Chat Context');
    expect(prompt).toContain('group conversation');
    expect(prompt).toContain('[Speaker Name] attribution');
  });

  it('excludes group context when isGroupChat is false', () => {
    const prompt = buildSystemPrompt(
      createEmptyCatalog(),
      defaultPrefs,
      [],
      DEFAULT_PROMPT_VALUES,
      { groupContext: { isGroupChat: false } }
    );
    expect(prompt).not.toContain('## Group Chat Context');
  });

  it('excludes group context when groupContext is undefined', () => {
    const prompt = buildSystemPrompt(createEmptyCatalog(), defaultPrefs, [], DEFAULT_PROMPT_VALUES);
    expect(prompt).not.toContain('## Group Chat Context');
  });
});

describe('buildSystemPrompt - group speaker info', () => {
  it('includes current speaker name when provided', () => {
    const prompt = buildSystemPrompt(
      createEmptyCatalog(),
      defaultPrefs,
      [],
      DEFAULT_PROMPT_VALUES,
      { groupContext: { isGroupChat: true, currentSpeaker: 'Alice' } }
    );
    expect(prompt).toContain('The current speaker is: Alice.');
    expect(prompt).toContain('Address the current speaker by name');
  });

  it('omits speaker-specific lines when currentSpeaker is not provided', () => {
    const prompt = buildSystemPrompt(
      createEmptyCatalog(),
      defaultPrefs,
      [],
      DEFAULT_PROMPT_VALUES,
      { groupContext: { isGroupChat: true } }
    );
    expect(prompt).toContain('## Group Chat Context');
    expect(prompt).not.toContain('The current speaker is:');
    expect(prompt).not.toContain('Address the current speaker');
  });

  it('group context appears between client_instructions and memory_instructions', () => {
    const prompt = buildSystemPrompt(
      createEmptyCatalog(),
      defaultPrefs,
      [],
      DEFAULT_PROMPT_VALUES,
      { groupContext: { isGroupChat: true, currentSpeaker: 'Bob' } }
    );
    const clientIdx = prompt.indexOf(DEFAULT_PROMPT_VALUES.client_instructions);
    const groupIdx = prompt.indexOf('## Group Chat Context');
    const memoryIdx = prompt.indexOf(DEFAULT_PROMPT_VALUES.memory_instructions);

    expect(clientIdx).toBeLessThan(groupIdx);
    expect(groupIdx).toBeLessThan(memoryIdx);
  });
});

describe('historyToMessages - speaker attribution', () => {
  it('prefixes user messages with [Speaker] when speaker is set', () => {
    const history: ChatHistoryEntry[] = [
      {
        user_message: 'Hello everyone',
        assistant_response: 'Hi there!',
        timestamp: Date.now(),
        speaker: 'Alice',
      },
    ];
    const messages = historyToMessages(history);
    expect(messages[0]!.content).toBe('[Alice]: Hello everyone');
    expect(messages[1]!.content).toBe('Hi there!');
  });

  it('does not prefix user messages when speaker is absent', () => {
    const history: ChatHistoryEntry[] = [
      { user_message: 'Hello', assistant_response: 'Hi!', timestamp: Date.now() },
    ];
    const messages = historyToMessages(history);
    expect(messages[0]!.content).toBe('Hello');
  });

  it('handles mixed history with and without speakers', () => {
    const history: ChatHistoryEntry[] = [
      {
        user_message: 'Private message',
        assistant_response: 'Private reply',
        timestamp: Date.now(),
      },
      {
        user_message: 'Group message',
        assistant_response: 'Group reply',
        timestamp: Date.now(),
        speaker: 'Bob',
      },
    ];
    const messages = historyToMessages(history);
    expect(messages[0]!.content).toBe('Private message');
    expect(messages[2]!.content).toBe('[Bob]: Group message');
  });

  it('respects maxForLLM truncation with speaker entries', () => {
    const history: ChatHistoryEntry[] = [
      {
        user_message: 'Old message',
        assistant_response: 'Old reply',
        timestamp: 1,
        speaker: 'Alice',
      },
      {
        user_message: 'New message',
        assistant_response: 'New reply',
        timestamp: 2,
        speaker: 'Bob',
      },
    ];
    const messages = historyToMessages(history, 1);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe('[Bob]: New message');
  });
});
