import { describe, it, expect } from 'vitest';
import {
  getEffectiveOverrides,
  MAX_MODE_DOCUMENT_LENGTH,
  parseModeDocument,
  resolveEffectiveMode,
  SLOT_LABELS,
  synthesizeModeDocument,
  validateModeDocument,
} from '../../src/types/mode-markdown.js';
import {
  OrgModes,
  PROMPT_OVERRIDE_SLOTS,
  PromptMode,
  PromptOverrides,
} from '../../src/types/prompt-overrides.js';

// ─── synthesizeModeDocument ──────────────────────────────────────────────────

describe('synthesizeModeDocument', () => {
  it('emits all seven H2 sections in canonical order', () => {
    const doc = synthesizeModeDocument({ identity: 'I am here.' });
    const headingLines = doc.split('\n').filter((l) => l.startsWith('## '));
    expect(headingLines).toEqual(PROMPT_OVERRIDE_SLOTS.map((s) => `## ${SLOT_LABELS[s]}`));
  });

  it('renders the trimmed slot value under its heading', () => {
    const doc = synthesizeModeDocument({ identity: '  Hello world  ', closing: 'Bye' });
    expect(doc).toContain('## Identity\n\nHello world\n');
    expect(doc).toContain('## Closing\n\nBye\n');
  });

  it('emits an empty body for unset slots', () => {
    const doc = synthesizeModeDocument({ identity: 'X' });
    // Sections without content render as `## Label\n` (heading then blank line)
    // and the next heading follows immediately on the next line.
    expect(doc).toMatch(/## Teaching Methodology\n\n## Tool Guidance/);
  });

  it('renders all empty sections when given empty overrides', () => {
    const doc = synthesizeModeDocument({});
    const headingLines = doc.split('\n').filter((l) => l.startsWith('## '));
    expect(headingLines).toHaveLength(7);
    // No non-blank, non-heading lines.
    const contentLines = doc.split('\n').filter((l) => l.trim() && !l.startsWith('## '));
    expect(contentLines).toEqual([]);
  });

  it('treats null/non-string slot values as empty bodies', () => {
    const overrides = { identity: null, closing: 'Bye' } as unknown as PromptOverrides;
    const doc = synthesizeModeDocument(overrides);
    expect(doc).toMatch(/## Identity\n\n## Teaching Methodology/);
    expect(doc).toContain('## Closing\n\nBye\n');
  });
});

// ─── parseModeDocument ───────────────────────────────────────────────────────

describe('parseModeDocument — basic shapes', () => {
  it('parses all seven sections of a full document', () => {
    const o: PromptOverrides = {
      identity: 'I',
      methodology: 'M',
      tool_guidance: 'TG',
      instructions: 'IN',
      client_instructions: 'CI',
      memory_instructions: 'MI',
      closing: 'C',
    };
    expect(parseModeDocument(synthesizeModeDocument(o))).toEqual(o);
  });

  it('parses a sparse document and omits empty slots', () => {
    const o: PromptOverrides = { identity: 'X', closing: 'Y' };
    expect(parseModeDocument(synthesizeModeDocument(o))).toEqual(o);
  });

  it('returns {} for empty input or empty all-headings document', () => {
    expect(parseModeDocument('')).toEqual({});
    expect(parseModeDocument(synthesizeModeDocument({}))).toEqual({});
  });
});

describe('parseModeDocument — content & ordering edge cases', () => {
  it('preserves user-supplied H2 headings inside a slot body when they are not slot labels', () => {
    const doc = [
      '## Identity',
      '',
      'Top-level text.',
      '',
      '## My Custom Notes',
      '',
      'These belong to Identity.',
      '',
      '## Closing',
      '',
      'Wrap up.',
      '',
    ].join('\n');
    const parsed = parseModeDocument(doc);
    expect(parsed.identity).toContain('Top-level text.');
    expect(parsed.identity).toContain('## My Custom Notes');
    expect(parsed.identity).toContain('These belong to Identity.');
    expect(parsed.closing).toBe('Wrap up.');
  });

  it('parses sections in non-canonical order', () => {
    const doc = ['## Closing', '', 'C-body', '', '## Identity', '', 'I-body', ''].join('\n');
    expect(parseModeDocument(doc)).toEqual({ identity: 'I-body', closing: 'C-body' });
  });

  it('discards content before the first heading', () => {
    const doc = ['stray preamble', '', '## Identity', '', 'kept', ''].join('\n');
    expect(parseModeDocument(doc)).toEqual({ identity: 'kept' });
  });

  it('handles trailing whitespace on a heading line', () => {
    const doc = '## Identity   \n\nbody\n';
    expect(parseModeDocument(doc)).toEqual({ identity: 'body' });
  });

  it('rejects misspelled / unknown headings (treats them as content)', () => {
    const doc = ['## Identitty', '', 'oops', '', '## Identity', '', 'real', ''].join('\n');
    // `## Identitty` is not a known label → discarded with the preamble. Only
    // the second (correct) heading produces a slot.
    expect(parseModeDocument(doc)).toEqual({ identity: 'real' });
  });
});

// ─── Round-trip ──────────────────────────────────────────────────────────────

describe('parse(synthesize(o)) round-trip', () => {
  const cases: Array<[string, PromptOverrides]> = [
    ['empty', {}],
    ['single slot', { identity: 'just me' }],
    [
      'full',
      {
        identity: 'I',
        methodology: 'M\nmultiline\n',
        tool_guidance: 'TG',
        instructions: 'IN',
        client_instructions: 'CI',
        memory_instructions: 'MI',
        closing: 'C',
      },
    ],
    [
      'slot body that itself contains ## headings (non-label)',
      {
        identity: 'Top.\n\n## My subhead\n\nDetails.',
      },
    ],
  ];

  for (const [name, o] of cases) {
    it(`round-trips: ${name}`, () => {
      const round = parseModeDocument(synthesizeModeDocument(o));
      // For sparse modes, undefined slots are omitted from the parsed output.
      const expected: PromptOverrides = {};
      for (const slot of PROMPT_OVERRIDE_SLOTS) {
        // eslint-disable-next-line security/detect-object-injection -- key from constant
        const v = o[slot];
        if (typeof v === 'string' && v.trim().length > 0) {
          // eslint-disable-next-line security/detect-object-injection -- key from constant
          expected[slot] = v.trim();
        }
      }
      expect(round).toEqual(expected);
    });
  }
});

// ─── getEffectiveOverrides ───────────────────────────────────────────────────

describe('getEffectiveOverrides', () => {
  it('returns overrides directly when the mode is in legacy shape', () => {
    const mode: PromptMode = { name: 'm', overrides: { identity: 'X' } };
    expect(getEffectiveOverrides(mode)).toEqual({ identity: 'X' });
  });

  it('parses the document when the mode is in markdown shape', () => {
    const mode: PromptMode = {
      name: 'm',
      document: synthesizeModeDocument({ identity: 'X', closing: 'Y' }),
    };
    expect(getEffectiveOverrides(mode)).toEqual({ identity: 'X', closing: 'Y' });
  });

  it('returns {} when the mode has neither overrides nor document', () => {
    const mode = { name: 'm' } as PromptMode;
    expect(getEffectiveOverrides(mode)).toEqual({});
  });
});

// ─── validateModeDocument ────────────────────────────────────────────────────

describe('validateModeDocument', () => {
  it('accepts valid strings', () => {
    expect(validateModeDocument('## Identity\n\nx')).toBeNull();
    expect(validateModeDocument('')).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(validateModeDocument(undefined)).toContain('must be a string');
    expect(validateModeDocument(null)).toContain('must be a string');
    expect(validateModeDocument(42)).toContain('must be a string');
    expect(validateModeDocument({})).toContain('must be a string');
  });

  it('rejects over-length documents', () => {
    const big = 'x'.repeat(MAX_MODE_DOCUMENT_LENGTH + 1);
    const err = validateModeDocument(big);
    expect(err).not.toBeNull();
    expect(err).toContain('exceeds maximum length');
  });
});

// ─── resolveEffectiveMode ────────────────────────────────────────────────────

describe('resolveEffectiveMode', () => {
  function org(...modes: PromptMode[]): OrgModes {
    return { modes };
  }

  it('returns none-requested when no mode is selected', () => {
    expect(resolveEffectiveMode(org(), undefined).reason).toBe('none-requested');
  });

  it('returns missing for an unknown mode name', () => {
    const r = resolveEffectiveMode(org({ name: 'a', published: true, overrides: {} }), 'b');
    expect(r.reason).toBe('missing');
    expect(r.effectiveModeName).toBeUndefined();
  });

  it('returns unpublished for a draft mode and a non-admin caller', () => {
    const r = resolveEffectiveMode(org({ name: 'a', overrides: { identity: 'x' } }), 'a');
    expect(r.reason).toBe('unpublished');
    expect(r.modeOverrides).toEqual({});
  });

  it('returns slot overrides for a legacy published mode', () => {
    const r = resolveEffectiveMode(
      org({ name: 'a', published: true, overrides: { identity: 'x' } }),
      'a'
    );
    expect(r.reason).toBe('ok');
    expect(r.modeOverrides).toEqual({ identity: 'x' });
  });

  it('returns parsed slot overrides for a markdown-stored published mode', () => {
    const r = resolveEffectiveMode(
      org({
        name: 'a',
        published: true,
        document: synthesizeModeDocument({ identity: 'X', closing: 'Y' }),
      }),
      'a'
    );
    expect(r.reason).toBe('ok');
    expect(r.modeOverrides).toEqual({ identity: 'X', closing: 'Y' });
  });

  it('returns slot overrides for a draft mode when includeUnpublished is true', () => {
    const r = resolveEffectiveMode(org({ name: 'a', overrides: { identity: 'x' } }), 'a', {
      includeUnpublished: true,
    });
    expect(r.reason).toBe('ok');
    expect(r.modeOverrides).toEqual({ identity: 'x' });
  });
});
