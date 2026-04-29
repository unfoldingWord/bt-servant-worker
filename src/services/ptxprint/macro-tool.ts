/**
 * Macro-tool for the ptxprint integration. Two entry points used by the
 * orchestrator's internal-tool dispatch:
 *
 *   - `handleGenerateScripturePdf` — happy-path one-shot:
 *       (translation, book, preset?) → resolve USFM → submit_typeset →
 *       poll → mirror PDF → push attachment → return summary.
 *
 *   - `handlePrepareUsfmSource` — exposes the USFM resolver to Claude so
 *       it can hand-build payloads for raw `submit_typeset` calls (the
 *       raw MCP tools can't compute sha256 in-conversation).
 *
 * Cancellation is handled by the raw MCP `cancel_job` tool (registered via
 * the catalog when ptxprint-mcp is configured for the org). We don't expose
 * a wrapper for it.
 *
 * Logging: every external call is bracketed by start/complete events, every
 * error path logs context. Project rule (CLAUDE.md): no silent catches.
 */

import { Env } from '../../config/types.js';
import { Attachment } from '../../types/engine.js';
import { RequestLogger } from '../../utils/logger.js';
import { callMCPTool } from '../mcp/discovery.js';
import { ToolCatalog } from '../mcp/types.js';
import { mirrorPdf, buildPdfR2Key, PdfMirrorError } from './pdf-mirror.js';
import { buildPayload } from './payload-builder.js';
import { BOOK_INDEX, isPresetId } from './presets.js';
import { pollUntilDone } from './poll.js';
import { isSupportedTranslation, resolveUsfmSource, UsfmSourceError } from './usfm-source.js';
import {
  AttachmentsContext,
  DEFAULT_PRESET,
  findPtxprintServer,
  JobStatusResult,
  PresetId,
  PTXPRINT_SERVER_ID,
  SubmitTypesetResult,
} from './types.js';

export interface PtxprintToolContext {
  env: Env;
  catalog: ToolCatalog;
  workerOrigin: string;
  attachmentsContext: AttachmentsContext | undefined;
  logger: RequestLogger;
}

/**
 * `submit_typeset` returns a JSON-stringified envelope inside content[0].text.
 * `extractTextContent` in discovery.ts unwraps the array → string for us;
 * we JSON.parse to get the structured payload.
 */
function parseSubmitResult(raw: unknown, logger: RequestLogger): SubmitTypesetResult {
  if (typeof raw !== 'string') {
    logger.error('ptxprint_submit_unexpected_shape', null, {
      type: typeof raw,
      preview: JSON.stringify(raw).slice(0, 500),
    });
    throw new Error('ptxprint-mcp submit_typeset returned non-string content');
  }
  try {
    const parsed = JSON.parse(raw) as SubmitTypesetResult;
    return parsed;
  } catch (error) {
    logger.error('ptxprint_submit_parse_error', error, {
      raw_preview: raw.slice(0, 500),
    });
    throw new Error('ptxprint-mcp submit_typeset returned invalid JSON');
  }
}

function parseStatusResult(raw: unknown, logger: RequestLogger): JobStatusResult {
  if (typeof raw !== 'string') {
    logger.error('ptxprint_status_unexpected_shape', null, {
      type: typeof raw,
      preview: JSON.stringify(raw).slice(0, 500),
    });
    throw new Error('ptxprint-mcp get_job_status returned non-string content');
  }
  try {
    return JSON.parse(raw) as JobStatusResult;
  } catch (error) {
    logger.error('ptxprint_status_parse_error', error, {
      raw_preview: raw.slice(0, 500),
    });
    throw new Error('ptxprint-mcp get_job_status returned invalid JSON');
  }
}

// ---------- Input validation ----------

export interface GenerateScripturePdfInput {
  translation: string;
  book: string;
  preset?: string;
}

function isOptionalString(obj: Record<string, unknown>, key: string): boolean {
  if (!(key in obj)) return true;
  // eslint-disable-next-line security/detect-object-injection -- key is hardcoded
  const v = obj[key];
  return v === undefined || v === null || typeof v === 'string';
}

export function isGenerateScripturePdfInput(input: unknown): input is GenerateScripturePdfInput {
  if (typeof input !== 'object' || input === null) return false;
  const obj = input as Record<string, unknown>;
  if (typeof obj.translation !== 'string' || obj.translation.length === 0) return false;
  if (typeof obj.book !== 'string' || obj.book.length < 2 || obj.book.length > 3) return false;
  return isOptionalString(obj, 'preset');
}

export interface PrepareUsfmSourceInput {
  translation: string;
  book: string;
}

export function isPrepareUsfmSourceInput(input: unknown): input is PrepareUsfmSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const obj = input as Record<string, unknown>;
  if (typeof obj.translation !== 'string' || obj.translation.length === 0) return false;
  if (typeof obj.book !== 'string' || obj.book.length < 2 || obj.book.length > 3) return false;
  return true;
}

// ---------- handlePrepareUsfmSource ----------

export async function handlePrepareUsfmSource(
  input: PrepareUsfmSourceInput,
  ctx: PtxprintToolContext
): Promise<unknown> {
  const { logger } = ctx;
  logger.log('prepare_usfm_source_start', {
    translation: input.translation,
    book: input.book,
  });

  if (!isSupportedTranslation(input.translation)) {
    logger.warn('prepare_usfm_source_unsupported_translation', {
      translation: input.translation,
    });
    return {
      error: `Unsupported translation: ${input.translation}. v1 supports en_ult, en_ust, en_t4t, en_ueb.`,
    };
  }

  try {
    const source = await resolveUsfmSource({
      translation: input.translation,
      book: input.book.toUpperCase(),
      bucket: ctx.env.PTXPRINT_BUCKET,
      baseUrl: ctx.workerOrigin,
      logger,
    });
    logger.log('prepare_usfm_source_complete', {
      translation: input.translation,
      book: source.book,
      sha256: source.sha256,
      url: source.url,
    });
    return source;
  } catch (error) {
    const cause = error instanceof UsfmSourceError ? error.cause : 'unknown';
    logger.error('prepare_usfm_source_error', error, {
      translation: input.translation,
      book: input.book,
      cause,
    });
    return {
      error: `Failed to prepare USFM source: ${error instanceof Error ? error.message : String(error)}`,
      cause,
    };
  }
}

// ---------- handleGenerateScripturePdf ----------

interface InternalSuccessResult {
  status: 'succeeded';
  job_id: string;
  cached: boolean;
  pdf_url: string;
  pdf_size_bytes: number;
  preset: PresetId;
  translation: string;
  book: string;
  filename: string;
  total_ms: number;
}

interface InternalPendingResult {
  status: 'pending';
  job_id: string;
  message: string;
  polls: number;
  elapsed_ms: number;
  last_state: string;
  human_summary: string | null;
}

interface InternalErrorResult {
  status: 'error' | 'failed';
  message: string;
  job_id?: string;
  cause?: string;
  errors?: string[];
  failure_mode?: string;
}

/** Submit the payload and parse the response. */
async function submitTypesetCall(
  server: Parameters<typeof callMCPTool>[0],
  payload: unknown,
  logger: import('../../utils/logger.js').RequestLogger
): Promise<SubmitTypesetResult | InternalErrorResult> {
  const submitStart = Date.now();
  try {
    const callResult = await callMCPTool(server, 'submit_typeset', { payload }, logger);
    const submit = parseSubmitResult(callResult.result, logger);
    logger.log('generate_scripture_pdf_submitted', {
      job_id: submit.job_id,
      cached: submit.cached,
      payload_hash: submit.payload_hash,
      predicted_pdf_url: submit.predicted_pdf_url,
      submit_ms: Date.now() - submitStart,
    });
    return submit;
  } catch (error) {
    logger.error('generate_scripture_pdf_submit_error', error, {
      duration_ms: Date.now() - submitStart,
    });
    return {
      status: 'error',
      message: `submit_typeset failed: ${error instanceof Error ? error.message : String(error)}`,
      cause: 'submit_failed',
    };
  }
}

function buildTimeoutResult(
  pollResult: import('./poll.js').PollResult,
  submit: SubmitTypesetResult,
  logger: import('../../utils/logger.js').RequestLogger
): InternalPendingResult {
  logger.warn('generate_scripture_pdf_poll_timeout_returned_pending', {
    job_id: submit.job_id,
    polls: pollResult.polls,
    elapsed_ms: pollResult.elapsed_ms,
  });
  return {
    status: 'pending',
    job_id: submit.job_id,
    message:
      'PDF job is taking longer than expected. Try asking again in about a minute — same request will pick up the cached result instantly when ready.',
    polls: pollResult.polls,
    elapsed_ms: pollResult.elapsed_ms,
    last_state: pollResult.state,
    human_summary: pollResult.lastStatus?.human_summary ?? null,
  };
}

function buildTerminalFailureResult(
  pollResult: import('./poll.js').PollResult,
  submit: SubmitTypesetResult,
  logger: import('../../utils/logger.js').RequestLogger
): InternalErrorResult {
  const errs = pollResult.lastStatus?.errors;
  const fm = pollResult.lastStatus?.failure_mode;
  logger.error('generate_scripture_pdf_terminal_failure', null, {
    job_id: submit.job_id,
    outcome: pollResult.outcome,
    failure_mode: fm ?? null,
    errors: errs ?? [],
    human_summary: pollResult.lastStatus?.human_summary ?? null,
  });
  const result: InternalErrorResult = {
    status: 'failed',
    job_id: submit.job_id,
    message: `PDF generation ${pollResult.outcome}.`,
  };
  if (errs) result.errors = errs;
  if (fm) result.failure_mode = fm;
  return result;
}

function pollOutcomeToResult(
  pollResult: import('./poll.js').PollResult,
  submit: SubmitTypesetResult,
  logger: import('../../utils/logger.js').RequestLogger
): { url: string } | InternalPendingResult | InternalErrorResult {
  if (pollResult.outcome === 'timeout') return buildTimeoutResult(pollResult, submit, logger);
  if (pollResult.outcome === 'failed' || pollResult.outcome === 'cancelled') {
    return buildTerminalFailureResult(pollResult, submit, logger);
  }
  if (!pollResult.lastStatus?.pdf_url) {
    logger.error('generate_scripture_pdf_succeeded_without_pdf_url', null, {
      job_id: submit.job_id,
      last_status: pollResult.lastStatus,
    });
    return {
      status: 'error',
      message: 'ptxprint-mcp reported success but did not provide a pdf_url.',
      job_id: submit.job_id,
      cause: 'missing_pdf_url',
    };
  }
  return { url: pollResult.lastStatus.pdf_url };
}

/** Resolve a job to a fetchable PDF URL. Returns either the URL or an early-exit result. */
async function resolvePdfUrl(
  server: Parameters<typeof callMCPTool>[0],
  submit: SubmitTypesetResult,
  logger: import('../../utils/logger.js').RequestLogger
): Promise<{ url: string } | InternalPendingResult | InternalErrorResult> {
  if (submit.cached) {
    logger.log('generate_scripture_pdf_using_cached_url', {
      job_id: submit.job_id,
      url: submit.predicted_pdf_url,
    });
    return { url: submit.predicted_pdf_url };
  }
  const pollResult = await pollUntilDone(
    submit.job_id,
    async (jobId) => {
      const callResult = await callMCPTool(server, 'get_job_status', { job_id: jobId }, logger);
      return parseStatusResult(callResult.result, logger);
    },
    logger
  );
  return pollOutcomeToResult(pollResult, submit, logger);
}

interface FinalizePdfOpts {
  submit: SubmitTypesetResult;
  pdfSourceUrl: string;
  presetId: PresetId;
  translation: string;
  book: string;
  overall: number;
}

async function doMirror(
  ctx: PtxprintToolContext,
  opts: FinalizePdfOpts
): Promise<{ url: string; size_bytes: number } | InternalErrorResult> {
  const { logger } = ctx;
  const { submit, pdfSourceUrl } = opts;
  const pdfKey = buildPdfR2Key('shared', 'jobs', submit.job_id);
  try {
    return await mirrorPdf({
      sourceUrl: pdfSourceUrl,
      key: pdfKey,
      bucket: ctx.env.PTXPRINT_BUCKET,
      baseUrl: ctx.workerOrigin,
      logger,
    });
  } catch (error) {
    const cause = error instanceof PdfMirrorError ? error.cause : 'unknown';
    logger.error('generate_scripture_pdf_mirror_error', error, {
      job_id: submit.job_id,
      source_url: pdfSourceUrl,
      target_key: pdfKey,
      cause,
    });
    return {
      status: 'error',
      message: `Failed to mirror PDF into our R2: ${error instanceof Error ? error.message : String(error)}`,
      job_id: submit.job_id,
      cause,
    };
  }
}

function registerAttachment(ctx: PtxprintToolContext, attachment: Attachment, jobId: string): void {
  const { logger } = ctx;
  if (ctx.attachmentsContext) {
    ctx.attachmentsContext.add(attachment);
    logger.log('generate_scripture_pdf_attachment_registered', {
      job_id: jobId,
      url: attachment.url,
      filename: attachment.filename,
      size_bytes: attachment.size_bytes,
    });
  } else {
    logger.warn('generate_scripture_pdf_no_attachments_context', {
      job_id: jobId,
      reason: 'attachmentsContext is undefined; PDF generated but will not surface on ChatResponse',
    });
  }
}

/** Mirror the PDF, register the attachment, return success. */
async function finalizePdf(
  ctx: PtxprintToolContext,
  opts: FinalizePdfOpts
): Promise<InternalSuccessResult | InternalErrorResult> {
  const { logger } = ctx;
  const { submit, presetId, translation, book, overall } = opts;
  const mirrorResult = await doMirror(ctx, opts);
  if ('status' in mirrorResult) return mirrorResult;

  const filename = `${translation}-${book}-${presetId}.pdf`;
  const attachment: Attachment = {
    type: 'pdf',
    url: mirrorResult.url,
    filename,
    size_bytes: mirrorResult.size_bytes,
    mime_type: 'application/pdf',
  };
  registerAttachment(ctx, attachment, submit.job_id);

  const total_ms = Date.now() - overall;
  logger.log('generate_scripture_pdf_complete', {
    job_id: submit.job_id,
    cached: submit.cached,
    translation,
    book,
    preset: presetId,
    pdf_url: mirrorResult.url,
    pdf_size_bytes: mirrorResult.size_bytes,
    total_ms,
  });

  return {
    status: 'succeeded',
    job_id: submit.job_id,
    cached: submit.cached,
    pdf_url: mirrorResult.url,
    pdf_size_bytes: mirrorResult.size_bytes,
    preset: presetId,
    translation,
    book,
    filename,
    total_ms,
  };
}

interface PreflightOk {
  ok: true;
  server: ReturnType<typeof findPtxprintServer> & object;
  translation: import('./usfm-source.js').SupportedTranslation;
}

function preflight(
  ctx: PtxprintToolContext,
  translation: string
): PreflightOk | InternalErrorResult {
  const { logger } = ctx;
  const server = findPtxprintServer(ctx.catalog.serverMap);
  if (!server) {
    logger.error('generate_scripture_pdf_no_server', null, {
      catalog_server_ids: Array.from(ctx.catalog.serverMap.keys()),
      expected_server_id: PTXPRINT_SERVER_ID,
    });
    return {
      status: 'error',
      message: `ptxprint-mcp is not registered for this organization (expected MCP server id "${PTXPRINT_SERVER_ID}").`,
      cause: 'server_not_registered',
    };
  }
  logger.log('generate_scripture_pdf_server_resolved', {
    server_id: server.id,
    server_url: server.url,
  });
  if (!isSupportedTranslation(translation)) {
    logger.warn('generate_scripture_pdf_unsupported_translation', { translation });
    return {
      status: 'error',
      message: `Unsupported translation: ${translation}. v1 supports en_ult, en_ust, en_t4t, en_ueb.`,
      cause: 'unsupported_translation',
    };
  }
  return { ok: true, server, translation };
}

async function resolveSourceForRequest(
  ctx: PtxprintToolContext,
  translation: import('./usfm-source.js').SupportedTranslation,
  book: string
) {
  const { logger } = ctx;
  try {
    return await resolveUsfmSource({
      translation,
      book,
      bucket: ctx.env.PTXPRINT_BUCKET,
      baseUrl: ctx.workerOrigin,
      logger,
    });
  } catch (error) {
    const cause = error instanceof UsfmSourceError ? error.cause : 'unknown';
    logger.error('generate_scripture_pdf_usfm_resolve_error', error, {
      translation,
      book,
      cause,
    });
    return {
      status: 'error' as const,
      message: `Failed to resolve USFM source: ${error instanceof Error ? error.message : String(error)}`,
      cause,
    };
  }
}

function buildPayloadForRequest(
  ctx: PtxprintToolContext,
  presetId: PresetId,
  translation: string,
  book: string,
  source: import('./types.js').PayloadSource
): ReturnType<typeof buildPayload> | InternalErrorResult {
  // eslint-disable-next-line security/detect-object-injection -- book validated above
  const bookNum = BOOK_INDEX[book];
  if (!bookNum) {
    ctx.logger.error('generate_scripture_pdf_unknown_book_for_payload', null, { book });
    return { status: 'error', message: `Unknown book code: ${book}`, cause: 'unknown_book' };
  }
  const payload = buildPayload({
    presetId,
    projectId: translation,
    books: [book],
    sources: [source],
    settingsXml: {
      languageIsoCode: 'en',
      versification: 4,
      books: [book],
      fileNameBookNameForm: `${bookNum}${book}`,
      fileNamePrePart: '',
      fileNamePostPart: '.SFM',
    },
  });
  ctx.logger.log('generate_scripture_pdf_payload_built', {
    project_id: payload.project_id,
    config_name: payload.config_name,
    books: payload.books,
    mode: payload.mode,
    source_count: payload.sources.length,
    config_file_keys: Object.keys(payload.config_files),
  });
  return payload;
}

export async function handleGenerateScripturePdf(
  input: GenerateScripturePdfInput,
  ctx: PtxprintToolContext
): Promise<InternalSuccessResult | InternalPendingResult | InternalErrorResult> {
  const { logger } = ctx;
  const overall = Date.now();
  const presetId: PresetId = isPresetId(input.preset) ? input.preset : DEFAULT_PRESET;
  const translation = input.translation;
  const book = input.book.toUpperCase();

  logger.log('generate_scripture_pdf_start', {
    translation,
    book,
    requested_preset: input.preset ?? null,
    resolved_preset: presetId,
  });

  const pre = preflight(ctx, translation);
  if (!('ok' in pre)) return pre;
  const { server } = pre;

  const sourceResult = await resolveSourceForRequest(ctx, pre.translation, book);
  if ('status' in sourceResult) return sourceResult;

  const payloadResult = buildPayloadForRequest(ctx, presetId, translation, book, sourceResult);
  if ('status' in payloadResult) return payloadResult;

  const submitOrError = await submitTypesetCall(server, payloadResult, logger);
  if ('status' in submitOrError) return submitOrError;

  const pdfUrlOrEarly = await resolvePdfUrl(server, submitOrError, logger);
  if ('status' in pdfUrlOrEarly) return pdfUrlOrEarly;

  return finalizePdf(ctx, {
    submit: submitOrError,
    pdfSourceUrl: pdfUrlOrEarly.url,
    presetId,
    translation,
    book,
    overall,
  });
}
