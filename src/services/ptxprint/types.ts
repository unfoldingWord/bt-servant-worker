/**
 * Internal types for the ptxprint integration.
 *
 * AttachmentsContext mirrors the AudioContext side-channel pattern: tools
 * register an artifact during orchestration, UserDO drains the list onto
 * the final ChatResponse. Single direction; no read-back.
 */

import { Attachment } from '../../types/engine.js';
import { MCPServerConfig } from '../mcp/types.js';

export interface AttachmentsContext {
  add: (attachment: Attachment) => void;
  list: () => Attachment[];
}

export function createAttachmentsContext(): AttachmentsContext {
  const items: Attachment[] = [];
  return {
    add: (a) => {
      items.push(a);
    },
    list: () => items.slice(),
  };
}

/**
 * v1 ships one canon-validated preset. The id stays a string union (rather
 * than collapsing to no parameter) so the macro-tool's contract is forward-
 * compatible: future presets become additional union members without a
 * breaking change. Layout variation beyond this default is meant to flow
 * through ptxprint-mcp's `docs` tool plus the raw `submit_typeset` path —
 * see the tool descriptions in src/services/claude/tools.ts.
 */
export type PresetId = 'bsb-empirical';

export const DEFAULT_PRESET: PresetId = 'bsb-empirical';

/** The per-source payload entry expected by ptxprint-mcp's submit_typeset. */
export interface PayloadSource {
  book: string;
  filename: string;
  url: string;
  sha256: string;
}

/** The per-font payload entry. v1 always supplies an empty fonts array. */
export interface PayloadFont {
  family_id: string;
  version?: string;
  filename: string;
  url: string;
  sha256: string;
}

export interface PayloadFigure {
  filename: string;
  url: string;
  sha256: string;
}

/** Full ptxprint-mcp payload (matches PayloadSchema in ptxprint-mcp/src/payload.ts). */
export interface PtxprintPayload {
  schema_version: '1.0';
  project_id: string;
  config_name: string;
  books: string[];
  mode: 'simple' | 'autofill';
  define: Record<string, string>;
  config_files: Record<string, string>;
  sources: PayloadSource[];
  fonts: PayloadFont[];
  figures: PayloadFigure[];
}

/** Result of submit_typeset, parsed from the JSON-RPC text-content envelope. */
export interface SubmitTypesetResult {
  job_id: string;
  submitted_at: string;
  predicted_pdf_url: string;
  cached: boolean;
  payload_hash: string;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Result of get_job_status, parsed from the JSON-RPC text-content envelope. */
export interface JobStatusResult {
  state: JobState;
  failure_mode?: 'hard' | 'soft' | 'success';
  pdf_url?: string | null;
  log_url?: string | null;
  errors?: string[];
  human_summary?: string;
  progress?: {
    passes_completed?: number;
    passes_total_estimate?: number;
    current_phase?: string;
  };
}

/** Identifier we use to look up ptxprint-mcp inside the org's catalog. */
export const PTXPRINT_SERVER_ID = 'ptxprint-mcp';

/** Look up ptxprint-mcp's config from the org's catalog. Returns null when the org hasn't registered it. */
export function findPtxprintServer(
  serverMap: Map<string, MCPServerConfig>
): MCPServerConfig | null {
  return serverMap.get(PTXPRINT_SERVER_ID) ?? null;
}
