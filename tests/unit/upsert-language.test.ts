import { describe, it, expect } from 'vitest';
import { upsertLanguage } from '../../src/index.js';
import { Language, MAX_LANGUAGES_PER_ORG, OrgLanguages } from '../../src/types/languages.js';

function makeOrgLanguages(...languages: Language[]): OrgLanguages {
  return { languages };
}

describe('upsertLanguage - new language creation', () => {
  it('creates a new language when none exists', () => {
    const orgLanguages = makeOrgLanguages();
    const result = upsertLanguage(
      orgLanguages,
      { name: 'arabic', document: '## Tone\nFormal.' },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.document).toBe('## Tone\nFormal.');
    expect(orgLanguages.languages).toHaveLength(1);
  });

  it('returns error when MAX_LANGUAGES_PER_ORG exceeded', () => {
    const languages: Language[] = Array.from({ length: MAX_LANGUAGES_PER_ORG }, (_, i) => ({
      name: `lang-${i}`,
      document: 'doc',
    }));
    const result = upsertLanguage({ languages }, { name: 'one-too-many', document: 'doc' }, 'o');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Cannot have more than');
  });

  it('strips control characters from a new language document', () => {
    const orgLanguages = makeOrgLanguages();
    const result = upsertLanguage(
      orgLanguages,
      { name: 'arabic', document: 'safe\x00unsafe\x07tail' },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.document).toBe('safeunsafetail');
  });
});

describe('upsertLanguage - document replacement', () => {
  it('replaces document wholesale on update', () => {
    const orgLanguages = makeOrgLanguages({
      name: 'arabic',
      document: 'old document',
    });
    const result = upsertLanguage(orgLanguages, { name: 'arabic', document: 'new document' }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.document).toBe('new document');
    expect(orgLanguages.languages).toHaveLength(1);
  });

  it('strips control characters from an updated document', () => {
    const orgLanguages = makeOrgLanguages({ name: 'arabic', document: 'old' });
    const result = upsertLanguage(orgLanguages, { name: 'arabic', document: 'new\x01doc' }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.document).toBe('newdoc');
  });

  it('allows update even when at MAX_LANGUAGES_PER_ORG', () => {
    const languages: Language[] = Array.from({ length: MAX_LANGUAGES_PER_ORG }, (_, i) => ({
      name: `lang-${i}`,
      document: 'doc',
    }));
    const orgLanguages = { languages };
    const result = upsertLanguage(orgLanguages, { name: 'lang-0', document: 'updated' }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.document).toBe('updated');
    expect(orgLanguages.languages).toHaveLength(MAX_LANGUAGES_PER_ORG);
  });
});

describe('upsertLanguage - scalar field preservation', () => {
  it('preserves existing label when caller omits it', () => {
    const orgLanguages = makeOrgLanguages({
      name: 'arabic',
      label: 'Arabic',
      document: 'doc',
    });
    const result = upsertLanguage(orgLanguages, { name: 'arabic', document: 'new' }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.label).toBe('Arabic');
  });

  it('updates label when caller provides one', () => {
    const orgLanguages = makeOrgLanguages({ name: 'arabic', label: 'Old', document: 'doc' });
    const result = upsertLanguage(
      orgLanguages,
      { name: 'arabic', label: 'New', document: 'doc' },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.label).toBe('New');
  });
});

describe('upsertLanguage - published flag carry-through', () => {
  it('preserves existing published: true when caller omits the field', () => {
    const orgLanguages = makeOrgLanguages({ name: 'arabic', published: true, document: 'doc' });
    const result = upsertLanguage(orgLanguages, { name: 'arabic', document: 'new' }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.published).toBe(true);
  });

  it('preserves existing published: false when caller omits the field', () => {
    const orgLanguages = makeOrgLanguages({ name: 'arabic', published: false, document: 'doc' });
    const result = upsertLanguage(orgLanguages, { name: 'arabic', document: 'new' }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.published).toBe(false);
  });
});

describe('upsertLanguage - published flag updates', () => {
  it('updates published when caller provides it (publish action)', () => {
    const orgLanguages = makeOrgLanguages({ name: 'arabic', published: false, document: 'doc' });
    const result = upsertLanguage(
      orgLanguages,
      { name: 'arabic', published: true, document: 'doc' },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.published).toBe(true);
  });

  it('updates published when caller provides it (unpublish action)', () => {
    const orgLanguages = makeOrgLanguages({ name: 'arabic', published: true, document: 'doc' });
    const result = upsertLanguage(
      orgLanguages,
      { name: 'arabic', published: false, document: 'doc' },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.published).toBe(false);
  });

  it('persists published on a brand-new language', () => {
    const orgLanguages = makeOrgLanguages();
    const result = upsertLanguage(
      orgLanguages,
      { name: 'arabic', published: true, document: 'doc' },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.published).toBe(true);
  });

  it('omits published key on new language when not supplied (defaults to draft)', () => {
    const orgLanguages = makeOrgLanguages();
    const result = upsertLanguage(orgLanguages, { name: 'arabic', document: 'doc' }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedLanguage.published).toBeUndefined();
  });
});
