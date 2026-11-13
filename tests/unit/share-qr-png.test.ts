/**
 * Share QR PNG encoder (#474): the bytes are a valid PNG, every pixel matches
 * the QR module matrix, and an independent QR decoder (jsQR) reads back the
 * exact link.
 */

import { describe, expect, it } from 'vitest';
import {
  crc32,
  encodeQrMatrix,
  renderQrPng,
  renderQrPngForText,
  SHARE_QR_BORDER,
  SHARE_QR_SCALE,
} from '../../src/utils/share-qr-png.js';
import { decodeGrayPng, scanQr } from '../helpers/png-decode.js';

describe('crc32', () => {
  it('matches the standard check value', () => {
    // The CRC-32 "check" value for the ASCII string 123456789.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('encodeQrMatrix', () => {
  it('includes the quiet zone (all-light border)', () => {
    const m = encodeQrMatrix('https://wa.me/15558196461?text=%23spoken');
    const size = m.length;
    for (let i = 0; i < size; i++) {
      for (let b = 0; b < SHARE_QR_BORDER; b++) {
        expect(m.at(b)?.at(i)).toBe(false);
        expect(m.at(size - 1 - b)?.at(i)).toBe(false);
        expect(m.at(i)?.at(b)).toBe(false);
        expect(m.at(i)?.at(size - 1 - b)).toBe(false);
      }
    }
    // The top-left finder pattern starts right after the border.
    expect(m.at(SHARE_QR_BORDER)?.at(SHARE_QR_BORDER)).toBe(true);
  });
});

describe('renderQrPng', () => {
  it('writes a 1-bit grayscale PNG whose pixels match the module matrix', async () => {
    const matrix = encodeQrMatrix('https://wa.me/15558196461?text=%23fia-coach');
    const png = await decodeGrayPng(await renderQrPng(matrix, 3));
    expect(png.bitDepth).toBe(1);
    expect(png.colorType).toBe(0);
    expect(png.width).toBe(matrix.length * 3);
    expect(png.height).toBe(matrix.length * 3);
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const dark = matrix.at(Math.floor(y / 3))?.at(Math.floor(x / 3));
        expect(png.gray.at(y * png.width + x)).toBe(dark ? 0 : 255);
      }
    }
  });

  it('handles a width that is not a multiple of 8 (row padding)', async () => {
    const matrix = [
      [true, false, true],
      [false, true, false],
      [true, true, false],
    ];
    const png = await decodeGrayPng(await renderQrPng(matrix, 1));
    expect(Array.from(png.gray)).toEqual([0, 255, 0, 255, 0, 255, 0, 0, 255]);
  });

  it('rejects an empty or non-square matrix and a bad scale', async () => {
    await expect(renderQrPng([])).rejects.toThrow(/square/);
    await expect(renderQrPng([[true, false]])).rejects.toThrow(/square/);
    await expect(renderQrPng([[true]], 0)).rejects.toThrow(/scale/);
  });
});

describe('renderQrPngForText scans back to the link', () => {
  const links = [
    'https://wa.me/15558196461',
    'https://wa.me/15558196461?text=%23spoken',
    'https://wa.me/15558196461?text=%23wordcollective%2Fbible-study-coach',
  ];
  for (const link of links) {
    it(`encodes ${link}`, async () => {
      const bytes = await renderQrPngForText(link);
      const png = await decodeGrayPng(bytes);
      expect(png.width % SHARE_QR_SCALE).toBe(0);
      expect(scanQr(png)).toBe(link);
      // Small enough for any messaging platform's image limit.
      expect(bytes.length).toBeLessThan(20_000);
    });
  }
});
