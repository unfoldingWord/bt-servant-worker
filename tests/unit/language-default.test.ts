import { describe, it, expect } from 'vitest';
import { selectRequestedLanguage } from '../../src/durable-objects/user-do.js';
import {
  OrgLanguages,
  resolveEffectiveLanguage,
  validateDefaultLanguageUpdate,
} from '../../src/types/languages.js';

describe('selectRequestedLanguage (cascade: trigger → persisted → org default)', () => {
  it('trigger beats persisted and default', () => {
    expect(selectRequestedLanguage('arabic', 'hindi', 'english')).toEqual({
      requestedName: 'arabic',
      source: 'trigger',
    });
  });

  it('persisted beats default when no trigger', () => {
    expect(selectRequestedLanguage(undefined, 'hindi', 'english')).toEqual({
      requestedName: 'hindi',
      source: 'persisted',
    });
  });

  it('org default fires when trigger and persisted are absent', () => {
    expect(selectRequestedLanguage(undefined, undefined, 'english')).toEqual({
      requestedName: 'english',
      source: 'org_default',
    });
  });

  it('none when nothing is set', () => {
    expect(selectRequestedLanguage(undefined, undefined, undefined)).toEqual({
      requestedName: undefined,
      source: 'none',
    });
  });

  it('treats an empty-string default (drifted KV state) as absent', () => {
    expect(selectRequestedLanguage(undefined, undefined, '')).toEqual({
      requestedName: undefined,
      source: 'none',
    });
  });
});

describe('org default + published filter (via resolveEffectiveLanguage)', () => {
  const orgLanguages: OrgLanguages = {
    languages: [
      { name: 'hindi', document: 'Hindi tuning', published: true },
      { name: 'tagalog', document: 'Tagalog draft' }, // unpublished
    ],
    defaultLanguage: 'tagalog',
  };

  it('unpublished default resolves to no document for end users', () => {
    const { requestedName, source } = selectRequestedLanguage(
      undefined,
      undefined,
      orgLanguages.defaultLanguage
    );
    expect(source).toBe('org_default');
    const resolution = resolveEffectiveLanguage(orgLanguages, requestedName);
    expect(resolution.reason).toBe('unpublished');
    expect(resolution.languageDocument).toBeUndefined();
  });

  it('unpublished default resolves to the draft document for admins', () => {
    const { requestedName } = selectRequestedLanguage(
      undefined,
      undefined,
      orgLanguages.defaultLanguage
    );
    const resolution = resolveEffectiveLanguage(orgLanguages, requestedName, {
      includeUnpublished: true,
    });
    expect(resolution.reason).toBe('ok');
    expect(resolution.languageDocument).toBe('Tagalog draft');
  });

  it('published default resolves to its document for end users', () => {
    const resolution = resolveEffectiveLanguage(
      { ...orgLanguages, defaultLanguage: 'hindi' },
      selectRequestedLanguage(undefined, undefined, 'hindi').requestedName
    );
    expect(resolution.reason).toBe('ok');
    expect(resolution.languageDocument).toBe('Hindi tuning');
  });
});

describe('validateDefaultLanguageUpdate', () => {
  const orgLanguages: OrgLanguages = {
    languages: [{ name: 'hindi', document: 'doc', published: true }],
  };

  it('accepts an existing language name', () => {
    expect(validateDefaultLanguageUpdate({ name: 'hindi' }, orgLanguages)).toEqual({
      ok: true,
      name: 'hindi',
    });
  });

  it('accepts null to clear the default', () => {
    expect(validateDefaultLanguageUpdate({ name: null }, orgLanguages)).toEqual({
      ok: true,
      name: null,
    });
  });

  it('rejects a name that references no existing language', () => {
    const result = validateDefaultLanguageUpdate({ name: 'arabic' }, orgLanguages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not found');
  });

  it('rejects an invalid slug', () => {
    const result = validateDefaultLanguageUpdate({ name: 'Not A Slug!' }, orgLanguages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('lowercase alphanumeric');
  });

  it('rejects a non-string, non-null name', () => {
    const result = validateDefaultLanguageUpdate({ name: 42 }, orgLanguages);
    expect(result.ok).toBe(false);
  });

  it('rejects a body without a name field', () => {
    const result = validateDefaultLanguageUpdate({}, orgLanguages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"name" field');
  });

  it('rejects a non-object body', () => {
    expect(validateDefaultLanguageUpdate('hindi', orgLanguages).ok).toBe(false);
    expect(validateDefaultLanguageUpdate(null, orgLanguages).ok).toBe(false);
    expect(validateDefaultLanguageUpdate(['hindi'], orgLanguages).ok).toBe(false);
  });
});
