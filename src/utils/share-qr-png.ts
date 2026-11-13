/**
 * QR code → PNG bytes, inside a Worker (#474).
 *
 * WhatsApp only accepts PNG or JPEG images, and a Worker has no canvas, so the
 * portal's browser-side renderer cannot be reused. This module builds the QR
 * module matrix with `uqr` (pure JS, the same encoder the admin portal uses)
 * and writes a minimal PNG by hand:
 *
 *   - 1-bit grayscale (color type 0, bit depth 1): a dark module is a 0 bit,
 *     a light one a 1 bit. The image is tiny (a few KB).
 *   - every scanline uses filter type 0 (None);
 *   - the IDAT stream is zlib, produced by the runtime's
 *     `CompressionStream('deflate')` (RFC 1950 zlib wrapper, which is exactly
 *     what PNG requires).
 *
 * Pure apart from the compression stream: no env, no I/O, no logging.
 */

import { encode } from 'uqr';

/** Pixels per QR module. A version-4 code (33 modules + border) is ~490px. */
export const SHARE_QR_SCALE = 12;

/**
 * Quiet zone in modules. The QR spec asks for 4; scanners read a white
 * border far more reliably than an image that ends at the finder patterns.
 */
export const SHARE_QR_BORDER = 4;

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode `text` as a QR module matrix, quiet zone included. `true` = dark.
 * Error correction M (15%): a phone photo of a phone screen loses some
 * modules, and the payload (a wa.me link) is short enough that M stays at a
 * low version.
 */
export function encodeQrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: 'M', border: SHARE_QR_BORDER }).data;
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 (ISO 3309 / PNG) over `bytes`. Exported for the decode test. */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (const byte of bytes) c = (table[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value);
}

/** One PNG chunk: length, type, data, CRC(type + data). */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeUint32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeUint32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Run `bytes` through a (de)compression stream and collect the output. */
export async function pipeThroughStream(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const output = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

/** Raw (unfiltered) scanlines: a 0 filter byte, then 1 bit per pixel, MSB first. */
function scanlines(matrix: readonly (readonly boolean[])[], scale: number): Uint8Array {
  const size = matrix.length;
  const width = size * scale;
  const rowBytes = Math.ceil(width / 8);
  const stride = rowBytes + 1;
  const raw = new Uint8Array(stride * width);
  for (let y = 0; y < width; y++) {
    const row = matrix[Math.floor(y / scale)] as readonly boolean[];
    const base = y * stride; // raw[base] stays 0: filter type None
    for (let x = 0; x < width; x++) {
      if (row[Math.floor(x / scale)]) continue; // dark module ⇒ 0 bit
      const index = base + 1 + (x >> 3);
      raw[index] = (raw[index] as number) | (0x80 >> (x & 7));
    }
  }
  return raw;
}

/**
 * Render a square module matrix as a 1-bit grayscale PNG, `scale` pixels per
 * module. Throws on an empty or non-square matrix (a caller bug, not input).
 */
export async function renderQrPng(
  matrix: readonly (readonly boolean[])[],
  scale: number = SHARE_QR_SCALE
): Promise<Uint8Array> {
  const size = matrix.length;
  if (size === 0 || matrix.some((row) => row.length !== size)) {
    throw new Error('renderQrPng: matrix must be square and non-empty');
  }
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error('renderQrPng: scale must be a positive integer');
  }
  const width = size * scale;
  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, width);
  writeUint32(ihdr, 4, width);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // color type: grayscale
  // [10] compression 0, [11] filter 0, [12] interlace 0 (already zero)
  const idat = await pipeThroughStream(scanlines(matrix, scale), new CompressionStream('deflate'));
  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Encode `text` as a QR code and render it as PNG bytes. */
export async function renderQrPngForText(text: string): Promise<Uint8Array> {
  return renderQrPng(encodeQrMatrix(text));
}
