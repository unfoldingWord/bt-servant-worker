/**
 * MCP Tool Discovery - fetches tool definitions from MCP servers
 */

import { MCPError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { MCPServerConfig, MCPServerManifest, MCPToolDefinition } from './types.js';

const DISCOVERY_TIMEOUT_MS = 10000;

function buildHeaders(server: MCPServerConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (server.authToken) {
    headers['Authorization'] = `Bearer ${server.authToken}`;
  }
  return headers;
}

function filterTools(tools: MCPToolDefinition[], allowedTools?: string[]): MCPToolDefinition[] {
  if (!allowedTools || allowedTools.length === 0) {
    return tools;
  }
  const allowedSet = new Set(allowedTools);
  return tools.filter((t) => allowedSet.has(t.name));
}

async function fetchToolList(server: MCPServerConfig): Promise<MCPToolDefinition[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const response = await fetch(`${server.url}/tools/list`, {
      method: 'POST',
      headers: buildHeaders(server),
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new MCPError(
        `MCP server returned ${response.status}: ${response.statusText}`,
        server.id
      );
    }

    const data = (await response.json()) as { tools: MCPToolDefinition[] };
    return data.tools ?? [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Discover tools from a single MCP server
 */
export async function discoverServerTools(
  server: MCPServerConfig,
  logger: RequestLogger
): Promise<MCPServerManifest> {
  const startTime = Date.now();
  logger.log('mcp_discovery_start', { server_id: server.id, server_url: server.url });

  try {
    const rawTools = await fetchToolList(server);
    const tools = filterTools(rawTools, server.allowedTools);

    logger.log('mcp_discovery_complete', {
      server_id: server.id,
      tools_found: tools.length,
      duration_ms: Date.now() - startTime,
    });

    return { serverId: server.id, serverName: server.name, tools };
  } catch (error) {
    logger.error('mcp_discovery_error', error, {
      server_id: server.id,
      server_url: server.url,
      duration_ms: Date.now() - startTime,
    });
    return { serverId: server.id, serverName: server.name, tools: [] };
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

function extractTextContent(content: unknown[]): unknown {
  const textContent = content.find(
    (c): c is { type: 'text'; text: string } =>
      typeof c === 'object' && c !== null && 'type' in c && c.type === 'text'
  );
  return textContent ? textContent.text : content;
}

/**
 * Call an MCP tool on a specific server
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
    const response = await fetch(`${server.url}/tools/call`, {
      method: 'POST',
      headers: buildHeaders(server),
      body: JSON.stringify({ name: toolName, arguments: args }),
    });

    if (!response.ok) {
      throw new MCPError(
        `MCP tool call failed with ${response.status}: ${response.statusText}`,
        server.id
      );
    }

    const data = (await response.json()) as { content: unknown[] };
    logger.log('mcp_tool_call_complete', {
      server_id: server.id,
      tool_name: toolName,
      duration_ms: Date.now() - startTime,
    });

    return Array.isArray(data.content) ? extractTextContent(data.content) : data.content;
  } catch (error) {
    logger.error('mcp_tool_call_error', error, {
      server_id: server.id,
      tool_name: toolName,
      duration_ms: Date.now() - startTime,
    });
    throw error;
  }
}
