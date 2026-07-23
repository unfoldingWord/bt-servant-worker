/**
 * Regression tests: MCP tool results with MULTIPLE text content blocks must be
 * fully extracted on both transports.
 *
 * The v2 translation-helps server returns tool results as two text blocks — a
 * short human-readable summary ("23 note(s) for Psalm 23 [kv]") followed by
 * the full payload (~15KB of note bodies). The extraction helpers originally
 * kept only the FIRST text block, silently discarding the payload, so the LLM
 * received bare summary counts (QA report, 2026-07-22). Every earlier server
 * (v1 tc-helps, ptxprint, yaapi) packed its whole result into one block, which
 * is why the bug stayed latent. Extraction must now join ALL text blocks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callMCPTool } from '../../src/services/mcp/discovery.js';
import { MCPServerConfig } from '../../src/services/mcp/types.js';
import { createRequestLogger } from '../../src/utils/logger.js';

const logger = createRequestLogger('test-request');

const SUMMARY_BLOCK = '2 note(s) for Psalm 23:1 [kv]';
const PAYLOAD_BLOCK = JSON.stringify({
  reference: 'Psalm 23:1',
  notes: [{ id: 'glpb', note: 'David is speaking of Yahweh as if he were a **shepherd**.' }],
});

const JSON_RPC_SERVER: MCPServerConfig = {
  id: 'translation-helps',
  name: 'Translation Helps MCP',
  url: 'https://mock-mcp.example.com/api/mcp',
  enabled: true,
  priority: 1,
};

const STREAMABLE_SERVER: MCPServerConfig = {
  ...JSON_RPC_SERVER,
  url: 'https://mock-mcp.example.com/v2/mcp',
  transport: 'streamable-http',
};

type ContentBlock = { type: string; text?: string };

/** Stateless JSON-RPC mock: every tools/call returns the given content. */
function installJsonRpcServer(content: ContentBlock[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = (await new Request(input, init).json()) as { id?: number };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
}

const SESSION_HEADERS = {
  'Content-Type': 'application/json',
  'mcp-session-id': 'test-session-1',
};

function respondToStreamableRpc(
  body: { method?: string; id?: number; params?: unknown },
  content: ContentBlock[]
): Response {
  if (body.method === 'initialize') {
    const params = body.params as { protocolVersion?: string };
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-translation-helps', version: '2.0.0' },
        },
      }),
      { status: 200, headers: SESSION_HEADERS }
    );
  }
  if (body.method === 'notifications/initialized') {
    return new Response(null, { status: 202, headers: SESSION_HEADERS });
  }
  if (body.method === 'tools/call') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content } }), {
      status: 200,
      headers: SESSION_HEADERS,
    });
  }
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32601, message: `unexpected method ${body.method ?? 'unknown'}` },
    }),
    { status: 200, headers: SESSION_HEADERS }
  );
}

/** Streamable-HTTP mock covering the SDK session lifecycle. */
function installStreamableServer(content: ContentBlock[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (request.method === 'DELETE') return new Response(null, { status: 200 });
      const body = (await request.json()) as { method?: string; id?: number; params?: unknown };
      return respondToStreamableRpc(body, content);
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('json-rpc transport — multi-block extraction', () => {
  it('joins all text blocks with a blank line', async () => {
    installJsonRpcServer([
      { type: 'text', text: SUMMARY_BLOCK },
      { type: 'text', text: PAYLOAD_BLOCK },
    ]);
    const { result } = await callMCPTool(JSON_RPC_SERVER, 'get_note', {}, logger);
    expect(result).toBe(`${SUMMARY_BLOCK}\n\n${PAYLOAD_BLOCK}`);
  });

  it('returns a single text block verbatim (ptxprint JSON.parse contract)', async () => {
    installJsonRpcServer([{ type: 'text', text: PAYLOAD_BLOCK }]);
    const { result } = await callMCPTool(JSON_RPC_SERVER, 'get_note', {}, logger);
    expect(result).toBe(PAYLOAD_BLOCK);
    expect(() => JSON.parse(result as string)).not.toThrow();
  });

  it('falls back to JSON.stringify(content) when no text blocks exist', async () => {
    const content = [{ type: 'image', data: 'abc' } as unknown as ContentBlock];
    installJsonRpcServer(content);
    const { result } = await callMCPTool(JSON_RPC_SERVER, 'get_note', {}, logger);
    expect(result).toBe(JSON.stringify(content));
  });
});

describe('streamable-http transport — multi-block extraction', () => {
  it('joins all text blocks with a blank line', async () => {
    installStreamableServer([
      { type: 'text', text: SUMMARY_BLOCK },
      { type: 'text', text: PAYLOAD_BLOCK },
    ]);
    const { result } = await callMCPTool(STREAMABLE_SERVER, 'get_note', {}, logger);
    expect(result).toBe(`${SUMMARY_BLOCK}\n\n${PAYLOAD_BLOCK}`);
  });

  it('returns a single text block verbatim', async () => {
    installStreamableServer([{ type: 'text', text: SUMMARY_BLOCK }]);
    const { result } = await callMCPTool(STREAMABLE_SERVER, 'get_note', {}, logger);
    expect(result).toBe(SUMMARY_BLOCK);
  });
});
