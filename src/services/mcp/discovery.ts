/**
 * MCP Tool Discovery - fetches tool definitions from MCP servers
 *
 * Uses JSON-RPC 2.0 protocol for communication with MCP servers.
 * Compatible with servers implementing the MCP Streamable HTTP transport.
 *
 * SECURITY: MCP Server Trust Model
 * ---------------------------------
 * MCP servers are configured by administrators and are implicitly trusted.
 * This module fetches tool definitions and executes tool calls on these servers.
 *
 * Security considerations:
 * 1. Server URLs come from trusted storage (Durable Object), not user input
 * 2. Auth tokens are stored as secrets and passed via Authorization header
 * 3. Tool definitions are included in Claude prompts - malicious definitions
 *    could potentially influence Claude's behavior
 * 4. Tool execution results are returned to Claude - servers could return
 *    malicious content that influences subsequent responses
 *
 * Recommendations for administrators:
 * - Only register MCP servers you control or trust
 * - Use allowedTools to restrict which tools are exposed
 * - Monitor MCP server logs for suspicious activity
 * - Consider network isolation (private endpoints) for sensitive servers
 */

import { MCPError, MCPResponseTooLargeError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { HealthTracker, recordFailure, recordSuccess } from './health.js';
import {
  MCPResponseMetadata,
  MCPServerConfig,
  MCPServerManifest,
  MCPToolDefinition,
} from './types.js';

const DISCOVERY_TIMEOUT_MS = 10000;
const TOOL_CALL_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_SIZE_BYTES = 1048576; // 1MB

/** JSON-RPC 2.0 request structure */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: number;
}

/** JSON-RPC 2.0 response structure */
interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  result?: T;
  error?: { code: number; message: string };
  id: number;
}

/** MCP tools/list response */
interface ToolsListResult {
  tools: MCPToolDefinition[];
}

/** MCP tools/call response */
interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  _meta?: MCPResponseMetadata;
}

/** Type guard for JSON-RPC 2.0 responses */
function isJsonRpcResponse<T>(data: unknown): data is JsonRpcResponse<T> {
  return (
    typeof data === 'object' &&
    data !== null &&
    'jsonrpc' in data &&
    (data as { jsonrpc: unknown }).jsonrpc === '2.0'
  );
}

function buildHeaders(server: MCPServerConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (server.authToken) {
    headers['Authorization'] = `Bearer ${server.authToken}`;
  }
  return headers;
}

interface SendOptions {
  timeoutMs?: number;
  maxResponseSizeBytes?: number;
}

function checkContentLengthHeader(response: Response, maxSize: number, serverId: string): void {
  const contentLength = response.headers.get('Content-Length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxSize) {
      throw new MCPResponseTooLargeError(size, maxSize, serverId);
    }
  }
}

async function readResponseWithSizeLimit(
  response: Response,
  maxSize: number,
  serverId: string
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new MCPError('Failed to read response body', serverId);
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalSize += value.length;
    if (totalSize > maxSize) {
      reader.cancel();
      throw new MCPResponseTooLargeError(totalSize, maxSize, serverId);
    }
    chunks.push(value);
  }

  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('');
}

function parseJsonRpcResponse<T>(data: unknown, serverId: string): T {
  if (isJsonRpcResponse<T>(data)) {
    if (data.error) {
      throw new MCPError(`MCP error: ${data.error.message} (code: ${data.error.code})`, serverId);
    }
    return data.result as T;
  }
  return data as T;
}

/**
 * Send a JSON-RPC 2.0 request to an MCP server
 */
async function sendJsonRpcRequest<T>(
  server: MCPServerConfig,
  method: string,
  params: Record<string, unknown> = {},
  options: SendOptions = {}
): Promise<T> {
  const {
    timeoutMs = DISCOVERY_TIMEOUT_MS,
    maxResponseSizeBytes = DEFAULT_MAX_RESPONSE_SIZE_BYTES,
  } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method,
    params,
    id: Date.now(),
  };

  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: buildHeaders(server),
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new MCPError(
        `MCP server returned ${response.status}: ${response.statusText}`,
        server.id
      );
    }

    checkContentLengthHeader(response, maxResponseSizeBytes, server.id);
    const text = await readResponseWithSizeLimit(response, maxResponseSizeBytes, server.id);
    const data = JSON.parse(text) as unknown;
    return parseJsonRpcResponse<T>(data, server.id);
  } finally {
    clearTimeout(timeoutId);
  }
}

function filterTools(tools: MCPToolDefinition[], allowedTools?: string[]): MCPToolDefinition[] {
  if (!allowedTools || allowedTools.length === 0) {
    return tools;
  }
  const allowedSet = new Set(allowedTools);
  return tools.filter((t) => allowedSet.has(t.name));
}

/**
 * Discover tools from a single MCP server using JSON-RPC 2.0
 */
export async function discoverServerTools(
  server: MCPServerConfig,
  logger: RequestLogger
): Promise<MCPServerManifest> {
  const startTime = Date.now();
  logger.log('mcp_discovery_start', { server_id: server.id, server_url: server.url });

  try {
    const result = await sendJsonRpcRequest<ToolsListResult>(server, 'tools/list');
    const rawTools = result.tools ?? [];
    const tools = filterTools(rawTools, server.allowedTools);

    logger.log('mcp_discovery_complete', {
      server_id: server.id,
      tools_found: tools.length,
      duration_ms: Date.now() - startTime,
    });

    return { serverId: server.id, serverName: server.name, tools };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('mcp_discovery_error', error, {
      server_id: server.id,
      server_url: server.url,
      duration_ms: Date.now() - startTime,
    });
    return {
      serverId: server.id,
      serverName: server.name,
      tools: [],
      error: errorMessage,
    };
  }
}

/**
 * Discover tools from all enabled MCP servers in parallel
 */
export async function discoverAllTools(
  servers: MCPServerConfig[],
  logger: RequestLogger
): Promise<MCPServerManifest[]> {
  const startTime = Date.now();
  logger.log('mcp_discovery_all_start', { server_count: servers.length });

  const manifests = await Promise.all(servers.map((server) => discoverServerTools(server, logger)));

  const totalTools = manifests.reduce((sum, m) => sum + m.tools.length, 0);
  logger.log('mcp_discovery_all_complete', {
    server_count: servers.length,
    total_tools: totalTools,
    duration_ms: Date.now() - startTime,
  });

  return manifests;
}

function extractTextContent(content: Array<{ type: string; text?: string }>): string {
  const textContent = content.find((c) => c.type === 'text' && c.text);
  return textContent?.text ?? JSON.stringify(content);
}

/**
 * Options for MCP tool calls
 */
export interface CallMCPToolOptions {
  healthTracker?: HealthTracker;
  maxResponseSizeBytes?: number;
}

/**
 * Result of an MCP tool call with optional metadata
 */
export interface MCPToolCallResult {
  result: unknown;
  metadata: MCPResponseMetadata | undefined;
  responseTimeMs: number;
}

function buildToolCallSendOptions(options?: CallMCPToolOptions): SendOptions {
  const sendOptions: SendOptions = { timeoutMs: TOOL_CALL_TIMEOUT_MS };
  if (options?.maxResponseSizeBytes !== undefined) {
    sendOptions.maxResponseSizeBytes = options.maxResponseSizeBytes;
  }
  return sendOptions;
}

function logToolCallSuccess(
  logger: RequestLogger,
  serverId: string,
  toolName: string,
  responseTimeMs: number,
  metadata: MCPResponseMetadata | undefined
): void {
  logger.log('mcp_tool_call_complete', {
    server_id: serverId,
    tool_name: toolName,
    duration_ms: responseTimeMs,
    has_metadata: !!metadata,
    downstream_calls: metadata?.downstream_api_calls,
    cache_status: metadata?.cache_status,
  });
}

function extractToolResult(result: ToolCallResult): unknown {
  if (result.content && Array.isArray(result.content)) {
    return extractTextContent(result.content);
  }
  return result;
}

/**
 * Call an MCP tool on a specific server using JSON-RPC 2.0
 */
export async function callMCPTool(
  server: MCPServerConfig,
  toolName: string,
  args: unknown,
  logger: RequestLogger,
  options?: CallMCPToolOptions
): Promise<MCPToolCallResult> {
  const startTime = Date.now();
  logger.log('mcp_tool_call_start', { server_id: server.id, tool_name: toolName });

  try {
    const sendOptions = buildToolCallSendOptions(options);
    const result = await sendJsonRpcRequest<ToolCallResult>(
      server,
      'tools/call',
      { name: toolName, arguments: args },
      sendOptions
    );

    const responseTimeMs = Date.now() - startTime;
    const metadata = result._meta;

    logToolCallSuccess(logger, server.id, toolName, responseTimeMs, metadata);
    if (options?.healthTracker) {
      recordSuccess(options.healthTracker, server.id, responseTimeMs);
    }

    return { result: extractToolResult(result), metadata, responseTimeMs };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    logger.error('mcp_tool_call_error', error, {
      server_id: server.id,
      tool_name: toolName,
      duration_ms: responseTimeMs,
    });
    if (options?.healthTracker) {
      recordFailure(options.healthTracker, server.id, error as Error);
    }
    throw error;
  }
}
