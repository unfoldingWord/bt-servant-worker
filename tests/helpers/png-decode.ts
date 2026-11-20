/**
 * Minimal PNG decoder for the share QR tests (#474). Independent of the
 * encoder under test except for CRC-32 (checked against a known vector in the
 * unit test): it parses chunks, verifies each CRC, inflates the IDAT stream
 * with the runtime's DecompressionStream, and un-filters scanlines (filter
 * types 0-4, so a valid PNG from any encoder decodes).
 */

import jsQR from 'jsqr';
import { crc32, pipeThroughStream } from '../../src/utils/share-qr-png.js';

export interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** Gray value per pixel, row-major: 0 = black, 255 = white. */
  gray: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readChunks(bytes: Uint8Array): Array<{ type: string; data: Uint8Array }> {
  if (!SIGNATURE.every((b, i) => bytes.at(i) === b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Array<{ type: string; data: Uint8Array }> = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const typeAndData = bytes.subarray(offset + 4, offset + 8 + length);
    const type = String.fromCharCode(...typeAndData.subarray(0, 4));
    const crc = view.getUint32(offset + 8 + length);
    if (crc !== crc32(typeAndData)) throw new Error(`bad CRC on ${type}`);
    chunks.push({ type, data: typeAndData.subarray(4) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  if (offset !== bytes.length) throw new Error('trailing bytes after IEND');
  return chunks;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function predictor(filter: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >> 1;
    case 4:
      return paeth(a, b, c);
    default:
      throw new Error(`bad filter ${filter}`);
  }
}

function unfilter(raw: Uint8Array, rowBytes: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rowBytes * height);
  const at = (i: number) => out.at(i) ?? 0;
  for (let y = 0; y < height; y++) {
    const filter = raw.at(y * (rowBytes + 1)) ?? -1;
    for (let x = 0; x < rowBytes; x++) {
      const value = raw.at(y * (rowBytes + 1) + 1 + x) ?? 0;
      const a = x >= bpp ? at(y * rowBytes + x - bpp) : 0;
      const b = y > 0 ? at((y - 1) * rowBytes + x) : 0;
      const c = x >= bpp && y > 0 ? at((y - 1) * rowBytes + x - bpp) : 0;
      out.set([(value + predictor(filter, a, b, c)) & 0xff], y * rowBytes + x);
    }
  }
  return out;
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

function parseHeader(ihdr: { type: string; data: Uint8Array } | undefined): PngHeader {
  if (ihdr?.type !== 'IHDR') throw new Error('IHDR must come first');
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const header = {
    width: view.getUint32(0),
    height: view.getUint32(4),
    bitDepth: view.getUint8(8),
    colorType: view.getUint8(9),
  };
  if (header.colorType !== 0 || (header.bitDepth !== 1 && header.bitDepth !== 8)) {
    throw new Error(`unsupported PNG: colorType ${header.colorType}, bitDepth ${header.bitDepth}`);
  }
  if (view.getUint8(12) !== 0) throw new Error('interlaced PNG not supported');
  return header;
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function toGray(pixels: Uint8Array, header: PngHeader, rowBytes: number): Uint8Array {
  const { width, height, bitDepth } = header;
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v =
        bitDepth === 8
          ? (pixels.at(y * rowBytes + x) ?? 0)
          : ((pixels.at(y * rowBytes + (x >> 3)) ?? 0) >> (7 - (x & 7))) & 1
            ? 255
            : 0;
      gray.set([v], y * width + x);
    }
  }
  return gray;
}

/** Decode a grayscale PNG (bit depth 1 or 8) to one gray byte per pixel. */
export async function decodeGrayPng(bytes: Uint8Array): Promise<DecodedPng> {
  const chunks = readChunks(bytes);
  const header = parseHeader(chunks[0]);
  const idat = concatParts(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = await pipeThroughStream(idat, new DecompressionStream('deflate'));
  const rowBytes = Math.ceil((header.width * header.bitDepth) / 8);
  if (raw.length !== (rowBytes + 1) * header.height) throw new Error('IDAT size mismatch');
  const pixels = unfilter(raw, rowBytes, header.height, 1);
  return { ...header, gray: toGray(pixels, header, rowBytes) };
}

/** Scan a decoded PNG with jsQR (an independent QR decoder); null if unreadable. */
export function scanQr(png: DecodedPng): string | null {
  const rgba = new Uint8ClampedArray(png.width * png.height * 4);
  png.gray.forEach((v, i) => {
    rgba.set([v, v, v, 255], i * 4);
  });
  return jsQR(rgba, png.width, png.height)?.data ?? null;
}
