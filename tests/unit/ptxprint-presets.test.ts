import { describe, expect, it } from 'vitest';
import { BOOK_INDEX, getPreset, isPresetId } from '../../src/services/ptxprint/presets.js';

describe('preset registry', () => {
  it('isPresetId only accepts the v1 default', () => {
    expect(isPresetId('bsb-empirical')).toBe(true);
    expect(isPresetId('paperback-a5')).toBe(false);
    expect(isPresetId('letter-2col')).toBe(false);
    expect(isPresetId('not-a-preset')).toBe(false);
    expect(isPresetId(null)).toBe(false);
    expect(isPresetId(123)).toBe(false);
  });

  it('exposes the canon-validated config_files from the fixture', () => {
    const preset = getPreset('bsb-empirical');
    const keys = Object.keys(preset.configFiles).sort();
    expect(keys).toEqual([
      'Settings.xml',
      'custom.sty',
      'shared/ptxprint/Default/ptxprint-mods.sty',
      'shared/ptxprint/Default/ptxprint.cfg',
      'shared/ptxprint/Default/ptxprint.sty',
    ]);
  });

  it('Settings.xml from the preset declares the test.usfm filename convention', () => {
    const preset = getPreset('bsb-empirical');
    const settings = preset.configFiles['Settings.xml']!;
    expect(settings).toContain('<FileNamePostPart>test.usfm</FileNamePostPart>');
    expect(settings).toContain('<LanguageIsoCode>en</LanguageIsoCode>');
    expect(settings).toContain('<Versification>4</Versification>');
  });

  it('exposes the four Gentium Plus fonts hosted by ptxprint-mcp', () => {
    const preset = getPreset('bsb-empirical');
    expect(preset.fonts).toHaveLength(4);
    const names = preset.fonts.map((f) => f.filename).sort();
    expect(names).toEqual([
      'GentiumPlus-Bold.ttf',
      'GentiumPlus-BoldItalic.ttf',
      'GentiumPlus-Italic.ttf',
      'GentiumPlus-Regular.ttf',
    ]);
    for (const f of preset.fonts) {
      expect(f.url).toMatch(/^https:\/\/ptxprint-mcp\.klappy\.workers\.dev\//);
      expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(f.family_id).toBe('gentiumplus');
    }
  });

  it('throws for unknown preset id', () => {
    expect(() => getPreset('paperback-a5' as never)).toThrow(/Unknown preset id/);
  });
});

describe('BOOK_INDEX', () => {
  it('contains the canonical Paratext indexes for the v1 books', () => {
    expect(BOOK_INDEX.GEN).toBe('01');
    expect(BOOK_INDEX.MAT).toBe('41');
    expect(BOOK_INDEX.JHN).toBe('44');
    expect(BOOK_INDEX.REV).toBe('67');
  });
});
