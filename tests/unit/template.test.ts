import { describe, it, expect } from 'vitest';
import { replaceTemplateVariables, applyTemplateVariables } from '../../src/utils/template.js';
import { DEFAULT_PROMPT_VALUES } from '../../src/types/prompt-overrides.js';

describe('replaceTemplateVariables', () => {
  it('replaces known variables', () => {
    expect(replaceTemplateVariables('v{{version}}', { version: '2.0.0' })).toBe('v2.0.0');
  });

  it('leaves unknown variables intact', () => {
    expect(replaceTemplateVariables('{{unknown}}', { version: '2.0.0' })).toBe('{{unknown}}');
  });

  it('replaces multiple occurrences', () => {
    const result = replaceTemplateVariables('{{version}} and {{version}}', { version: '1.0.0' });
    expect(result).toBe('1.0.0 and 1.0.0');
  });

  it('handles text with no placeholders', () => {
    expect(replaceTemplateVariables('no placeholders here', { version: '1.0.0' })).toBe(
      'no placeholders here'
    );
  });

  it('handles empty string', () => {
    expect(replaceTemplateVariables('', { version: '1.0.0' })).toBe('');
  });

  it('replaces multiple different variables', () => {
    const result = replaceTemplateVariables('{{a}} and {{b}}', { a: 'X', b: 'Y' });
    expect(result).toBe('X and Y');
  });

  it('uses built-in TEMPLATE_VARIABLES by default', () => {
    const result = replaceTemplateVariables('v{{version}}');
    // Should replace with the actual APP_VERSION value
    expect(result).not.toContain('{{version}}');
    expect(result).toMatch(/^v\d+\.\d+\.\d+/);
  });
});

describe('applyTemplateVariables', () => {
  it('replaces {{version}} across all prompt slots', () => {
    const input = {
      ...DEFAULT_PROMPT_VALUES,
      identity: 'Bot v{{version}}',
      closing: 'Running {{version}}',
    };

    const result = applyTemplateVariables(input);

    expect(result.identity).not.toContain('{{version}}');
    expect(result.identity).toMatch(/^Bot v\d+\.\d+\.\d+/);
    expect(result.closing).toMatch(/^Running \d+\.\d+\.\d+/);
  });

  it('does not modify slots without placeholders', () => {
    const result = applyTemplateVariables(DEFAULT_PROMPT_VALUES);

    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
    expect(result.methodology).toBe(DEFAULT_PROMPT_VALUES.methodology);
  });

  it('leaves unknown variables intact in slots', () => {
    const input = {
      ...DEFAULT_PROMPT_VALUES,
      identity: 'Bot {{unknown_var}}',
    };

    const result = applyTemplateVariables(input);
    expect(result.identity).toBe('Bot {{unknown_var}}');
  });
});
