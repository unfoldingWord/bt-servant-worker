/**
 * MCP Server Registry - legacy DO storage access
 *
 * This module is kept for migration purposes only.
 * MCP server config is now stored in KV and managed by the worker.
 */

import { MCPServerConfig } from './types.js';

/**
 * Build the storage key for an organization's MCP servers
 */
function buildStorageKey(org: string): string {
  return `mcp_servers:${org}`;
}

/**
 * Get MCP servers from Durable Object storage for a specific organization.
 * Returns empty array if org has no servers configured.
 *
 * NOTE: This function is kept for migration purposes only.
 * New code should read from KV (env.MCP_SERVERS).
 */
export async function getMCPServers(
  storage: DurableObjectStorage,
  org: string
): Promise<MCPServerConfig[]> {
  const key = buildStorageKey(org);
  const servers = await storage.get<MCPServerConfig[]>(key);
  return servers ?? [];
}
