import { describe, it, expect } from 'vitest';
import {
  WA_ME_ORIGIN,
  normalizeWhatsAppNumber,
  modeShareTrigger,
  buildModeShareLink,
} from '../../src/utils/mode-share-link.js';

// Parity target: bt-servant-admin-portal/src/lib/mode-share-link.ts
// `buildModeShareLink` emits `https://wa.me/<digits>?text=%23<slug>`. These
// assertions pin the worker builder to that exact wire format so a welcome the
// worker sends and a link the portal renders are byte-identical (#311).

describe('normalizeWhatsAppNumber', () => {
  it('strips +, spaces, hyphens, dots, and parens from a pasted number', () => {
    expect(normalizeWhatsAppNumber('+1 (555) 819-6461')).toBe('15558196461');
    expect(normalizeWhatsAppNumber('1.555.819.6461')).toBe('15558196461');
  });

  it('accepts an already-clean digit string', () => {
    expect(normalizeWhatsAppNumber('15558196461')).toBe('15558196461');
  });

  it('returns null for empty / nullish input', () => {
    expect(normalizeWhatsAppNumber('')).toBeNull();
    expect(normalizeWhatsAppNumber(null)).toBeNull();
    expect(normalizeWhatsAppNumber(undefined)).toBeNull();
    expect(normalizeWhatsAppNumber('   ')).toBeNull();
  });

  it('rejects a leading zero and out-of-range lengths (E.164 guard)', () => {
    expect(normalizeWhatsAppNumber('0155581964')).toBeNull(); // leading zero
    expect(normalizeWhatsAppNumber('12345')).toBeNull(); // too short
    expect(normalizeWhatsAppNumber('1234567890123456')).toBeNull(); // 16 digits, too long
  });

  it('rejects non-numeric junk', () => {
    expect(normalizeWhatsAppNumber('not-a-number')).toBeNull();
  });
});

describe('modeShareTrigger', () => {
  it('prefixes the slug with the # trigger', () => {
    expect(modeShareTrigger('spoken-mode')).toBe('#spoken-mode');
  });
});

describe('buildModeShareLink', () => {
  it('builds the portal-parity wa.me URL with the %23-encoded trigger', () => {
    expect(buildModeShareLink('15558196461', 'spoken-mode')).toBe(
      'https://wa.me/15558196461?text=%23spoken-mode'
    );
  });

  it('normalizes a messy number before building the URL', () => {
    expect(buildModeShareLink('+1 (555) 819-6461', 'fia-coach')).toBe(
      `${WA_ME_ORIGIN}/15558196461?text=%23fia-coach`
    );
  });

  it('returns null (no crash) when the number is missing or invalid', () => {
    expect(buildModeShareLink(undefined, 'spoken-mode')).toBeNull();
    expect(buildModeShareLink('', 'spoken-mode')).toBeNull();
    expect(buildModeShareLink('012', 'spoken-mode')).toBeNull();
  });

  // #311 FIX 5: a mode whose canonical slug is a reserved clear-token would
  // build wa.me/…?text=%23default — which the recipient's classifier reads as
  // "clear the active mode", so the QR would deactivate rather than select.
  // Mirror the portal builder's `RESERVED_TRIGGERS` and drop the link instead.
  it('returns null for a reserved clear-token slug even with a valid number', () => {
    expect(buildModeShareLink('15558196461', 'default')).toBeNull();
    expect(buildModeShareLink('15558196461', 'none')).toBeNull();
    expect(buildModeShareLink('15558196461', 'clear')).toBeNull();
  });

  it('still builds the link for a non-reserved slug', () => {
    expect(buildModeShareLink('15558196461', 'defaults')).toBe(
      'https://wa.me/15558196461?text=%23defaults'
    );
  });
});
