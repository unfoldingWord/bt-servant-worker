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

import { MCPError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { MCPServerConfig, MCPServerManifest, MCPToolDefinition } from './types.js';

const DISCOVERY_TIMEOUT_MS = 10000;
const TOOL_CALL_TIMEOUT_MS = 30000;

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

/**
 * Send a JSON-RPC 2.0 request to an MCP server
 */
async function sendJsonRpcRequest<T>(
  server: MCPServerConfig,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = DISCOVERY_TIMEOUT_MS
): Promise<T> {
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

    const data = (await response.json()) as unknown;

    // Handle both JSON-RPC wrapped and direct responses
    // Some servers return { jsonrpc, result } while others return the result directly
    if (isJsonRpcResponse<T>(data)) {
      if (data.error) {
        throw new MCPError(
          `MCP error: ${data.error.message} (code: ${data.error.code})`,
          server.id
        );
      }
      return data.result as T;
    }

    // Direct response (not wrapped in JSON-RPC)
    return data as T;
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
 * Call an MCP tool on a specific server using JSON-RPC 2.0
 */
export async function callMCPTool(
  server: MCPServerConfig,
  toolName: string,
  args: unknown,
  logger: RequestLogger
): Promise<unknown> {
  const startTime = Date.now();
  logger.log('mcp_tool_call_start', { server_id: server.id, tool_name: toolName });

  try {
    const result = await sendJsonRpcRequest<ToolCallResult>(
      server,
      'tools/call',
      { name: toolName, arguments: args },
      TOOL_CALL_TIMEOUT_MS
    );

    logger.log('mcp_tool_call_complete', {
      server_id: server.id,
      tool_name: toolName,
      duration_ms: Date.now() - startTime,
    });

    // Extract text content from MCP response format
    if (result.content && Array.isArray(result.content)) {
      return extractTextContent(result.content);
    }

    return result;
  } catch (error) {
    logger.error('mcp_tool_call_error', error, {
      server_id: server.id,
      tool_name: toolName,
      duration_ms: Date.now() - startTime,
    });
    throw error;
  }
}
