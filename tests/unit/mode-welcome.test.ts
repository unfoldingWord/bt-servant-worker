import { describe, it, expect } from 'vitest';
import { buildModeWelcomeText, SHARE_LINE_PREFIX } from '../../src/utils/mode-welcome.js';

describe('buildModeWelcomeText', () => {
  it('appends the wa.me share line to the authored copy', () => {
    const text = buildModeWelcomeText('Welcome to Spoken mode!', 'spoken-mode', '15558196461');
    expect(text).toBe(
      `Welcome to Spoken mode!\n\n${SHARE_LINE_PREFIX}https://wa.me/15558196461?text=%23spoken-mode`
    );
  });

  it('contains the exact wa.me link for the mode slug', () => {
    const text = buildModeWelcomeText('Hi', 'fia-coach', '15558196461');
    expect(text).toContain('https://wa.me/15558196461?text=%23fia-coach');
  });

  it('trims surrounding whitespace on the authored copy', () => {
    const text = buildModeWelcomeText('  padded copy  ', 'spoken-mode', '15558196461');
    expect(text.startsWith('padded copy')).toBe(true);
    expect(text).not.toContain('  padded copy');
  });

  it('omits the share line (no crash) when the number is absent', () => {
    const text = buildModeWelcomeText('Welcome!', 'spoken-mode', undefined);
    expect(text).toBe('Welcome!');
    expect(text).not.toContain('wa.me');
  });

  it('omits the share line when the number is invalid', () => {
    const text = buildModeWelcomeText('Welcome!', 'spoken-mode', 'not-a-number');
    expect(text).toBe('Welcome!');
    expect(text).not.toContain(SHARE_LINE_PREFIX);
  });
});
