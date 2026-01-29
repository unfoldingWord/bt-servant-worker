/**
 * MCP Tool Catalog - builds unified tool catalog from multiple MCP servers
 */

import { CatalogTool, MCPServerConfig, MCPServerManifest, ToolCatalog } from './types.js';

/**
 * Build a unified tool catalog from multiple MCP server manifests
 */
export function buildToolCatalog(
  manifests: MCPServerManifest[],
  servers: MCPServerConfig[]
): ToolCatalog {
  const serverMap = new Map<string, MCPServerConfig>();
  for (const server of servers) {
    serverMap.set(server.id, server);
  }

  const tools: CatalogTool[] = [];
  const toolNames = new Set<string>();

  for (const manifest of manifests) {
    const server = serverMap.get(manifest.serverId);
    if (!server) continue;

    for (const tool of manifest.tools) {
      // Handle name collisions by prefixing with server ID
      let name = tool.name;
      if (toolNames.has(name)) {
        name = `${manifest.serverId}_${tool.name}`;
      }
      toolNames.add(name);

      tools.push({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        serverId: manifest.serverId,
        serverUrl: server.url,
      });
    }
  }

  return { tools, serverMap };
}

/**
 * Find a tool in the catalog by name
 */
export function findTool(catalog: ToolCatalog, toolName: string): CatalogTool | undefined {
  return catalog.tools.find((t) => t.name === toolName);
}

/**
 * Get all tool names from the catalog
 */
export function getToolNames(catalog: ToolCatalog): string[] {
  return catalog.tools.map((t) => t.name);
}

/**
 * Generate tool descriptions for system prompt
 */
export function generateToolDescriptions(catalog: ToolCatalog): string {
  if (catalog.tools.length === 0) {
    return 'No MCP tools are currently available.';
  }

  const lines = ['Available MCP tools:', ''];

  for (const tool of catalog.tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);

    if (tool.inputSchema.properties && Object.keys(tool.inputSchema.properties).length > 0) {
      const params = Object.entries(tool.inputSchema.properties)
        .map(([key, schema]) => {
          const required = tool.inputSchema.required?.includes(key) ? ' (required)' : '';
          const desc = schema.description ? `: ${schema.description}` : '';
          return `    - ${key}${required}${desc}`;
        })
        .join('\n');
      lines.push(params);
    }
  }

  return lines.join('\n');
}
