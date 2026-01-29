import { describe, it, expect } from 'vitest';
import { constantTimeCompare } from '../src/utils/crypto.js';

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
