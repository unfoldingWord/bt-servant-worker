import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPdfPublicUrl,
  buildPdfR2Key,
  mirrorPdf,
  PdfMirrorError,
} from '../../src/services/ptxprint/pdf-mirror.js';
import { createRequestLogger } from '../../src/utils/logger.js';

const logger = createRequestLogger('test-request');

async function clearBucket() {
  const list = await env.PTXPRINT_BUCKET.list();
  for (const obj of list.objects) {
    await env.PTXPRINT_BUCKET.delete(obj.key);
  }
}

beforeEach(async () => {
  await clearBucket();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PDF key/URL builders', () => {
  it('buildPdfR2Key uses pdfs/{org}/{user}/{job}.pdf', () => {
    expect(buildPdfR2Key('uw', 'user-1', 'jobABC')).toBe('pdfs/uw/user-1/jobABC.pdf');
  });

  it('buildPdfPublicUrl strips trailing slash', () => {
    expect(buildPdfPublicUrl('https://w.example.com/', 'pdfs/x/y/z.pdf')).toBe(
      'https://w.example.com/public/ptxprint/pdfs/x/y/z.pdf'
    );
  });
});

const FAKE_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"

function callMirror(key: string) {
  return mirrorPdf({
    sourceUrl: 'https://ptxprint-mcp.example.com/r2/outputs/abc/foo.pdf',
    key,
    bucket: env.PTXPRINT_BUCKET,
    baseUrl: 'https://w.example.com',
    logger,
  });
}

describe('mirrorPdf — happy path', () => {
  it('fetches the PDF, uploads to R2, and returns our URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(FAKE_PDF, { status: 200 }))
    );
    const result = await callMirror('pdfs/x/y/job1.pdf');
    expect(result.url).toBe('https://w.example.com/public/ptxprint/pdfs/x/y/job1.pdf');
    expect(result.size_bytes).toBe(FAKE_PDF.byteLength);
    const obj = await env.PTXPRINT_BUCKET.get('pdfs/x/y/job1.pdf');
    expect(obj).not.toBeNull();
    expect(obj!.size).toBe(FAKE_PDF.byteLength);
  });

  it('skips fetch+upload on cache hit', async () => {
    await env.PTXPRINT_BUCKET.put('pdfs/x/y/job1.pdf', FAKE_PDF, {
      httpMetadata: { contentType: 'application/pdf' },
    });
    const fetchMock = vi.fn(async () => new Response(FAKE_PDF, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callMirror('pdfs/x/y/job1.pdf');
    expect(result.size_bytes).toBe(FAKE_PDF.byteLength);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('mirrorPdf — error paths', () => {
  it('throws PdfMirrorError on source 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    );
    await expect(callMirror('pdfs/x/y/job-fail.pdf')).rejects.toBeInstanceOf(PdfMirrorError);
  });

  it('throws PdfMirrorError on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('boom');
      })
    );
    await expect(callMirror('pdfs/x/y/job-net.pdf')).rejects.toBeInstanceOf(PdfMirrorError);
  });
});
