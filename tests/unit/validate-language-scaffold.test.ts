import { describe, it, expect } from 'vitest';

import {
  DEFAULT_LANGUAGE_SCAFFOLD,
  MAX_SCAFFOLD_DOCUMENT_LENGTH,
  validateLanguageScaffold,
} from '../../src/types/language-scaffold.js';

describe('validateLanguageScaffold - valid inputs', () => {
  it('accepts a valid scaffold with a document string', () => {
    expect(validateLanguageScaffold({ document: '## Tone\nSome content' })).toBeNull();
  });

  it('accepts a document at exactly max length', () => {
    expect(
      validateLanguageScaffold({ document: 'x'.repeat(MAX_SCAFFOLD_DOCUMENT_LENGTH) })
    ).toBeNull();
  });

  it('accepts an empty document string', () => {
    expect(validateLanguageScaffold({ document: '' })).toBeNull();
  });
});

describe('validateLanguageScaffold - invalid inputs', () => {
  it('rejects a string', () => {
    expect(validateLanguageScaffold('hello')).toContain('JSON object');
  });

  it('rejects null', () => {
    expect(validateLanguageScaffold(null)).toContain('JSON object');
  });

  it('rejects an array', () => {
    expect(validateLanguageScaffold([{ document: 'x' }])).toContain('JSON object');
  });

  it('rejects missing document field', () => {
    expect(validateLanguageScaffold({})).toContain('"document"');
  });

  it('rejects null document', () => {
    expect(validateLanguageScaffold({ document: null })).toContain('"document"');
  });

  it('rejects non-string document', () => {
    expect(validateLanguageScaffold({ document: 42 })).toContain('must be a string');
  });

  it('rejects document exceeding max length', () => {
    const result = validateLanguageScaffold({
      document: 'x'.repeat(MAX_SCAFFOLD_DOCUMENT_LENGTH + 1),
    });
    expect(result).toContain('exceeds maximum length');
  });
});

describe('DEFAULT_LANGUAGE_SCAFFOLD', () => {
  it('passes its own validation', () => {
    expect(validateLanguageScaffold(DEFAULT_LANGUAGE_SCAFFOLD)).toBeNull();
  });

  it('contains expected H2 headings', () => {
    const doc = DEFAULT_LANGUAGE_SCAFFOLD.document;
    expect(doc).toContain('## Tone & Register');
    expect(doc).toContain('## Word Choice');
    expect(doc).toContain('## Lexicon (DCV Overrides)');
    expect(doc).toContain('## Cultural Notes');
    expect(doc).toContain('## Examples');
  });

  it('contains %% guidance comments', () => {
    const doc = DEFAULT_LANGUAGE_SCAFFOLD.document;
    const guidanceCount = (doc.match(/^%%/gm) || []).length;
    expect(guidanceCount).toBe(5);
  });
});
