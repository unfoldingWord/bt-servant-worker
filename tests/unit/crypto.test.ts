import { describe, it, expect } from 'vitest';
import { bytesToHex, constantTimeCompare, sha256Hex } from '../../src/utils/crypto.js';

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
