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

export { BOOK_INDEX } from '../../utils/bible-books.js';
