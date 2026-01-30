/**
 * MCP Server Registry - manages MCP server configurations in DO storage
 *
 * Storage is org-scoped: each organization has its own list of MCP servers.
 * Key format: mcp_servers:${org}
 */

import { DEFAULT_MCP_SERVERS, MCPServerConfig } from './types.js';

/**
 * Build the storage key for an organization's MCP servers
 */
function buildStorageKey(org: string): string {
  return `mcp_servers:${org}`;
}

/**
 * Get MCP servers from Durable Object storage for a specific organization
 */
export async function getMCPServers(
  storage: DurableObjectStorage,
  org: string
): Promise<MCPServerConfig[]> {
  const key = buildStorageKey(org);
  const servers = await storage.get<MCPServerConfig[]>(key);
  return servers ?? DEFAULT_MCP_SERVERS;
}

/**
 * Update MCP servers in Durable Object storage for a specific organization
 */
export async function updateMCPServers(
  storage: DurableObjectStorage,
  org: string,
  servers: MCPServerConfig[]
): Promise<void> {
  const key = buildStorageKey(org);
  await storage.put(key, servers);
}

/**
 * Add a new MCP server for a specific organization
 */
export async function addMCPServer(
  storage: DurableObjectStorage,
  org: string,
  server: MCPServerConfig
): Promise<void> {
  const servers = await getMCPServers(storage, org);
  const existing = servers.findIndex((s) => s.id === server.id);

  if (existing >= 0) {
    // eslint-disable-next-line security/detect-object-injection -- existing is from findIndex
    servers[existing] = server;
  } else {
    servers.push(server);
  }

  await updateMCPServers(storage, org, servers);
}

/**
 * Remove an MCP server by ID for a specific organization
 */
export async function removeMCPServer(
  storage: DurableObjectStorage,
  org: string,
  serverId: string
): Promise<void> {
  const servers = await getMCPServers(storage, org);
  const filtered = servers.filter((s) => s.id !== serverId);
  await updateMCPServers(storage, org, filtered);
}

/**
 * Get only enabled MCP servers for a specific organization, sorted by priority
 */
export async function getEnabledMCPServers(
  storage: DurableObjectStorage,
  org: string
): Promise<MCPServerConfig[]> {
  const servers = await getMCPServers(storage, org);
  return servers.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
}
