import { describe, it, expect } from 'vitest';
import {
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  constantTimeCompare,
  sha256Hex,
} from '../../src/utils/crypto.js';

describe('constantTimeCompare', () => {
  it('should return true for equal strings', () => {
    expect(constantTimeCompare('test', 'test')).toBe(true);
    expect(constantTimeCompare('', '')).toBe(true);
    expect(constantTimeCompare('api-key-123', 'api-key-123')).toBe(true);
  });

  it('should return false for different strings', () => {
    expect(constantTimeCompare('test', 'test2')).toBe(false);
    expect(constantTimeCompare('abc', 'def')).toBe(false);
    expect(constantTimeCompare('api-key-123', 'api-key-124')).toBe(false);
  });

  it('should return false for different length strings', () => {
    expect(constantTimeCompare('short', 'longer')).toBe(false);
    expect(constantTimeCompare('longer', 'short')).toBe(false);
    expect(constantTimeCompare('a', '')).toBe(false);
  });
});

describe('bytesToHex / sha256Hex', () => {
  it('hex-encodes bytes with zero padding', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff');
  });

  it('hashes strings (UTF-8) and bytes identically', async () => {
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(await sha256Hex('abc')).toBe(expected);
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(expected);
  });
});

describe('bytesToBase64 / bytesToBase64Url', () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x10]);

  it('encodes standard base64 with padding', () => {
    expect(bytesToBase64(bytes)).toBe('+/+/ABA=');
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
  });

  it('encodes unpadded base64url', () => {
    expect(bytesToBase64Url(bytes)).toBe('-_-_ABA');
  });

  it('round-trips a large input through atob', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(bytesToBase64(big)), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(big);
  });
});
