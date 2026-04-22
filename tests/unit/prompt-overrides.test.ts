import { describe, it, expect } from 'vitest';
import {
  validatePromptOverrides,
  resolvePromptOverrides,
  mergePromptOverrides,
  DEFAULT_PROMPT_VALUES,
  MAX_OVERRIDE_LENGTH,
  PROMPT_OVERRIDE_SLOTS,
  PromptOverrides,
  validateModeName,
  validatePromptMode,
  resolveActiveModeName,
  resolveEffectiveMode,
  MAX_MODE_NAME_LENGTH,
  MAX_MODE_LABEL_LENGTH,
  MAX_MODE_DESCRIPTION_LENGTH,
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
    const result = resolvePromptOverrides({}, {}, {});
    expect(result).toEqual(DEFAULT_PROMPT_VALUES);
  });

  it('returns all 7 slots in the result', () => {
    const result = resolvePromptOverrides({}, {}, {});
    expect(Object.keys(result).sort()).toEqual([...PROMPT_OVERRIDE_SLOTS].sort());
  });
});

describe('resolvePromptOverrides - org overrides', () => {
  it('org overrides take precedence over defaults', () => {
    const orgOverrides: PromptOverrides = { identity: 'Org persona' };
    const result = resolvePromptOverrides(orgOverrides, {}, {});
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
      client_instructions: 'O client_instructions',
      memory_instructions: 'O memory_instructions',
      closing: 'O closing',
    };
    const result = resolvePromptOverrides(orgOverrides, {}, {});
    for (const slot of PROMPT_OVERRIDE_SLOTS) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from constant
      expect(result[slot]).toBe(`O ${slot}`);
    }
  });

  it('null at org level does not override default', () => {
    const result = resolvePromptOverrides({ identity: null }, {}, {});
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('undefined values do not override', () => {
    const result = resolvePromptOverrides({ identity: undefined }, {}, {});
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });
});

describe('resolvePromptOverrides - mode overrides', () => {
  it('mode overrides take precedence over org overrides', () => {
    const org: PromptOverrides = { identity: 'Org', methodology: 'Org method' };
    const mode: PromptOverrides = { identity: 'Mode' };
    const result = resolvePromptOverrides(org, mode, {});
    expect(result.identity).toBe('Mode');
    expect(result.methodology).toBe('Org method');
  });

  it('mode overrides take precedence over defaults', () => {
    const result = resolvePromptOverrides({}, { closing: 'Mode closing' }, {});
    expect(result.closing).toBe('Mode closing');
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('null mode values do not override org values', () => {
    const org: PromptOverrides = { identity: 'Org' };
    const mode: PromptOverrides = { identity: null };
    const result = resolvePromptOverrides(org, mode, {});
    expect(result.identity).toBe('Org');
  });

  it('empty mode strings do not override org values', () => {
    const org: PromptOverrides = { identity: 'Org' };
    const mode: PromptOverrides = { identity: '' };
    const result = resolvePromptOverrides(org, mode, {});
    expect(result.identity).toBe('Org');
  });

  it('whitespace-only mode strings do not override', () => {
    const result = resolvePromptOverrides({}, { identity: '   ' }, {});
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });
});

describe('resolvePromptOverrides - user overrides', () => {
  it('user overrides take precedence over org overrides', () => {
    const orgOverrides: PromptOverrides = { identity: 'Org persona', methodology: 'Org method' };
    const userOverrides: PromptOverrides = { identity: 'User persona' };
    const result = resolvePromptOverrides(orgOverrides, {}, userOverrides);
    expect(result.identity).toBe('User persona');
    expect(result.methodology).toBe('Org method');
  });

  it('user overrides take precedence over mode overrides', () => {
    const mode: PromptOverrides = { identity: 'Mode persona', methodology: 'Mode method' };
    const user: PromptOverrides = { identity: 'User persona' };
    const result = resolvePromptOverrides({}, mode, user);
    expect(result.identity).toBe('User persona');
    expect(result.methodology).toBe('Mode method');
  });

  it('user overrides take precedence over defaults', () => {
    const result = resolvePromptOverrides({}, {}, { closing: 'User closing' });
    expect(result.closing).toBe('User closing');
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('null user values do not override org values', () => {
    const orgOverrides: PromptOverrides = { identity: 'Org persona' };
    const userOverrides: PromptOverrides = { identity: null };
    const result = resolvePromptOverrides(orgOverrides, {}, userOverrides);
    expect(result.identity).toBe('Org persona');
  });

  it('null user values do not override mode values', () => {
    const mode: PromptOverrides = { identity: 'Mode persona' };
    const user: PromptOverrides = { identity: null };
    const result = resolvePromptOverrides({}, mode, user);
    expect(result.identity).toBe('Mode persona');
  });
});

describe('resolvePromptOverrides - 3-layer interactions', () => {
  it('full hierarchy: each layer overrides different slots', () => {
    const org: PromptOverrides = { identity: 'Org', methodology: 'Org', closing: 'Org' };
    const mode: PromptOverrides = { methodology: 'Mode', instructions: 'Mode' };
    const user: PromptOverrides = { closing: 'User', instructions: 'User' };
    const result = resolvePromptOverrides(org, mode, user);
    expect(result.identity).toBe('Org');
    expect(result.methodology).toBe('Mode');
    expect(result.instructions).toBe('User');
    expect(result.closing).toBe('User');
    expect(result.tool_guidance).toBe(DEFAULT_PROMPT_VALUES.tool_guidance);
  });

  it('user wins when all 3 layers set the same slot', () => {
    const org: PromptOverrides = { identity: 'Org' };
    const mode: PromptOverrides = { identity: 'Mode' };
    const user: PromptOverrides = { identity: 'User' };
    const result = resolvePromptOverrides(org, mode, user);
    expect(result.identity).toBe('User');
  });

  it('mode wins over org when user does not set slot', () => {
    const org: PromptOverrides = { identity: 'Org' };
    const mode: PromptOverrides = { identity: 'Mode' };
    const result = resolvePromptOverrides(org, mode, {});
    expect(result.identity).toBe('Mode');
  });

  it('empty mode layer is transparent', () => {
    const org: PromptOverrides = { identity: 'Org' };
    const user: PromptOverrides = { closing: 'User' };
    const result = resolvePromptOverrides(org, {}, user);
    expect(result.identity).toBe('Org');
    expect(result.closing).toBe('User');
    expect(result.methodology).toBe(DEFAULT_PROMPT_VALUES.methodology);
  });
});

describe('resolvePromptOverrides - defensive validation', () => {
  it('empty strings do not override defaults', () => {
    const result = resolvePromptOverrides({ identity: '' }, {}, {});
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('whitespace-only strings do not override defaults', () => {
    const result = resolvePromptOverrides({ identity: '   ' }, {}, {});
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('empty user strings do not override org values', () => {
    const result = resolvePromptOverrides({ identity: 'Org' }, {}, { identity: '' });
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

describe('resolvePromptOverrides - client_instructions slot', () => {
  it('returns default client_instructions when no overrides', () => {
    const result = resolvePromptOverrides({}, {}, {});
    expect(result.client_instructions).toBe(DEFAULT_PROMPT_VALUES.client_instructions);
  });

  it('org can override client_instructions', () => {
    const result = resolvePromptOverrides({ client_instructions: 'Org client rules' }, {}, {});
    expect(result.client_instructions).toBe('Org client rules');
  });

  it('user can override client_instructions over org', () => {
    const result = resolvePromptOverrides(
      { client_instructions: 'Org client rules' },
      {},
      { client_instructions: 'User client rules' }
    );
    expect(result.client_instructions).toBe('User client rules');
  });

  it('null user value does not override org client_instructions', () => {
    const result = resolvePromptOverrides(
      { client_instructions: 'Org client rules' },
      {},
      { client_instructions: null }
    );
    expect(result.client_instructions).toBe('Org client rules');
  });
});

// ─── Mode validation tests ─────────────────────────────────────────────────────

describe('validateModeName', () => {
  it('accepts valid slug names', () => {
    expect(validateModeName('fia')).toBeNull();
    expect(validateModeName('mast-methodology')).toBeNull();
    expect(validateModeName('checking-mode')).toBeNull();
    expect(validateModeName('a')).toBeNull();
    expect(validateModeName('a1')).toBeNull();
    expect(validateModeName('mode123')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(validateModeName(42)).toContain('must be a string');
    expect(validateModeName(null)).toContain('must be a string');
    expect(validateModeName(undefined)).toContain('must be a string');
  });

  it('rejects empty string', () => {
    expect(validateModeName('')).toContain('must not be empty');
  });

  it('rejects names exceeding max length', () => {
    const long = 'a'.repeat(MAX_MODE_NAME_LENGTH + 1);
    expect(validateModeName(long)).toContain('exceeds maximum length');
  });

  it('rejects uppercase characters', () => {
    expect(validateModeName('FIA')).toContain('lowercase alphanumeric');
  });

  it('rejects spaces', () => {
    expect(validateModeName('my mode')).toContain('lowercase alphanumeric');
  });

  it('rejects leading hyphens', () => {
    expect(validateModeName('-fia')).toContain('lowercase alphanumeric');
  });

  it('rejects trailing hyphens', () => {
    expect(validateModeName('fia-')).toContain('lowercase alphanumeric');
  });

  it('rejects special characters', () => {
    expect(validateModeName('fia_mode')).toContain('lowercase alphanumeric');
    expect(validateModeName('fia.mode')).toContain('lowercase alphanumeric');
  });
});

describe('validatePromptMode', () => {
  it('accepts valid mode with overrides only', () => {
    expect(validatePromptMode({ overrides: { identity: 'Custom' } })).toBeNull();
  });

  it('accepts valid mode with label and description', () => {
    expect(
      validatePromptMode({
        label: 'FIA Mode',
        description: 'Focus on inquiry approach',
        overrides: { identity: 'Custom' },
      })
    ).toBeNull();
  });

  it('accepts empty overrides object', () => {
    expect(validatePromptMode({ overrides: {} })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validatePromptMode('string')).toContain('must be a JSON object');
    expect(validatePromptMode(null)).toContain('must be a JSON object');
    expect(validatePromptMode([])).toContain('must be a JSON object');
  });

  it('rejects missing overrides', () => {
    expect(validatePromptMode({ label: 'Test' })).toContain('must include an "overrides" object');
  });

  it('rejects invalid overrides', () => {
    const result = validatePromptMode({ overrides: { unknown_slot: 'value' } });
    expect(result).toContain('Mode overrides invalid');
  });

  it('rejects non-string label', () => {
    expect(validatePromptMode({ label: 42, overrides: {} })).toContain('label must be a string');
  });

  it('rejects label exceeding max length', () => {
    const long = 'x'.repeat(MAX_MODE_LABEL_LENGTH + 1);
    expect(validatePromptMode({ label: long, overrides: {} })).toContain(
      'label exceeds maximum length'
    );
  });

  it('rejects non-string description', () => {
    expect(validatePromptMode({ description: 42, overrides: {} })).toContain(
      'description must be a string'
    );
  });

  it('rejects description exceeding max length', () => {
    const long = 'x'.repeat(MAX_MODE_DESCRIPTION_LENGTH + 1);
    expect(validatePromptMode({ description: long, overrides: {} })).toContain(
      'description exceeds maximum length'
    );
  });
});

describe('validatePromptMode - published field', () => {
  it('accepts published: true', () => {
    expect(validatePromptMode({ published: true, overrides: {} })).toBeNull();
  });

  it('accepts published: false', () => {
    expect(validatePromptMode({ published: false, overrides: {} })).toBeNull();
  });

  it('accepts missing published field (treated as draft)', () => {
    expect(validatePromptMode({ overrides: {} })).toBeNull();
  });

  it('accepts published: undefined', () => {
    expect(validatePromptMode({ published: undefined, overrides: {} })).toBeNull();
  });

  it('rejects non-boolean published value', () => {
    expect(validatePromptMode({ published: 'yes', overrides: {} })).toContain(
      'published must be a boolean'
    );
    expect(validatePromptMode({ published: 1, overrides: {} })).toContain(
      'published must be a boolean'
    );
    expect(validatePromptMode({ published: null, overrides: {} })).toContain(
      'published must be a boolean'
    );
  });
});

describe('validatePromptMode - name field', () => {
  it('accepts valid name when provided', () => {
    expect(validatePromptMode({ name: 'fia-mode', overrides: {} })).toBeNull();
  });

  it('rejects invalid name when provided', () => {
    expect(validatePromptMode({ name: 'FIA MODE!', overrides: {} })).toBeTruthy();
  });
});

// ─── Mode selection priority tests ──────────────────────────────────────────────

describe('resolveActiveModeName', () => {
  it('returns user-selected mode when set', () => {
    expect(resolveActiveModeName('fia')).toBe('fia');
  });

  it('returns undefined when no user selection', () => {
    expect(resolveActiveModeName(undefined)).toBeUndefined();
  });
});

describe('resolveEffectiveMode', () => {
  const orgModes = {
    modes: [
      { name: 'pub', published: true, overrides: { identity: 'Pub identity' } },
      { name: 'draft', published: false, overrides: { identity: 'Draft identity' } },
      { name: 'legacy', overrides: { identity: 'Legacy identity' } },
    ],
  };

  it('returns the requested mode when published', () => {
    const r = resolveEffectiveMode(orgModes, 'pub');
    expect(r.effectiveModeName).toBe('pub');
    expect(r.modeOverrides.identity).toBe('Pub identity');
    expect(r.reason).toBe('ok');
  });

  it('masks effectiveModeName when the requested mode is unpublished (published: false)', () => {
    const r = resolveEffectiveMode(orgModes, 'draft');
    expect(r.effectiveModeName).toBeUndefined();
    expect(r.modeOverrides).toEqual({});
    expect(r.reason).toBe('unpublished');
  });

  it('treats a mode with no published field as unpublished (legacy/missing field)', () => {
    const r = resolveEffectiveMode(orgModes, 'legacy');
    expect(r.effectiveModeName).toBeUndefined();
    expect(r.modeOverrides).toEqual({});
    expect(r.reason).toBe('unpublished');
  });

  it('masks effectiveModeName when the requested mode no longer exists', () => {
    const r = resolveEffectiveMode(orgModes, 'deleted');
    expect(r.effectiveModeName).toBeUndefined();
    expect(r.modeOverrides).toEqual({});
    expect(r.reason).toBe('missing');
  });

  it('returns none-requested when no mode was requested', () => {
    const r = resolveEffectiveMode(orgModes, undefined);
    expect(r.effectiveModeName).toBeUndefined();
    expect(r.modeOverrides).toEqual({});
    expect(r.reason).toBe('none-requested');
  });
});
