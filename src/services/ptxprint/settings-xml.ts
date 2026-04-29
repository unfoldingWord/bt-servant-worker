/**
 * Settings.xml builder. This is the per-request, translation-specific config
 * file PTXprint reads to know what books are present, which versification to
 * use, and how source filenames are shaped.
 *
 * The shape is taken from ptxprint-mcp/smoke/fonts-payload.json's
 * config_files["Settings.xml"] — a known-good structure.
 */

import { buildBooksPresentBitmap } from './presets.js';

export interface SettingsXmlInput {
  /** ISO language code, e.g. "en". Drives PTXprint's text-direction + locale rules. */
  languageIsoCode: string;
  /** Versification scheme. 4 = English (KJV/NRSV-style). Mirrors the smoke. */
  versification: number;
  /** Books to include in the BooksPresent bitmap. */
  books: string[];
  /** Filename prefix pattern, e.g. "" (empty) — comes before the book code. */
  fileNamePrePart: string;
  /** Filename suffix pattern, e.g. "BSB.SFM" or ".usfm" — comes after the book code. */
  fileNamePostPart: string;
  /**
   * Filename book-name form. PTXprint accepts e.g. "41MAT" — a 2-digit index
   * concatenated with the 3-letter book code. We default to that form.
   */
  fileNameBookNameForm: string;
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildSettingsXml(input: SettingsXmlInput): string {
  const booksBitmap = buildBooksPresentBitmap(input.books);
  return `<ScriptureText>
  <StyleSheet>usfm.sty</StyleSheet>
  <BooksPresent>${booksBitmap}</BooksPresent>
  <Versification>${input.versification}</Versification>
  <LanguageIsoCode>${escapeXml(input.languageIsoCode)}</LanguageIsoCode>
  <FileNameBookNameForm>${escapeXml(input.fileNameBookNameForm)}</FileNameBookNameForm>
  <FileNamePrePart>${escapeXml(input.fileNamePrePart)}</FileNamePrePart>
  <FileNamePostPart>${escapeXml(input.fileNamePostPart)}</FileNamePostPart>
</ScriptureText>
`;
}
