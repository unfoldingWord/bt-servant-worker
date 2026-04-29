import { describe, expect, it } from 'vitest';
import { buildPayload, truncateProjectId } from '../../src/services/ptxprint/payload-builder.js';

const sampleSource = {
  book: 'JHN',
  filename: '44JHN.SFM',
  url: 'https://example.com/public/ptxprint/usfm/en_ult/abc/44JHN.SFM',
  sha256: 'a'.repeat(64),
};

const baseSettings = {
  languageIsoCode: 'en',
  versification: 4,
  books: ['JHN'],
  fileNamePrePart: '',
  fileNamePostPart: '.SFM',
  fileNameBookNameForm: '44JHN',
};

function makePayload(
  presetId: 'paperback-a5' | 'letter-2col' | 'large-print-a4',
  projectId = 'en_ult'
) {
  return buildPayload({
    presetId,
    projectId,
    books: ['JHN'],
    sources: [sampleSource],
    settingsXml: baseSettings,
  });
}

describe('truncateProjectId', () => {
  it('truncates to 8 chars and strips non-alphanumerics', () => {
    expect(truncateProjectId('en_ult')).toBe('enult');
    expect(truncateProjectId('a-very-long-translation-id')).toBe('averylon');
    expect(truncateProjectId('abc')).toBe('abc');
  });

  it('falls back to "project" if input collapses to empty', () => {
    expect(truncateProjectId('---')).toBe('project');
    expect(truncateProjectId('')).toBe('project');
  });
});

describe('buildPayload', () => {
  it('produces a schema-shaped payload', () => {
    const payload = makePayload('paperback-a5');
    expect(payload.schema_version).toBe('1.0');
    expect(payload.project_id).toBe('enult');
    expect(payload.config_name).toBe('Default');
    expect(payload.books).toEqual(['JHN']);
    expect(payload.mode).toBe('simple');
    expect(payload.define).toEqual({});
    expect(payload.sources).toEqual([sampleSource]);
    expect(payload.fonts).toEqual([]);
    expect(payload.figures).toEqual([]);
  });

  it('includes Settings.xml and ptxprint.cfg in config_files', () => {
    const payload = makePayload('paperback-a5', 'enult');
    const keys = Object.keys(payload.config_files).sort();
    expect(keys).toEqual(['Settings.xml', 'shared/ptxprint/Default/ptxprint.cfg']);
    expect(payload.config_files['Settings.xml']).toContain('LanguageIsoCode');
    expect(payload.config_files['shared/ptxprint/Default/ptxprint.cfg']).toContain('[paper]');
  });

  it('preset choice is reflected in the embedded cfg', () => {
    const a5 = makePayload('paperback-a5', 'enult');
    const a4 = makePayload('large-print-a4', 'enult');
    expect(a5.config_files['shared/ptxprint/Default/ptxprint.cfg']).toContain('A5');
    expect(a4.config_files['shared/ptxprint/Default/ptxprint.cfg']).toContain('A4');
    expect(a5.config_files['shared/ptxprint/Default/ptxprint.cfg']).not.toEqual(
      a4.config_files['shared/ptxprint/Default/ptxprint.cfg']
    );
  });
});
