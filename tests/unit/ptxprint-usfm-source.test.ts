import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDcsUrl,
  buildParatextFilename,
  buildUsfmPublicUrl,
  buildUsfmR2Key,
  isSupportedTranslation,
  resolveUsfmSource,
  UsfmSourceError,
} from '../../src/services/ptxprint/usfm-source.js';
import { createRequestLogger } from '../../src/utils/logger.js';

const logger = createRequestLogger('test-request');

const SAMPLE_USFM = `\\id JHN
\\h John
\\toc1 The Gospel According to John
\\c 1
\\v 1 In the beginning was the Word.
`;

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

describe('isSupportedTranslation', () => {
  it('accepts the four v1 translations', () => {
    expect(isSupportedTranslation('en_ult')).toBe(true);
    expect(isSupportedTranslation('en_ust')).toBe(true);
    expect(isSupportedTranslation('en_t4t')).toBe(true);
    expect(isSupportedTranslation('en_ueb')).toBe(true);
  });

  it('rejects unknown translations', () => {
    expect(isSupportedTranslation('en_kjv')).toBe(false);
    expect(isSupportedTranslation('something')).toBe(false);
    expect(isSupportedTranslation(null)).toBe(false);
    expect(isSupportedTranslation(123)).toBe(false);
  });
});

describe('URL/key builders', () => {
  it('buildDcsUrl uses unfoldingWord/{translation}/raw/branch/master/{N}-{BOOK}.usfm', () => {
    expect(buildDcsUrl('en_ult', 'JHN')).toBe(
      'https://git.door43.org/unfoldingWord/en_ult/raw/branch/master/44-JHN.usfm'
    );
    expect(buildDcsUrl('en_ust', 'GEN')).toBe(
      'https://git.door43.org/unfoldingWord/en_ust/raw/branch/master/01-GEN.usfm'
    );
  });

  it('buildDcsUrl throws on unknown book', () => {
    expect(() => buildDcsUrl('en_ult', 'XYZ')).toThrow(UsfmSourceError);
  });

  it('buildParatextFilename produces canonical 44JHNtest.usfm-style names', () => {
    expect(buildParatextFilename('JHN')).toBe('44JHNtest.usfm');
    expect(buildParatextFilename('GEN')).toBe('01GENtest.usfm');
    expect(buildParatextFilename('REV')).toBe('67REVtest.usfm');
  });

  it('buildUsfmR2Key is content-addressed', () => {
    const key = buildUsfmR2Key('en_ult', 'a'.repeat(64), '44JHNtest.usfm');
    expect(key).toBe(`usfm/en_ult/${'a'.repeat(64)}/44JHNtest.usfm`);
  });

  it('buildUsfmPublicUrl strips trailing slash on baseUrl', () => {
    expect(buildUsfmPublicUrl('https://w.example.com/', 'usfm/en_ult/abc/foo.SFM')).toBe(
      'https://w.example.com/public/ptxprint/usfm/en_ult/abc/foo.SFM'
    );
    expect(buildUsfmPublicUrl('https://w.example.com', 'usfm/en_ult/abc/foo.SFM')).toBe(
      'https://w.example.com/public/ptxprint/usfm/en_ult/abc/foo.SFM'
    );
  });
});

function callResolve() {
  return resolveUsfmSource({
    translation: 'en_ult',
    book: 'JHN',
    bucket: env.PTXPRINT_BUCKET,
    baseUrl: 'https://w.example.com',
    logger,
  });
}

describe('resolveUsfmSource — happy path', () => {
  it('fetches USFM from DCS, hashes, uploads, and returns the public URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(SAMPLE_USFM, { status: 200 }))
    );
    const result = await callResolve();
    expect(result.book).toBe('JHN');
    expect(result.filename).toBe('44JHNtest.usfm');
    expect(result.url).toMatch(
      /^https:\/\/w\.example\.com\/public\/ptxprint\/usfm\/en_ult\/[a-f0-9]{64}\/44JHNtest\.usfm$/
    );
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    const obj = await env.PTXPRINT_BUCKET.get(`usfm/en_ult/${result.sha256}/44JHNtest.usfm`);
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    expect(text).toBe(SAMPLE_USFM);
  });

  it('skips upload on cache hit (idempotent)', async () => {
    const fetchMock = vi.fn(async () => new Response(SAMPLE_USFM, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await callResolve();
    const putSpy = vi.spyOn(env.PTXPRINT_BUCKET, 'put');
    const second = await callResolve();
    expect(second.sha256).toBe(first.sha256);
    expect(second.url).toBe(first.url);
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('resolveUsfmSource — error paths', () => {
  it('throws UsfmSourceError on DCS 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    );
    await expect(callResolve()).rejects.toBeInstanceOf(UsfmSourceError);
  });

  it('throws UsfmSourceError on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      })
    );
    await expect(callResolve()).rejects.toBeInstanceOf(UsfmSourceError);
  });
});
