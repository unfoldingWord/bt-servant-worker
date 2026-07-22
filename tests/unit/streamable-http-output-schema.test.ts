/**
 * Regression test: discovery against a streamable-HTTP MCP server whose tools
 * declare `outputSchema` must work inside the Workers runtime.
 *
 * The MCP SDK's default JSON-schema validator (Ajv) compiles schemas with
 * `new Function`, which workerd forbids ("Code generation from strings
 * disallowed for this context"). vitest-pool-workers runs workerd with
 * unsafe-eval enabled (vitest needs it), so the production restriction is NOT
 * active here — instead the test stubs the global `Function` constructor to
 * throw the same EvalError workerd raises. Ajv's codegen resolves `Function`
 * from the global scope at compile time, so with the default validator this
 * reproduces the production failure exactly: translation-helps v2 (`/v2/mcp`)
 * declares an `outputSchema` on one tool and discovery died with EvalError
 * until the client was switched to the SDK's CfWorkerJsonSchemaValidator,
 * which validates without code generation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverServerToolsViaSdk } from '../../src/services/mcp/streamable-http-client.js';
import { MCPServerConfig } from '../../src/services/mcp/types.js';
import { createRequestLogger } from '../../src/utils/logger.js';

const logger = createRequestLogger('test-request');

const SERVER: MCPServerConfig = {
  id: 'translation-helps',
  name: 'Translation Helps MCP',
  url: 'https://mock-mcp.example.com/v2/mcp',
  enabled: true,
  priority: 1,
  transport: 'streamable-http',
};

const TOOLS = [
  {
    name: 'list_languages',
    description: 'List language codes available in the catalog.',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string' } },
    },
    // The field that triggers validator compilation in the SDK client.
    outputSchema: {
      type: 'object',
      properties: {
        languages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              name: { type: 'string' },
            },
            required: ['code'],
          },
        },
      },
      required: ['languages'],
    },
  },
  {
    name: 'get_passage',
    description: 'Fetch a scripture passage.',
    inputSchema: { type: 'object', properties: { reference: { type: 'string' } } },
  },
];

/**
 * Minimal streamable-HTTP MCP server as a fetch stub. Handles the SDK
 * client's session lifecycle: POST initialize (returns a session id),
 * POST notifications/initialized (202), POST tools/list, GET SSE stream
 * (405 — allowed by spec), DELETE session teardown.
 */
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'mcp-session-id': 'test-session-1',
};

function respondToRpc(body: { method?: string; id?: number; params?: unknown }): Response {
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
      { status: 200, headers: JSON_HEADERS }
    );
  }
  if (body.method === 'notifications/initialized') {
    return new Response(null, { status: 202, headers: JSON_HEADERS });
  }
  if (body.method === 'tools/list') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32601, message: `unexpected method ${body.method ?? 'unknown'}` },
    }),
    { status: 200, headers: JSON_HEADERS }
  );
}

function installMockMcpServer(): { requests: string[] } {
  const seen = { requests: [] as string[] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === 'GET') {
        seen.requests.push('GET');
        return new Response(null, { status: 405 });
      }
      if (request.method === 'DELETE') {
        seen.requests.push('DELETE');
        return new Response(null, { status: 200 });
      }
      const body = (await request.json()) as { method?: string; id?: number; params?: unknown };
      seen.requests.push(body.method ?? 'unknown');
      return respondToRpc(body);
    })
  );
  return seen;
}

/** Emulate workerd's no-eval restriction (disabled in the test pool). */
function blockCodeGeneration(): void {
  vi.stubGlobal('Function', function bannedFunction(): never {
    throw new EvalError('Code generation from strings disallowed for this context');
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discoverServerToolsViaSdk — tools with outputSchema (workerd eval restriction)', () => {
  it('discovers tools when a tool declares outputSchema, without code generation', async () => {
    const seen = installMockMcpServer();
    blockCodeGeneration();
    const manifest = await discoverServerToolsViaSdk(SERVER, logger);
    expect(seen.requests).toContain('tools/list');
    expect(manifest.error).toBeUndefined();
    expect(manifest.tools.map((t) => t.name)).toEqual(['list_languages', 'get_passage']);
  });
});
