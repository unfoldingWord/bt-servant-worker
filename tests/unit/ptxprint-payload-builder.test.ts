import { describe, expect, it } from 'vitest';
import { buildPayload, truncateProjectId } from '../../src/services/ptxprint/payload-builder.js';

const sampleSource = {
  book: 'JHN',
  filename: '44JHNtest.usfm',
  url: 'https://example.com/public/ptxprint/usfm/en_ult/abc/44JHNtest.usfm',
  sha256: 'a'.repeat(64),
};

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
    const payload = buildPayload({
      presetId: 'bsb-empirical',
      projectId: 'en_ult',
      books: ['JHN'],
      sources: [sampleSource],
    });
    expect(payload.schema_version).toBe('1.0');
    expect(payload.project_id).toBe('enult');
    expect(payload.config_name).toBe('Default');
    expect(payload.books).toEqual(['JHN']);
    expect(payload.mode).toBe('simple');
    expect(payload.define).toEqual({});
    expect(payload.sources).toEqual([sampleSource]);
    expect(payload.figures).toEqual([]);
  });

  it('embeds the canon-validated config_files from the bsb-empirical preset', () => {
    const payload = buildPayload({
      presetId: 'bsb-empirical',
      projectId: 'enult',
      books: ['JHN'],
      sources: [sampleSource],
    });
    const keys = Object.keys(payload.config_files).sort();
    expect(keys).toEqual([
      'Settings.xml',
      'custom.sty',
      'shared/ptxprint/Default/ptxprint-mods.sty',
      'shared/ptxprint/Default/ptxprint.cfg',
      'shared/ptxprint/Default/ptxprint.sty',
    ]);
    expect(payload.config_files['Settings.xml']).toContain('LanguageIsoCode');
    expect(payload.config_files['shared/ptxprint/Default/ptxprint.cfg']).toContain('[paper]');
  });

  it('attaches the Gentium Plus font references', () => {
    const payload = buildPayload({
      presetId: 'bsb-empirical',
      projectId: 'enult',
      books: ['JHN'],
      sources: [sampleSource],
    });
    expect(payload.fonts).toHaveLength(4);
    expect(payload.fonts[0]?.family_id).toBe('gentiumplus');
  });
});
