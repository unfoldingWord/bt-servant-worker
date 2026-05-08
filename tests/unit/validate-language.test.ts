import { describe, it, expect } from 'vitest';
import {
  MAX_LANGUAGE_DOCUMENT_LENGTH,
  MAX_LANGUAGE_LABEL_LENGTH,
  MAX_LANGUAGE_NAME_LENGTH,
  validateLanguage,
  validateLanguageName,
} from '../../src/types/languages.js';

describe('validateLanguageName', () => {
  it('accepts a valid lowercase slug', () => {
    expect(validateLanguageName('arabic')).toBeNull();
    expect(validateLanguageName('arabic-egyptian')).toBeNull();
    expect(validateLanguageName('a1')).toBeNull();
  });

  it('rejects non-string', () => {
    expect(validateLanguageName(123)).toContain('must be a string');
  });

  it('rejects empty string', () => {
    expect(validateLanguageName('')).toContain('must not be empty');
  });

  it('rejects names exceeding max length', () => {
    const tooLong = 'a'.repeat(MAX_LANGUAGE_NAME_LENGTH + 1);
    expect(validateLanguageName(tooLong)).toContain('exceeds maximum length');
  });

  it('rejects uppercase letters', () => {
    expect(validateLanguageName('Arabic')).toContain('lowercase alphanumeric');
  });

  it('rejects leading or trailing hyphen', () => {
    expect(validateLanguageName('-arabic')).toContain('lowercase alphanumeric');
    expect(validateLanguageName('arabic-')).toContain('lowercase alphanumeric');
  });

  it('rejects underscores and other punctuation', () => {
    expect(validateLanguageName('arabic_egyptian')).toContain('lowercase alphanumeric');
    expect(validateLanguageName('arabic.egyptian')).toContain('lowercase alphanumeric');
  });
});

describe('validateLanguage - valid inputs', () => {
  it('accepts a minimal language (name + document)', () => {
    expect(validateLanguage({ name: 'arabic', document: 'hello' })).toBeNull();
  });

  it('accepts a fully-populated language', () => {
    expect(
      validateLanguage({
        name: 'arabic',
        label: 'Arabic',
        published: true,
        document: '## Tone\nFormal.',
      })
    ).toBeNull();
  });

  it('accepts label and document at exactly max length', () => {
    expect(
      validateLanguage({
        name: 'arabic',
        label: 'L'.repeat(MAX_LANGUAGE_LABEL_LENGTH),
        document: 'D'.repeat(MAX_LANGUAGE_DOCUMENT_LENGTH),
      })
    ).toBeNull();
  });

  it('accepts an empty document string (placeholder before scaffold loads)', () => {
    expect(validateLanguage({ name: 'arabic', document: '' })).toBeNull();
  });
});

describe('validateLanguage - invalid inputs', () => {
  it('rejects non-object input', () => {
    expect(validateLanguage('not an object')).toContain('must be a JSON object');
    expect(validateLanguage(null)).toContain('must be a JSON object');
    expect(validateLanguage([])).toContain('must be a JSON object');
  });

  it('rejects missing document', () => {
    expect(validateLanguage({ name: 'arabic' })).toContain('"document"');
  });

  it('rejects null document', () => {
    expect(validateLanguage({ name: 'arabic', document: null })).toContain('"document"');
  });

  it('rejects non-string document', () => {
    expect(validateLanguage({ name: 'arabic', document: 42 })).toContain('must be a string');
  });

  it('rejects document exceeding max length', () => {
    const tooLong = 'x'.repeat(MAX_LANGUAGE_DOCUMENT_LENGTH + 1);
    const result = validateLanguage({ name: 'arabic', document: tooLong });
    expect(result).toContain('exceeds maximum length');
  });

  it('rejects label exceeding max length', () => {
    const tooLong = 'x'.repeat(MAX_LANGUAGE_LABEL_LENGTH + 1);
    expect(validateLanguage({ name: 'arabic', label: tooLong, document: 'd' })).toContain(
      'exceeds maximum length'
    );
  });

  it('rejects non-boolean published', () => {
    expect(validateLanguage({ name: 'arabic', published: 'yes', document: 'd' })).toContain(
      'must be a boolean'
    );
  });

  it('propagates name validation error', () => {
    expect(validateLanguage({ name: 'Arabic', document: 'd' })).toContain('lowercase alphanumeric');
  });
});
