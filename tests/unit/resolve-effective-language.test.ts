import { describe, it, expect } from 'vitest';
import { resolveEffectiveLanguage } from '../../src/types/languages.js';
import type { OrgLanguages } from '../../src/types/languages.js';

function buildOrgLanguages(): OrgLanguages {
  return {
    languages: [
      { name: 'arabic', label: 'Arabic', document: 'ARABIC_DOC', published: true },
      { name: 'spanish', label: 'Spanish', document: 'SPANISH_DOC', published: true },
      { name: 'draft-french', label: 'Draft French', document: 'DRAFT_FR_DOC', published: false },
      { name: 'untouched', label: 'Untouched', document: 'UNTOUCHED_DOC' /* published missing */ },
    ],
  };
}

describe('resolveEffectiveLanguage — default request handling', () => {
  it('returns none-requested when no language is requested', () => {
    const result = resolveEffectiveLanguage(buildOrgLanguages(), undefined);
    expect(result).toEqual({
      effectiveLanguageName: undefined,
      languageDocument: undefined,
      reason: 'none-requested',
    });
  });

  it('returns ok with the document when a published language is requested', () => {
    const result = resolveEffectiveLanguage(buildOrgLanguages(), 'arabic');
    expect(result).toEqual({
      effectiveLanguageName: 'arabic',
      languageDocument: 'ARABIC_DOC',
      reason: 'ok',
    });
  });

  it('returns missing when the requested language does not exist in the org', () => {
    const result = resolveEffectiveLanguage(buildOrgLanguages(), 'klingon');
    expect(result).toEqual({
      effectiveLanguageName: undefined,
      languageDocument: undefined,
      reason: 'missing',
    });
  });
});

describe('resolveEffectiveLanguage — published-filter stale-masking', () => {
  it('returns unpublished and masks the document for a draft language under the default filter', () => {
    const result = resolveEffectiveLanguage(buildOrgLanguages(), 'draft-french');
    expect(result).toEqual({
      effectiveLanguageName: undefined,
      languageDocument: undefined,
      reason: 'unpublished',
    });
  });

  it('treats a language with no `published` field as unpublished (matches Language type contract)', () => {
    // The Language type doc explicitly states: anything other than literal `true`
    // (false / undefined / missing) is treated as draft. Pinning the behaviour
    // here so a future tristate refactor cannot silently leak undefined as
    // visible-to-end-users.
    const result = resolveEffectiveLanguage(buildOrgLanguages(), 'untouched');
    expect(result.reason).toBe('unpublished');
    expect(result.effectiveLanguageName).toBeUndefined();
    expect(result.languageDocument).toBeUndefined();
  });

  it('includeUnpublished bypass surfaces the draft document for admin callers', () => {
    const result = resolveEffectiveLanguage(buildOrgLanguages(), 'draft-french', {
      includeUnpublished: true,
    });
    expect(result).toEqual({
      effectiveLanguageName: 'draft-french',
      languageDocument: 'DRAFT_FR_DOC',
      reason: 'ok',
    });
  });

  it('includeUnpublished still reports missing for a name that is not in the org list', () => {
    // Admin bypass shapes only the published-filter, not the existence check.
    const result = resolveEffectiveLanguage(buildOrgLanguages(), 'klingon', {
      includeUnpublished: true,
    });
    expect(result.reason).toBe('missing');
    expect(result.effectiveLanguageName).toBeUndefined();
  });

  it('admin caller requesting a published language returns ok (admin-and-published is normal path)', () => {
    const result = resolveEffectiveLanguage(buildOrgLanguages(), 'arabic', {
      includeUnpublished: true,
    });
    expect(result).toEqual({
      effectiveLanguageName: 'arabic',
      languageDocument: 'ARABIC_DOC',
      reason: 'ok',
    });
  });
});
