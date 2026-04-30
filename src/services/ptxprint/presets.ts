/**
 * v1 ships one canon-validated preset, `bsb-empirical`.
 *
 * Source of truth: `fixture-bsb-empirical.json`, copied verbatim from
 * `ptxprint-mcp/smoke/bsb-jhn-empirical.json`. That fixture is the working
 * config the upstream maintainer landed in their session-12 iteration —
 * tracked, reproducible, validated end-to-end through the deployed worker
 * (renders BSB Gospel of John as a 360KB / 61-page PDF in ~13s).
 *
 * Why pin to that fixture instead of hand-crafting layout variants:
 *   1. Hand-crafted cfg/sty content is brittle. Our own first attempt at
 *      A5 / letter-2col / A4 presets passed payload validation but produced
 *      "PTXprint produced no output (silent exit)" inside the container —
 *      the cfg shape is not something to invent without the canon.
 *   2. ptxprint-mcp now exposes a `docs` tool (auto-discovered on the
 *      catalog now that streamable-HTTP transport works). The intended path
 *      for layout variation is: agent calls `docs("config_files for X")`,
 *      gets canon guidance, hand-builds a payload via `prepare_usfm_source`
 *      + `submit_typeset`. The macro-tool stays as the one-shot happy path
 *      for the default; everything else goes through that loop.
 *
 * BooksPresent: the fixture's bitmap covers all 66 canonical books, so the
 * single fixture works for any DCS book we resolve. PTXprint only typesets
 * books listed in `payload.books`, so the bitmap being permissive does not
 * cause unrelated books to render.
 *
 * Settings.xml: kept verbatim from the fixture (no per-request templating in
 * v1). The fixture's `LanguageIsoCode = en` is fine for the four DCS open
 * translations we ship, all of which are English. When non-English
 * translations land, this becomes a templated field — alternatively, that
 * codepath migrates entirely to the docs+raw-tools loop.
 */

import fixture from './fixture-bsb-empirical.json' with { type: 'json' };
import { PayloadFont, PresetId } from './types.js';

export interface PresetData {
  id: PresetId;
  /** Map of relative path → file content. Passed verbatim into payload.config_files. */
  configFiles: Record<string, string>;
  /** Font references already hosted in ptxprint-mcp's R2 — no rehosting required. */
  fonts: PayloadFont[];
}

const FIXTURE_CONFIG_FILES = fixture.config_files as Record<string, string>;
const FIXTURE_FONTS = fixture.fonts as PayloadFont[];

export function getPreset(id: PresetId): PresetData {
  if (id !== 'bsb-empirical') {
    throw new Error(`Unknown preset id: ${id}`);
  }
  return {
    id,
    configFiles: FIXTURE_CONFIG_FILES,
    fonts: FIXTURE_FONTS,
  };
}

export function isPresetId(value: unknown): value is PresetId {
  return value === 'bsb-empirical';
}

/**
 * Bookcode → 2-digit Paratext index used in canonical filenames like
 * "44JHN.SFM". USFM canonical book ordering — Genesis is 01, Matthew is 41,
 * Revelation is 67. Source: USFM spec book-id table.
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
