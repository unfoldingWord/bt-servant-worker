import { describe, it, expect } from 'vitest';
import {
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  constantTimeCompare,
  hmacSha256,
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

describe('hmacSha256', () => {
  // RFC 4231 test case 2.
  const EXPECTED = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';

  it('matches the RFC 4231 vector, also on a second (cached-key) call', async () => {
    expect(bytesToHex(await hmacSha256('Jefe', 'what do ya want for nothing?'))).toBe(EXPECTED);
    expect(bytesToHex(await hmacSha256('Jefe', 'what do ya want for nothing?'))).toBe(EXPECTED);
  });

  it('keys the cache on the secret: a different secret gives a different MAC', async () => {
    const data = 'what do ya want for nothing?';
    const other = bytesToHex(await hmacSha256('not-Jefe', data));
    expect(other).not.toBe(EXPECTED);
    expect(bytesToHex(await hmacSha256('Jefe', data))).toBe(EXPECTED);
  });

  it('stays correct past the cache bound (cleared and refilled)', async () => {
    for (let i = 0; i < 20; i++) await hmacSha256(`secret-${i}`, 'x');
    expect(bytesToHex(await hmacSha256('Jefe', 'what do ya want for nothing?'))).toBe(EXPECTED);
  });
});
