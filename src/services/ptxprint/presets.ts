/**
 * Three hardcoded layout presets for ptxprint-mcp v1.
 *
 * Each preset emits a `config_files` map keyed by virtual paths the container
 * lays down inside the project tree (`shared/ptxprint/Default/...` matches
 * `config_name = "Default"`). The actual PTXprint config (`ptxprint.cfg`) is
 * built from a shared template — presets vary only in the [paper] block plus
 * a font-size factor.
 *
 * Settings.xml is interpolated per-request because it carries
 * translation-specific values (LanguageIsoCode, BooksPresent bitmap,
 * filename pattern). The other two files are static per-preset.
 *
 * These are intentionally minimal — every key omitted falls back to PTXprint's
 * built-in default, and the smoke `smoke/minimal-payload.json` in ptxprint-mcp
 * proved that even `config_files: {}` produces a usable PDF. We layer on just
 * enough cfg to differentiate the three presets visibly.
 *
 * The colleague's upcoming config-generator MCP tool will replace these with
 * on-the-fly generation; presets become a thin compatibility wrapper or get
 * removed entirely. See issue #172.
 */

import { PresetId } from './types.js';

export interface PresetSpec {
  id: PresetId;
  label: string;
  description: string;
  /** PTXprint paper-size string. Format is mirrored from the fonts-payload smoke. */
  pageSize: string;
  /** Page width literal (same string PTXprint expects in [paper].width). */
  width: string;
  /** Page height literal. */
  height: string;
  /** Single-column (false) vs two-column (true) body. */
  twoColumn: boolean;
  /** Body font factor — bigger = larger body text. */
  fontFactor: number;
  /** Top margin in points. */
  topMargin: number;
  /** Bottom margin in points. */
  bottomMargin: number;
  /** Left/right margin in points. */
  margins: number;
}

export const PRESETS: Record<PresetId, PresetSpec> = {
  'paperback-a5': {
    id: 'paperback-a5',
    label: 'Paperback A5',
    description: 'A5 single-column reading Bible. Charis SIL 11pt body.',
    pageSize: '148mm, 210mm (A5)',
    width: '148mm',
    height: '210mm',
    twoColumn: false,
    fontFactor: 11,
    topMargin: 18,
    bottomMargin: 14.4,
    margins: 12,
  },
  'letter-2col': {
    id: 'letter-2col',
    label: 'Letter, 2 columns',
    description: 'US Letter two-column pew Bible. Charis SIL 10pt body.',
    pageSize: '8.5in, 11in (Letter)',
    width: '8.5in',
    height: '11in',
    twoColumn: true,
    fontFactor: 10,
    topMargin: 18,
    bottomMargin: 14.4,
    margins: 14,
  },
  'large-print-a4': {
    id: 'large-print-a4',
    label: 'Large Print A4',
    description: 'A4 single-column accessibility layout. Charis SIL 14pt body.',
    pageSize: '210mm, 297mm (A4)',
    width: '210mm',
    height: '297mm',
    twoColumn: false,
    fontFactor: 14,
    topMargin: 18,
    bottomMargin: 14.4,
    margins: 14,
  },
};

export function getPreset(id: PresetId): PresetSpec {
  // Object access on a known-narrow union is safe — TS guarantees membership.
  // eslint-disable-next-line security/detect-object-injection
  return PRESETS[id];
}

export function listPresets(): PresetSpec[] {
  // eslint-disable-next-line security/detect-object-injection
  return (Object.keys(PRESETS) as PresetId[]).map((id) => PRESETS[id]);
}

export function isPresetId(value: unknown): value is PresetId {
  return (
    typeof value === 'string' &&
    (value === 'paperback-a5' || value === 'letter-2col' || value === 'large-print-a4')
  );
}

/**
 * Render the ptxprint.cfg INI from a preset. Only the layout-relevant sections
 * are emitted — every other key falls back to bundled defaults. Charis SIL is
 * the bundled default font family in the container, so we don't have to ship
 * font references for v1 (see issue #173 for explicit fonts work).
 */
export function buildPtxprintCfg(preset: PresetSpec): string {
  const columns = preset.twoColumn ? 'True' : 'False';
  return `[paper]
pagesize = ${preset.pageSize}
width = ${preset.width}
height = ${preset.height}
columns = ${columns}
fontfactor = ${preset.fontFactor}
margins = ${preset.margins}
topmargin = ${preset.topMargin}
bottommargin = ${preset.bottomMargin}

[document]
fontregular = Charis SIL||false|false|
fontbold = Charis SIL| Bold|false|false|
fontitalic = Charis SIL| Italic|false|false|
fontbolditalic = Charis SIL| Bold Italic|false|false|
ifshowchapternums = True
ifshowversenums = True
ifusepiclist = False
ifinclfigs = False

[paragraph]
ifjustify = True
ifhyphenate = True
linespacing = 15

[notes]
includefootnotes = True
includexrefs = True

[config]
name = Default
`;
}

/**
 * Bookcode → 2-digit Paratext index used in canonical filenames like
 * "44JHN.SFM". USFM canonical book ordering — Genesis is 01, Matthew is 41,
 * Revelation is 67. Source: USFM spec book-id table (also referenced in
 * ptxprint-mcp/smoke/minimal-payload.json).
 */
export const BOOK_INDEX: Record<string, string> = {
  GEN: '01',
  EXO: '02',
  LEV: '03',
  NUM: '04',
  DEU: '05',
  JOS: '06',
  JDG: '07',
  RUT: '08',
  '1SA': '09',
  '2SA': '10',
  '1KI': '11',
  '2KI': '12',
  '1CH': '13',
  '2CH': '14',
  EZR: '15',
  NEH: '16',
  EST: '17',
  JOB: '18',
  PSA: '19',
  PRO: '20',
  ECC: '21',
  SNG: '22',
  ISA: '23',
  JER: '24',
  LAM: '25',
  EZK: '26',
  DAN: '27',
  HOS: '28',
  JOL: '29',
  AMO: '30',
  OBA: '31',
  JON: '32',
  MIC: '33',
  NAM: '34',
  HAB: '35',
  ZEP: '36',
  HAG: '37',
  ZEC: '38',
  MAL: '39',
  MAT: '41',
  MRK: '42',
  LUK: '43',
  JHN: '44',
  ACT: '45',
  ROM: '46',
  '1CO': '47',
  '2CO': '48',
  GAL: '49',
  EPH: '50',
  PHP: '51',
  COL: '52',
  '1TH': '53',
  '2TH': '54',
  '1TI': '55',
  '2TI': '56',
  TIT: '57',
  PHM: '58',
  HEB: '59',
  JAS: '60',
  '1PE': '61',
  '2PE': '62',
  '1JN': '63',
  '2JN': '64',
  '3JN': '65',
  JUD: '66',
  REV: '67',
};

/** Total slots in the BooksPresent bitmap (USFM canon length). */
export const BOOKS_PRESENT_LENGTH = 124;

/**
 * Position of each Paratext book in the BooksPresent bitmap.
 * Index = (parseInt(BOOK_INDEX[book]) - 1). Genesis at 0, John at 43.
 */
export function bookBitmapIndex(book: string): number | null {
  // eslint-disable-next-line security/detect-object-injection -- book is validated upstream
  const idx = BOOK_INDEX[book];
  if (!idx) return null;
  return parseInt(idx, 10) - 1;
}

/**
 * Build a 124-bit BooksPresent string with `1` set at the canonical position
 * of each requested book and `0` elsewhere. Mirrors the format seen in
 * ptxprint-mcp/smoke/fonts-payload.json's Settings.xml.
 */
export function buildBooksPresentBitmap(books: string[]): string {
  const bits = new Array<string>(BOOKS_PRESENT_LENGTH).fill('0');
  for (const book of books) {
    const idx = bookBitmapIndex(book);
    if (idx === null || idx < 0 || idx >= BOOKS_PRESENT_LENGTH) {
      throw new Error(`Unknown book code "${book}" — cannot build BooksPresent bitmap`);
    }
    // eslint-disable-next-line security/detect-object-injection
    bits[idx] = '1';
  }
  return bits.join('');
}
