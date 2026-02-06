import { describe, it, expect } from 'vitest';
import {
  validatePromptOverrides,
  resolvePromptOverrides,
  mergePromptOverrides,
  DEFAULT_PROMPT_VALUES,
  MAX_OVERRIDE_LENGTH,
  PROMPT_OVERRIDE_SLOTS,
  PromptOverrides,
} from '../../src/types/prompt-overrides.js';

describe('validatePromptOverrides - valid inputs', () => {
  it('accepts valid overrides with string values', () => {
    const result = validatePromptOverrides({
      identity: 'Custom persona',
      methodology: 'Custom methodology',
    });
    expect(result).toBeNull();
  });

  it('accepts empty object', () => {
    expect(validatePromptOverrides({})).toBeNull();
  });

  it('accepts null values (for clearing slots)', () => {
    expect(validatePromptOverrides({ identity: null, closing: null })).toBeNull();
  });

  it('accepts all valid slots', () => {
    const overrides: Record<string, string> = {};
    for (const slot of PROMPT_OVERRIDE_SLOTS) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from constant
      overrides[slot] = `Value for ${slot}`;
    }
    expect(validatePromptOverrides(overrides)).toBeNull();
  });

  it('accepts values at exactly max length', () => {
    const maxValue = 'x'.repeat(MAX_OVERRIDE_LENGTH);
    expect(validatePromptOverrides({ identity: maxValue })).toBeNull();
  });
});

describe('validatePromptOverrides - invalid inputs', () => {
  it('rejects unknown keys', () => {
    const result = validatePromptOverrides({ unknown_slot: 'value' });
    expect(result).toContain('Unknown prompt slot');
    expect(result).toContain('unknown_slot');
  });

  it('rejects non-string, non-null values', () => {
    expect(validatePromptOverrides({ identity: 42 })).toContain('must be a string or null');
  });

  it('rejects boolean values', () => {
    expect(validatePromptOverrides({ identity: true })).toContain('must be a string or null');
  });

  it('rejects array values', () => {
    expect(validatePromptOverrides({ identity: ['a', 'b'] })).toContain('must be a string or null');
  });

  it('rejects values exceeding max length', () => {
    const longValue = 'x'.repeat(MAX_OVERRIDE_LENGTH + 1);
    const result = validatePromptOverrides({ identity: longValue });
    expect(result).toContain('exceeds maximum length');
    expect(result).toContain(String(MAX_OVERRIDE_LENGTH));
  });

  it('rejects non-object input', () => {
    expect(validatePromptOverrides('string')).toContain('must be a JSON object');
    expect(validatePromptOverrides(42)).toContain('must be a JSON object');
    expect(validatePromptOverrides(null)).toContain('must be a JSON object');
    expect(validatePromptOverrides([])).toContain('must be a JSON object');
  });
});

describe('resolvePromptOverrides - defaults', () => {
  it('returns defaults when no overrides provided', () => {
    const result = resolvePromptOverrides({}, {});
    expect(result).toEqual(DEFAULT_PROMPT_VALUES);
  });

  it('returns all 5 slots in the result', () => {
    const result = resolvePromptOverrides({}, {});
    expect(Object.keys(result).sort()).toEqual([...PROMPT_OVERRIDE_SLOTS].sort());
  });
});

describe('resolvePromptOverrides - org overrides', () => {
  it('org overrides take precedence over defaults', () => {
    const orgOverrides: PromptOverrides = { identity: 'Org persona' };
    const result = resolvePromptOverrides(orgOverrides, {});
    expect(result.identity).toBe('Org persona');
    expect(result.methodology).toBe(DEFAULT_PROMPT_VALUES.methodology);
    expect(result.closing).toBe(DEFAULT_PROMPT_VALUES.closing);
  });

  it('all slots can be overridden at org level', () => {
    const orgOverrides: PromptOverrides = {
      identity: 'O identity',
      methodology: 'O methodology',
      tool_guidance: 'O tool_guidance',
      instructions: 'O instructions',
      closing: 'O closing',
    };
    const result = resolvePromptOverrides(orgOverrides, {});
    for (const slot of PROMPT_OVERRIDE_SLOTS) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from constant
      expect(result[slot]).toBe(`O ${slot}`);
    }
  });

  it('null at org level does not override default', () => {
    const result = resolvePromptOverrides({ identity: null }, {});
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('undefined values do not override', () => {
    const result = resolvePromptOverrides({ identity: undefined }, {});
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });
});

describe('resolvePromptOverrides - user overrides', () => {
  it('user overrides take precedence over org overrides', () => {
    const orgOverrides: PromptOverrides = { identity: 'Org persona', methodology: 'Org method' };
    const userOverrides: PromptOverrides = { identity: 'User persona' };
    const result = resolvePromptOverrides(orgOverrides, userOverrides);
    expect(result.identity).toBe('User persona');
    expect(result.methodology).toBe('Org method');
  });

  it('user overrides take precedence over defaults', () => {
    const result = resolvePromptOverrides({}, { closing: 'User closing' });
    expect(result.closing).toBe('User closing');
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('null user values do not override org values', () => {
    const orgOverrides: PromptOverrides = { identity: 'Org persona' };
    const userOverrides: PromptOverrides = { identity: null };
    const result = resolvePromptOverrides(orgOverrides, userOverrides);
    expect(result.identity).toBe('Org persona');
  });
});

describe('resolvePromptOverrides - defensive validation', () => {
  it('empty strings do not override defaults', () => {
    const result = resolvePromptOverrides({ identity: '' }, {});
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('whitespace-only strings do not override defaults', () => {
    const result = resolvePromptOverrides({ identity: '   ' }, {});
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('empty user strings do not override org values', () => {
    const result = resolvePromptOverrides({ identity: 'Org' }, { identity: '' });
    expect(result.identity).toBe('Org');
  });
});

describe('mergePromptOverrides', () => {
  it('sets new slot values', () => {
    const result = mergePromptOverrides({}, { identity: 'New persona' });
    expect(result.identity).toBe('New persona');
  });

  it('deletes slots set to null', () => {
    const result = mergePromptOverrides({ identity: 'Old' }, { identity: null });
    expect(result.identity).toBeUndefined();
  });

  it('preserves existing slots not in updates', () => {
    const result = mergePromptOverrides({ identity: 'Keep', closing: 'Keep' }, { identity: 'New' });
    expect(result.identity).toBe('New');
    expect(result.closing).toBe('Keep');
  });

  it('strips control characters from values', () => {
    const result = mergePromptOverrides({}, { identity: 'Hello\x00World\x01!' });
    expect(result.identity).toBe('HelloWorld!');
  });
});
