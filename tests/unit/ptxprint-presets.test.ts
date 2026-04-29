import { describe, expect, it } from 'vitest';
import {
  bookBitmapIndex,
  BOOKS_PRESENT_LENGTH,
  buildBooksPresentBitmap,
  buildPtxprintCfg,
  getPreset,
  isPresetId,
  listPresets,
  PRESETS,
} from '../../src/services/ptxprint/presets.js';
import { buildSettingsXml } from '../../src/services/ptxprint/settings-xml.js';

describe('preset registry', () => {
  it('exposes exactly three presets', () => {
    const ids = listPresets()
      .map((p) => p.id)
      .sort();
    expect(ids).toEqual(['large-print-a4', 'letter-2col', 'paperback-a5']);
  });

  it('isPresetId rejects unknown ids', () => {
    expect(isPresetId('paperback-a5')).toBe(true);
    expect(isPresetId('letter-2col')).toBe(true);
    expect(isPresetId('large-print-a4')).toBe(true);
    expect(isPresetId('not-a-preset')).toBe(false);
    expect(isPresetId(null)).toBe(false);
    expect(isPresetId(123)).toBe(false);
  });

  it('each preset has distinct page-size, column, and font settings', () => {
    const a5 = getPreset('paperback-a5');
    const letter = getPreset('letter-2col');
    const a4 = getPreset('large-print-a4');
    expect(a5.pageSize).not.toEqual(letter.pageSize);
    expect(a5.pageSize).not.toEqual(a4.pageSize);
    expect(a5.twoColumn).toBe(false);
    expect(letter.twoColumn).toBe(true);
    expect(a4.twoColumn).toBe(false);
    expect(a5.fontFactor).toBe(11);
    expect(letter.fontFactor).toBe(10);
    expect(a4.fontFactor).toBe(14);
  });
});

describe('buildPtxprintCfg', () => {
  it('emits the expected paper section for each preset', () => {
    const a5 = buildPtxprintCfg(PRESETS['paperback-a5']);
    expect(a5).toContain('pagesize = 148mm, 210mm (A5)');
    expect(a5).toContain('columns = False');
    expect(a5).toContain('fontfactor = 11');

    const letter = buildPtxprintCfg(PRESETS['letter-2col']);
    expect(letter).toContain('pagesize = 8.5in, 11in (Letter)');
    expect(letter).toContain('columns = True');
    expect(letter).toContain('fontfactor = 10');

    const a4 = buildPtxprintCfg(PRESETS['large-print-a4']);
    expect(a4).toContain('pagesize = 210mm, 297mm (A4)');
    expect(a4).toContain('columns = False');
    expect(a4).toContain('fontfactor = 14');
  });

  it('references Charis SIL as the body font', () => {
    const cfg = buildPtxprintCfg(PRESETS['paperback-a5']);
    expect(cfg).toContain('fontregular = Charis SIL');
    expect(cfg).toContain('fontbold = Charis SIL');
  });

  it('produces deterministic output for cache stability', () => {
    const a = buildPtxprintCfg(PRESETS['paperback-a5']);
    const b = buildPtxprintCfg(PRESETS['paperback-a5']);
    expect(a).toBe(b);
  });
});

describe('BooksPresent bitmap', () => {
  it('bookBitmapIndex returns the canonical index', () => {
    expect(bookBitmapIndex('GEN')).toBe(0);
    expect(bookBitmapIndex('MAT')).toBe(40);
    expect(bookBitmapIndex('JHN')).toBe(43);
    expect(bookBitmapIndex('REV')).toBe(66);
    expect(bookBitmapIndex('XYZ')).toBeNull();
  });

  it('bitmap has the right length and ones at the correct positions', () => {
    const bitmap = buildBooksPresentBitmap(['JHN']);
    expect(bitmap.length).toBe(BOOKS_PRESENT_LENGTH);
    expect(bitmap[43]).toBe('1');
    expect(bitmap[42]).toBe('0');
    expect(bitmap[44]).toBe('0');
    // Exactly one bit set
    expect(bitmap.split('').filter((c) => c === '1').length).toBe(1);
  });

  it('handles multiple books', () => {
    const bitmap = buildBooksPresentBitmap(['GEN', 'JHN', 'REV']);
    expect(bitmap[0]).toBe('1');
    expect(bitmap[43]).toBe('1');
    expect(bitmap[66]).toBe('1');
    expect(bitmap.split('').filter((c) => c === '1').length).toBe(3);
  });

  it('throws on unknown book code', () => {
    expect(() => buildBooksPresentBitmap(['XYZ'])).toThrow(/Unknown book code/);
  });
});

describe('buildSettingsXml', () => {
  it('embeds language code, versification, and books bitmap', () => {
    const xml = buildSettingsXml({
      languageIsoCode: 'en',
      versification: 4,
      books: ['JHN'],
      fileNamePrePart: '',
      fileNamePostPart: '.SFM',
      fileNameBookNameForm: '44JHN',
    });
    expect(xml).toContain('<LanguageIsoCode>en</LanguageIsoCode>');
    expect(xml).toContain('<Versification>4</Versification>');
    expect(xml).toContain('<FileNameBookNameForm>44JHN</FileNameBookNameForm>');
    expect(xml).toContain('<FileNamePostPart>.SFM</FileNamePostPart>');
    // BooksPresent contains the JHN bit at index 43
    const m = xml.match(/<BooksPresent>([01]+)<\/BooksPresent>/);
    expect(m).not.toBeNull();
    expect(m![1]?.[43]).toBe('1');
  });

  it('escapes XML entities in user-provided strings', () => {
    const xml = buildSettingsXml({
      languageIsoCode: 'en',
      versification: 4,
      books: ['JHN'],
      fileNamePrePart: '<>&"\'',
      fileNamePostPart: '.SFM',
      fileNameBookNameForm: '44JHN',
    });
    expect(xml).toContain('&lt;&gt;&amp;&quot;&apos;');
  });
});
