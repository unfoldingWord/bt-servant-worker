import { describe, it, expect } from 'vitest';
import { generateAudioKey, audioKeyToUrl } from '../../src/services/audio/r2-storage.js';

describe('generateAudioKey', () => {
  it('produces a key with the expected prefix and extension', () => {
    const key = generateAudioKey('myOrg', 'user-42');
    expect(key).toMatch(/^audio\/myOrg\/user-42\/[0-9a-f-]+\.mp3$/);
  });

  it('generates unique keys on successive calls', () => {
    const a = generateAudioKey('org', 'user');
    const b = generateAudioKey('org', 'user');
    expect(a).not.toBe(b);
  });
});

describe('audioKeyToUrl', () => {
  it('builds a full URL from key and base', () => {
    const url = audioKeyToUrl('audio/org/user/abc.mp3', 'https://worker.example.com');
    expect(url).toBe('https://worker.example.com/api/v1/audio/audio/org/user/abc.mp3');
  });

  it('works with trailing slash on base', () => {
    const url = audioKeyToUrl('audio/org/user/abc.mp3', 'https://worker.example.com');
    expect(url).toContain('/api/v1/audio/');
  });
});
