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
 * Generate compact tool catalog for system prompt (lasker-api pattern)
 *
 * Only includes name + one-liner description to minimize token usage.
 * Claude must call get_tool_definitions to get full schemas before using tools.
 */
export function generateToolCatalog(catalog: ToolCatalog): string {
  if (catalog.tools.length === 0) {
    return 'No MCP tools are currently available.';
  }

  // Build compact markdown table
  const rows = catalog.tools.map((t) => {
    // Truncate description to first sentence or 80 chars
    const firstSentence = t.description.split('.')[0] ?? t.description;
    const summary = firstSentence.slice(0, 80);
    return `| ${t.name} | ${summary} |`;
  });

  return `## Available MCP Tools

The following tools are available for use inside \`execute_code\`.
Before using a tool, call \`get_tool_definitions\` with the tool name(s) to get full documentation.

| Tool | Description |
|------|-------------|
${rows.join('\n')}

### How to use MCP tools:
1. Review the catalog above to identify relevant tools
2. Call \`get_tool_definitions\` with the tool names you need
3. Use the tools in \`execute_code\` based on the returned schemas

Example:
\`\`\`javascript
// First call get_tool_definitions to learn the schema
// Then use the tool in execute_code:
const result = await fetch_scripture({ book: "John", chapter: 3, verse: 16 });
__result__ = result;
\`\`\``;
}

/**
 * @deprecated Use generateToolCatalog instead
 */
export function generateToolDescriptions(catalog: ToolCatalog): string {
  return generateToolCatalog(catalog);
}
