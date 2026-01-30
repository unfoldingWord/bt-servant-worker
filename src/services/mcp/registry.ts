/**
 * MCP Server Registry - manages MCP server configurations in DO storage
 */

import { DEFAULT_MCP_SERVERS, MCPServerConfig } from './types.js';

const MCP_SERVERS_KEY = 'mcp_servers';

/**
 * Get MCP servers from Durable Object storage
 */
export async function getMCPServers(storage: DurableObjectStorage): Promise<MCPServerConfig[]> {
  const servers = await storage.get<MCPServerConfig[]>(MCP_SERVERS_KEY);
  return servers ?? DEFAULT_MCP_SERVERS;
}

/**
 * Update MCP servers in Durable Object storage
 */
export async function updateMCPServers(
  storage: DurableObjectStorage,
  servers: MCPServerConfig[]
): Promise<void> {
  await storage.put(MCP_SERVERS_KEY, servers);
}

/**
 * Add a new MCP server
 */
export async function addMCPServer(
  storage: DurableObjectStorage,
  server: MCPServerConfig
): Promise<void> {
  const servers = await getMCPServers(storage);
  const existing = servers.findIndex((s) => s.id === server.id);

  if (existing >= 0) {
    // eslint-disable-next-line security/detect-object-injection -- existing is from findIndex
    servers[existing] = server;
  } else {
    servers.push(server);
  }

  await updateMCPServers(storage, servers);
}

/**
 * Remove an MCP server by ID
 */
export async function removeMCPServer(
  storage: DurableObjectStorage,
  serverId: string
): Promise<void> {
  const servers = await getMCPServers(storage);
  const filtered = servers.filter((s) => s.id !== serverId);
  await updateMCPServers(storage, filtered);
}

/**
 * Get only enabled MCP servers, sorted by priority
 */
export async function getEnabledMCPServers(
  storage: DurableObjectStorage
): Promise<MCPServerConfig[]> {
  const servers = await getMCPServers(storage);
  return servers.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
}
