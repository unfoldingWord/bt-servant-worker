import { describe, expect, it } from 'vitest';
import { enforceResponseSizeLimit } from '../../src/services/mcp/streamable-http-client.js';
import { MCPResponseTooLargeError } from '../../src/utils/errors.js';

const SERVER_ID = 'ptxprint-mcp';

describe('enforceResponseSizeLimit', () => {
  it('passes when string payload is under the cap', () => {
    expect(() => enforceResponseSizeLimit('hello', 1024, SERVER_ID)).not.toThrow();
  });

  it('passes when JSON-serializable payload is under the cap', () => {
    expect(() =>
      enforceResponseSizeLimit({ ok: true, items: [1, 2, 3] }, 1024, SERVER_ID)
    ).not.toThrow();
  });

  it('throws MCPResponseTooLargeError when string payload exceeds the cap', () => {
    const big = 'a'.repeat(2048);
    expect(() => enforceResponseSizeLimit(big, 1024, SERVER_ID)).toThrow(MCPResponseTooLargeError);
  });

  it('throws MCPResponseTooLargeError when serialized object exceeds the cap', () => {
    const big = { blob: 'a'.repeat(2048) };
    expect(() => enforceResponseSizeLimit(big, 1024, SERVER_ID)).toThrow(MCPResponseTooLargeError);
  });

  it('counts bytes (not characters) — multi-byte UTF-8 trips the cap accurately', () => {
    // 3-byte UTF-8 chars * 400 = 1200 bytes, but only 400 chars.
    // String.length would say "400" but byte length is 1200.
    const multibyte = '日'.repeat(400);
    expect(multibyte.length).toBe(400);
    expect(() => enforceResponseSizeLimit(multibyte, 1024, SERVER_ID)).toThrow(
      MCPResponseTooLargeError
    );
  });
});
