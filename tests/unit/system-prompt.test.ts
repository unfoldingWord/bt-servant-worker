import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/services/claude/system-prompt.js';
import { DEFAULT_PROMPT_VALUES } from '../../src/types/prompt-overrides.js';
import { buildToolCatalog } from '../../src/services/mcp/catalog.js';

function createEmptyCatalog() {
  return buildToolCatalog([], []);
}

const defaultPrefs = { response_language: 'en', first_interaction: false };

describe('buildSystemPrompt - slot assembly', () => {
  it('includes all default slots', () => {
    const prompt = buildSystemPrompt(createEmptyCatalog(), defaultPrefs, [], DEFAULT_PROMPT_VALUES);

    expect(prompt).toContain(DEFAULT_PROMPT_VALUES.identity);
    expect(prompt).toContain(DEFAULT_PROMPT_VALUES.methodology);
    expect(prompt).toContain(DEFAULT_PROMPT_VALUES.tool_guidance);
    expect(prompt).toContain(DEFAULT_PROMPT_VALUES.instructions);
    expect(prompt).toContain(DEFAULT_PROMPT_VALUES.closing);
  });

  it('assembles slots in correct order', () => {
    const prompt = buildSystemPrompt(createEmptyCatalog(), defaultPrefs, [], DEFAULT_PROMPT_VALUES);

    const identityIdx = prompt.indexOf(DEFAULT_PROMPT_VALUES.identity);
    const methodologyIdx = prompt.indexOf(DEFAULT_PROMPT_VALUES.methodology);
    const toolGuidanceIdx = prompt.indexOf(DEFAULT_PROMPT_VALUES.tool_guidance);
    const instructionsIdx = prompt.indexOf(DEFAULT_PROMPT_VALUES.instructions);
    const closingIdx = prompt.indexOf(DEFAULT_PROMPT_VALUES.closing);

    expect(identityIdx).toBeLessThan(methodologyIdx);
    expect(methodologyIdx).toBeLessThan(toolGuidanceIdx);
    expect(toolGuidanceIdx).toBeLessThan(instructionsIdx);
    expect(instructionsIdx).toBeLessThan(closingIdx);
  });

  it('sections are separated by double newlines', () => {
    const prompt = buildSystemPrompt(createEmptyCatalog(), defaultPrefs, [], DEFAULT_PROMPT_VALUES);
    const sections = prompt.split('\n\n');
    expect(sections.length).toBeGreaterThan(1);
  });
});

describe('buildSystemPrompt - custom overrides', () => {
  it('uses overridden values at each slot position', () => {
    const custom = {
      identity: 'CUSTOM_IDENTITY',
      methodology: 'CUSTOM_METHODOLOGY',
      tool_guidance: 'CUSTOM_TOOL_GUIDANCE',
      instructions: 'CUSTOM_INSTRUCTIONS',
      closing: 'CUSTOM_CLOSING',
    };

    const prompt = buildSystemPrompt(createEmptyCatalog(), defaultPrefs, [], custom);

    expect(prompt).toContain('CUSTOM_IDENTITY');
    expect(prompt).toContain('CUSTOM_METHODOLOGY');
    expect(prompt).toContain('CUSTOM_TOOL_GUIDANCE');
    expect(prompt).toContain('CUSTOM_INSTRUCTIONS');
    expect(prompt).toContain('CUSTOM_CLOSING');
    expect(prompt).not.toContain(DEFAULT_PROMPT_VALUES.identity);
    expect(prompt).not.toContain(DEFAULT_PROMPT_VALUES.methodology);
  });
});

describe('buildSystemPrompt - tool catalog', () => {
  it('includes tool catalog between tool_guidance and instructions', () => {
    const catalog = buildToolCatalog(
      [
        {
          serverId: 's1',
          serverName: 'S1',
          tools: [{ name: 'my_tool', description: 'A test tool', inputSchema: { type: 'object' } }],
        },
      ],
      [{ id: 's1', name: 'S1', url: 'http://test', enabled: true, priority: 1 }]
    );

    const prompt = buildSystemPrompt(catalog, defaultPrefs, [], DEFAULT_PROMPT_VALUES);

    // Underscores are escaped in the markdown tool catalog table (my_tool → my\_tool)
    expect(prompt).toContain('my\\_tool');
    expect(prompt).toContain('A test tool');

    const toolGuidanceIdx = prompt.indexOf(DEFAULT_PROMPT_VALUES.tool_guidance);
    const catalogIdx = prompt.indexOf('my\\_tool');
    const instructionsIdx = prompt.indexOf(DEFAULT_PROMPT_VALUES.instructions);

    expect(toolGuidanceIdx).toBeLessThan(catalogIdx);
    expect(catalogIdx).toBeLessThan(instructionsIdx);
  });
});

describe('buildSystemPrompt - conditional sections', () => {
  it('includes user preferences when language is not English', () => {
    const prefs = { response_language: 'es', first_interaction: false };
    const prompt = buildSystemPrompt(createEmptyCatalog(), prefs, [], DEFAULT_PROMPT_VALUES);
    expect(prompt).toContain('## User Preferences');
    expect(prompt).toContain('Respond in es when possible');
  });

  it('excludes user preferences when language is English', () => {
    const prompt = buildSystemPrompt(createEmptyCatalog(), defaultPrefs, [], DEFAULT_PROMPT_VALUES);
    expect(prompt).not.toContain('## User Preferences');
  });

  it('includes conversation context when history is present', () => {
    const history = [{ user_message: 'Hello', assistant_response: 'Hi', timestamp: Date.now() }];
    const prompt = buildSystemPrompt(
      createEmptyCatalog(),
      defaultPrefs,
      history,
      DEFAULT_PROMPT_VALUES
    );
    expect(prompt).toContain('## Recent Conversation Context');
  });

  it('excludes conversation context when history is empty', () => {
    const prompt = buildSystemPrompt(createEmptyCatalog(), defaultPrefs, [], DEFAULT_PROMPT_VALUES);
    expect(prompt).not.toContain('## Recent Conversation Context');
  });

  it('includes first interaction note when first_interaction is true', () => {
    const prefs = { response_language: 'en', first_interaction: true };
    const prompt = buildSystemPrompt(createEmptyCatalog(), prefs, [], DEFAULT_PROMPT_VALUES);
    expect(prompt).toContain("This is the user's first interaction");
  });

  it('excludes first interaction note when first_interaction is false', () => {
    const prompt = buildSystemPrompt(createEmptyCatalog(), defaultPrefs, [], DEFAULT_PROMPT_VALUES);
    expect(prompt).not.toContain("This is the user's first interaction");
  });
});
