import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock callMCPTool BEFORE importing the macro tool.
const callMCPToolMock = vi.fn();
vi.mock('../../src/services/mcp/discovery.js', () => ({
  callMCPTool: (...args: unknown[]) => callMCPToolMock(...args),
}));

import {
  handleGenerateScripturePdf,
  handlePrepareUsfmSource,
  isGenerateScripturePdfInput,
  isPrepareUsfmSourceInput,
  PtxprintToolContext,
} from '../../src/services/ptxprint/macro-tool.js';
import { createAttachmentsContext } from '../../src/services/ptxprint/types.js';
import { CatalogTool, MCPServerConfig, ToolCatalog } from '../../src/services/mcp/types.js';
import { createRequestLogger } from '../../src/utils/logger.js';

const logger = createRequestLogger('test-request');

const PTXPRINT_SERVER: MCPServerConfig = {
  id: 'ptxprint-mcp',
  name: 'ptxprint-mcp',
  url: 'https://ptxprint-mcp.example.com/mcp',
  enabled: true,
  priority: 20,
};

const FAKE_USFM = '\\id JHN\n\\h John\n\\c 1\n\\v 1 In the beginning.\n';
const FAKE_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function buildCatalog(servers: MCPServerConfig[]): ToolCatalog {
  const tools: CatalogTool[] = [];
  const serverMap = new Map<string, MCPServerConfig>();
  for (const s of servers) serverMap.set(s.id, s);
  return { tools, serverMap };
}

function buildCtx(catalog?: ToolCatalog): PtxprintToolContext {
  return {
    env,
    catalog: catalog ?? buildCatalog([PTXPRINT_SERVER]),
    workerOrigin: 'https://w.example.com',
    attachmentsContext: createAttachmentsContext(),
    logger,
  };
}

async function clearBucket() {
  const list = await env.PTXPRINT_BUCKET.list();
  for (const obj of list.objects) {
    await env.PTXPRINT_BUCKET.delete(obj.key);
  }
}

beforeEach(async () => {
  await clearBucket();
  callMCPToolMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Input validators ----

describe('isGenerateScripturePdfInput', () => {
  it('accepts valid input', () => {
    expect(isGenerateScripturePdfInput({ translation: 'en_ult', book: 'JHN' })).toBe(true);
    expect(
      isGenerateScripturePdfInput({ translation: 'en_ult', book: 'JHN', preset: 'paperback-a5' })
    ).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isGenerateScripturePdfInput({})).toBe(false);
    expect(isGenerateScripturePdfInput({ translation: 'en_ult' })).toBe(false);
    expect(isGenerateScripturePdfInput({ translation: 'en_ult', book: '' })).toBe(false);
    expect(isGenerateScripturePdfInput({ translation: 'en_ult', book: 'JOHN' })).toBe(false);
    expect(isGenerateScripturePdfInput(null)).toBe(false);
  });
});

describe('isPrepareUsfmSourceInput', () => {
  it('accepts valid input', () => {
    expect(isPrepareUsfmSourceInput({ translation: 'en_ult', book: 'JHN' })).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isPrepareUsfmSourceInput({})).toBe(false);
    expect(isPrepareUsfmSourceInput({ translation: 'en_ult', book: 123 })).toBe(false);
  });
});

// ---- handlePrepareUsfmSource ----

describe('handlePrepareUsfmSource', () => {
  it('returns the resolved source on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(FAKE_USFM, { status: 200 }))
    );
    const result = await handlePrepareUsfmSource(
      { translation: 'en_ult', book: 'JHN' },
      buildCtx()
    );
    expect(result).toMatchObject({
      book: 'JHN',
      filename: '44JHN.SFM',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('rejects unsupported translation with a structured error', async () => {
    const result = (await handlePrepareUsfmSource(
      { translation: 'en_kjv', book: 'JHN' },
      buildCtx()
    )) as { error?: string };
    expect(result.error).toMatch(/Unsupported translation/);
  });
});

// ---- handleGenerateScripturePdf ----

describe('handleGenerateScripturePdf — happy path (cached)', () => {
  it('returns succeeded with our public URL when ptxprint-mcp reports cached:true', async () => {
    // First fetch is DCS USFM. Second is the PDF mirror.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes('git.door43.org')) {
        return new Response(FAKE_USFM, { status: 200 });
      }
      // assume PDF mirror
      return new Response(FAKE_PDF, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    callMCPToolMock.mockResolvedValueOnce({
      result: JSON.stringify({
        job_id: 'job-cached',
        submitted_at: '2026-04-29T00:00:00Z',
        predicted_pdf_url: 'https://ptxprint-mcp.example.com/r2/outputs/abc/john.pdf',
        cached: true,
        payload_hash: 'hash-cached',
      }),
      metadata: undefined,
      responseTimeMs: 5,
    });

    const ctx = buildCtx();
    const result = await handleGenerateScripturePdf({ translation: 'en_ult', book: 'JHN' }, ctx);

    expect(result).toMatchObject({
      status: 'succeeded',
      job_id: 'job-cached',
      cached: true,
      preset: 'paperback-a5',
      translation: 'en_ult',
      book: 'JHN',
    });
    expect((result as { pdf_url: string }).pdf_url).toMatch(
      /^https:\/\/w\.example\.com\/public\/ptxprint\/pdfs\//
    );
    // submit_typeset called, get_job_status NOT called (cached short-circuit).
    expect(callMCPToolMock).toHaveBeenCalledTimes(1);
    expect(callMCPToolMock.mock.calls[0]?.[1]).toBe('submit_typeset');
    // Attachment registered.
    const attachments = ctx.attachmentsContext!.list();
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.type).toBe('pdf');
  });
});

describe('handleGenerateScripturePdf — happy path (poll succeeds)', () => {
  it('polls then mirrors the resolved PDF URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (u.includes('git.door43.org')) return new Response(FAKE_USFM, { status: 200 });
        return new Response(FAKE_PDF, { status: 200 });
      })
    );

    // submit_typeset → uncached
    callMCPToolMock.mockResolvedValueOnce({
      result: JSON.stringify({
        job_id: 'job-uncached',
        submitted_at: '2026-04-29T00:00:00Z',
        predicted_pdf_url: 'https://ptxprint-mcp.example.com/r2/outputs/uncached/p.pdf',
        cached: false,
        payload_hash: 'hash-uncached',
      }),
      metadata: undefined,
      responseTimeMs: 5,
    });
    // First poll: still running
    callMCPToolMock.mockResolvedValueOnce({
      result: JSON.stringify({ state: 'running' }),
      metadata: undefined,
      responseTimeMs: 5,
    });
    // Second poll: succeeded with pdf_url
    callMCPToolMock.mockResolvedValueOnce({
      result: JSON.stringify({
        state: 'succeeded',
        pdf_url: 'https://ptxprint-mcp.example.com/r2/outputs/uncached/p.pdf',
      }),
      metadata: undefined,
      responseTimeMs: 5,
    });

    const ctx = buildCtx();
    // Use a tiny poll interval so the test runs fast.
    // We can't pass it through the public macro signature, so we monkey-patch
    // setTimeout to fire immediately.
    vi.useFakeTimers();
    const promise = handleGenerateScripturePdf({ translation: 'en_ult', book: 'JHN' }, ctx);
    // Drain timers until the promise resolves.
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.status).toBe('succeeded');
    expect((result as { cached: boolean }).cached).toBe(false);
    // submit + 2 polls = 3 calls
    expect(callMCPToolMock).toHaveBeenCalledTimes(3);
  });
});

function callMacro(ctx: PtxprintToolContext, translation = 'en_ult', book = 'JHN') {
  return handleGenerateScripturePdf({ translation, book }, ctx);
}

describe('handleGenerateScripturePdf — config errors', () => {
  it('refuses when ptxprint-mcp is not in the catalog', async () => {
    const result = await callMacro(buildCtx(buildCatalog([])));
    expect(result.status).toBe('error');
    expect((result as { cause: string }).cause).toBe('server_not_registered');
    expect(callMCPToolMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported translation before any I/O', async () => {
    const result = await callMacro(buildCtx(), 'en_kjv');
    expect(result.status).toBe('error');
    expect((result as { cause: string }).cause).toBe('unsupported_translation');
    expect(callMCPToolMock).not.toHaveBeenCalled();
  });
});

describe('handleGenerateScripturePdf — runtime errors', () => {
  it('returns error when DCS fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    );
    const result = await callMacro(buildCtx());
    expect(result.status).toBe('error');
    expect((result as { cause: string }).cause).toBe('fetch_failed');
  });

  it('returns failed when polling resolves to terminal failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(FAKE_USFM, { status: 200 }))
    );
    callMCPToolMock.mockResolvedValueOnce({
      result: JSON.stringify({
        job_id: 'job-fail',
        submitted_at: '2026-04-29T00:00:00Z',
        predicted_pdf_url: 'https://ptxprint-mcp.example.com/r2/outputs/fail/p.pdf',
        cached: false,
        payload_hash: 'hash-fail',
      }),
      metadata: undefined,
      responseTimeMs: 5,
    });
    callMCPToolMock.mockResolvedValueOnce({
      result: JSON.stringify({
        state: 'failed',
        failure_mode: 'hard',
        errors: ['xelatex blew up'],
      }),
      metadata: undefined,
      responseTimeMs: 5,
    });
    const result = await callMacro(buildCtx());
    expect(result.status).toBe('failed');
    expect((result as { errors: string[] }).errors).toEqual(['xelatex blew up']);
  });
});
