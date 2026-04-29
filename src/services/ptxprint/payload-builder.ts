/**
 * Build the ptxprint-mcp `submit_typeset` payload from preset + sources +
 * Settings.xml. Pure function — deterministic for cacheability (ptxprint-mcp
 * content-addresses payloads with sha256-of-canonicalized-JSON, so any
 * non-determinism here costs us cache hits).
 */

import { buildPtxprintCfg, getPreset } from './presets.js';
import { buildSettingsXml, SettingsXmlInput } from './settings-xml.js';
import { PayloadSource, PresetId, PtxprintPayload } from './types.js';

export interface BuildPayloadInput {
  presetId: PresetId;
  /** Bare project id, ≤8 chars. Typically derived from translation id, e.g. "en_ult". */
  projectId: string;
  books: string[];
  sources: PayloadSource[];
  settingsXml: SettingsXmlInput;
}

/** Truncate a string to the ptxprint project_id constraint (≤8 chars). */
export function truncateProjectId(input: string): string {
  // ptxprint-mcp/src/payload.ts: `project_id: z.string().min(1).max(8)`.
  // We strip non-alphanumeric to dodge schema rejection on typical translation ids.
  const cleaned = input.replace(/[^A-Za-z0-9]/g, '');
  return cleaned.slice(0, 8) || 'project';
}

export function buildPayload(input: BuildPayloadInput): PtxprintPayload {
  const preset = getPreset(input.presetId);
  const cfg = buildPtxprintCfg(preset);
  const settingsXml = buildSettingsXml(input.settingsXml);

  return {
    schema_version: '1.0',
    project_id: truncateProjectId(input.projectId),
    config_name: 'Default',
    books: input.books,
    mode: 'simple',
    define: {},
    config_files: {
      'Settings.xml': settingsXml,
      'shared/ptxprint/Default/ptxprint.cfg': cfg,
    },
    sources: input.sources,
    fonts: [],
    figures: [],
  };
}
