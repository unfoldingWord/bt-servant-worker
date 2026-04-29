/**
 * Streamable-HTTP MCP transport adapter.
 *
 * Wraps `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`
 * so the rest of the codebase can stay on a single shape. Used only when an
 * `MCPServerConfig` declares `transport: 'streamable-http'` — the default
 * `'json-rpc'` path keeps using the hand-rolled stateless client in
 * `discovery.ts`.
 *
 * Why a separate file: the SDK pulls in zod and a streaming SSE parser, so
 * keeping it isolated lets the bundle still tree-shake when no
 * streamable-HTTP servers are registered.
 *
 * Lifecycle: every public function opens a fresh client, performs ONE call,
 * and closes the client. The streamable-HTTP transport establishes its
 * session inside `client.connect()`, so per-call opens cost an extra
 * `initialize` round-trip — acceptable for v1 (ptxprint jobs are bounded
 * single-digit calls). A future optimization can pool clients per-request.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { MCPError } from '../../utils/errors.js';
import { redactArgsForError, RequestLogger, summarizeArgs } from '../../utils/logger.js';
import {
  CallMCPToolOptions,
  MCPResponseMetadata,
  MCPServerConfig,
  MCPServerManifest,
  MCPToolCallResult,
  MCPToolDefinition,
} from './types.js';
import { recordFailure, recordSuccess } from './health.js';

const CLIENT_INFO = { name: 'bt-servant-worker', version: '1.0.0' };

interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
}

async function openClient(server: MCPServerConfig): Promise<ConnectedClient> {
  const url = new URL(server.url);
  const transportOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
  if (server.authToken) {
    transportOpts.requestInit = {
      headers: { Authorization: `Bearer ${server.authToken}` },
    };
  }
  const transport = new StreamableHTTPClientTransport(url, transportOpts);
  const client = new Client(CLIENT_INFO);
  // The SDK's StreamableHTTPClientTransport types `sessionId` as
  // `string | undefined`, while the consuming `Transport` interface declares
  // it as `string`. Under our `exactOptionalPropertyTypes: true` the two are
  // not assignable. The runtime contract is fine — `connect` accepts the
  // class instance — so we widen here to satisfy the structural check.
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

function normalizeTool(raw: unknown): MCPToolDefinition | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof t.name !== 'string' || typeof t.description !== 'string') return null;
  return {
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema as MCPToolDefinition['inputSchema']) ?? { type: 'object' },
  };
}

export async function discoverServerToolsViaSdk(
  server: MCPServerConfig,
  logger: RequestLogger
): Promise<MCPServerManifest> {
  const startTime = Date.now();
  logger.log('mcp_discovery_start', {
    server_id: server.id,
    server_url: server.url,
    transport: 'streamable-http',
  });
  let opened: ConnectedClient | null = null;
  try {
    opened = await openClient(server);
    const result = await opened.client.listTools();
    const tools = (result.tools ?? [])
      .map((t) => normalizeTool(t))
      .filter((t): t is MCPToolDefinition => t !== null);
    const filtered = applyAllowedTools(tools, server.allowedTools);
    logger.log('mcp_discovery_complete', {
      server_id: server.id,
      transport: 'streamable-http',
      tools_found: filtered.length,
      duration_ms: Date.now() - startTime,
    });
    return { serverId: server.id, serverName: server.name, tools: filtered };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('mcp_discovery_error', error, {
      server_id: server.id,
      server_url: server.url,
      transport: 'streamable-http',
      duration_ms: Date.now() - startTime,
    });
    return { serverId: server.id, serverName: server.name, tools: [], error: errorMessage };
  } finally {
    await closeClientSafe(opened, logger, {
      serverId: server.id,
      event: 'mcp_discovery_close_failed',
    });
  }
}

function applyAllowedTools(tools: MCPToolDefinition[], allowed?: string[]): MCPToolDefinition[] {
  if (!allowed || allowed.length === 0) return tools;
  const set = new Set(allowed);
  return tools.filter((t) => set.has(t.name));
}

interface SdkToolCallContent {
  content?: Array<{ type?: string; text?: string }>;
  _meta?: MCPResponseMetadata;
  isError?: boolean;
}

function extractText(content: Array<{ type?: string; text?: string }>): string {
  const text = content.find((c) => c.type === 'text' && typeof c.text === 'string');
  return text?.text ?? JSON.stringify(content);
}

function extractResult(raw: SdkToolCallContent): unknown {
  if (Array.isArray(raw.content)) {
    return extractText(raw.content);
  }
  return raw;
}

function ensureNoToolError(toolName: string, raw: SdkToolCallContent, serverId: string): void {
  if (raw.isError) {
    throw new MCPError(
      `MCP tool ${toolName} reported isError=true: ${JSON.stringify(raw.content ?? raw)}`,
      serverId
    );
  }
}

function logToolSuccess(
  logger: RequestLogger,
  ctx: { serverId: string; toolName: string; args: unknown; responseTimeMs: number },
  metadata: MCPResponseMetadata | undefined
): void {
  logger.log('mcp_tool_call_complete', {
    server_id: ctx.serverId,
    transport: 'streamable-http',
    tool_name: ctx.toolName,
    args: summarizeArgs(ctx.args),
    duration_ms: ctx.responseTimeMs,
    has_metadata: !!metadata,
    downstream_calls: metadata?.downstream_api_calls,
    cache_status: metadata?.cache_status,
  });
}

async function closeClientSafe(
  opened: ConnectedClient | null,
  logger: RequestLogger,
  ctx: { serverId: string; toolName?: string; event: string }
): Promise<void> {
  if (!opened) return;
  try {
    await opened.close();
  } catch (closeError) {
    logger.warn(ctx.event, {
      server_id: ctx.serverId,
      tool_name: ctx.toolName,
      error: closeError instanceof Error ? closeError.message : String(closeError),
    });
  }
}

function logToolError(
  logger: RequestLogger,
  ctx: { serverId: string; toolName: string; args: unknown; responseTimeMs: number },
  error: unknown
): void {
  logger.error('mcp_tool_call_error', error, {
    server_id: ctx.serverId,
    transport: 'streamable-http',
    tool_name: ctx.toolName,
    args: redactArgsForError(ctx.args),
    duration_ms: ctx.responseTimeMs,
  });
}

export async function callMCPToolViaSdk(
  server: MCPServerConfig,
  toolName: string,
  args: unknown,
  logger: RequestLogger,
  options?: CallMCPToolOptions
): Promise<MCPToolCallResult> {
  const startTime = Date.now();
  logger.log('mcp_tool_call_start', {
    server_id: server.id,
    transport: 'streamable-http',
    tool_name: toolName,
    args: summarizeArgs(args),
  });
  let opened: ConnectedClient | null = null;
  try {
    opened = await openClient(server);
    const raw = (await opened.client.callTool({
      name: toolName,
      arguments: args as Record<string, unknown>,
    })) as SdkToolCallContent;
    const responseTimeMs = Date.now() - startTime;
    ensureNoToolError(toolName, raw, server.id);
    const metadata = raw._meta;
    const extracted = extractResult(raw);
    logToolSuccess(logger, { serverId: server.id, toolName, args, responseTimeMs }, metadata);
    if (options?.healthTracker) {
      recordSuccess(options.healthTracker, server.id, responseTimeMs);
    }
    return { result: extracted, metadata, responseTimeMs };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    logToolError(logger, { serverId: server.id, toolName, args, responseTimeMs }, error);
    if (options?.healthTracker) {
      recordFailure(options.healthTracker, server.id, error as Error);
    }
    throw error;
  } finally {
    await closeClientSafe(opened, logger, {
      serverId: server.id,
      toolName,
      event: 'mcp_tool_call_close_failed',
    });
  }
}
