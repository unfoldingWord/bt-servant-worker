import { describe, it, expect, vi } from 'vitest';
import {
  generateAudioKey,
  audioKeyToUrl,
  uploadAudio,
  getAudio,
} from '../../src/services/audio/r2-storage.js';
import type { RequestLogger } from '../../src/utils/logger.js';

function fakeLogger() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as RequestLogger;
}

describe('generateAudioKey', () => {
  it('produces a key with the expected prefix and extension', () => {
    const key = generateAudioKey('myOrg', 'user-42');
    expect(key).toMatch(/^audio\/myOrg\/user-42\/[0-9a-f-]+\.opus$/);
  });

  it('generates unique keys on successive calls', () => {
    const a = generateAudioKey('org', 'user');
    const b = generateAudioKey('org', 'user');
    expect(a).not.toBe(b);
  });
});

describe('audioKeyToUrl', () => {
  it('builds a full URL from key and base', () => {
    const url = audioKeyToUrl('audio/org/user/abc.opus', 'https://worker.example.com');
    expect(url).toBe('https://worker.example.com/api/v1/audio/audio/org/user/abc.opus');
  });

  it('strips trailing slash from base to avoid double-slash', () => {
    const url = audioKeyToUrl('audio/org/user/abc.opus', 'https://worker.example.com/');
    expect(url).toBe('https://worker.example.com/api/v1/audio/audio/org/user/abc.opus');
  });
});

describe('uploadAudio error path', () => {
  it('logs and rethrows when the R2 put fails (no silent swallow)', async () => {
    const logger = fakeLogger();
    const boom = new Error('r2 unavailable');
    const bucket = { put: vi.fn().mockRejectedValue(boom) } as unknown as R2Bucket;

    await expect(
      uploadAudio(bucket, 'audio/o/u/x.opus', new Uint8Array([1, 2, 3]), logger)
    ).rejects.toBe(boom);
    expect(logger.error).toHaveBeenCalledWith(
      'r2_audio_upload_failed',
      boom,
      expect.objectContaining({ key: 'audio/o/u/x.opus', size_bytes: 3 })
    );
  });
});

describe('getAudio error + miss paths', () => {
  it('logs and rethrows when the R2 get fails (no silent swallow)', async () => {
    const logger = fakeLogger();
    const boom = new Error('r2 read failed');
    const bucket = { get: vi.fn().mockRejectedValue(boom) } as unknown as R2Bucket;

    await expect(getAudio(bucket, 'audio/o/u/x.opus', logger)).rejects.toBe(boom);
    expect(logger.error).toHaveBeenCalledWith(
      'r2_audio_get_failed',
      boom,
      expect.objectContaining({ key: 'audio/o/u/x.opus' })
    );
  });

  it('warns and returns null on a miss (does not throw)', async () => {
    const logger = fakeLogger();
    const bucket = { get: vi.fn().mockResolvedValue(null) } as unknown as R2Bucket;

    const result = await getAudio(bucket, 'audio/o/u/x.opus', logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'r2_audio_not_found',
      expect.objectContaining({ key: 'audio/o/u/x.opus' })
    );
  });
});
