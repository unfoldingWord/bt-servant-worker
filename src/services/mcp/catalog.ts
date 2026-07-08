/**
 * MCP Tool Catalog - builds unified tool catalog from multiple MCP servers
 */

import { RequestLogger } from '../../utils/logger.js';
import { CatalogTool, MCPServerConfig, MCPServerManifest, ToolCatalog } from './types.js';

/**
 * Build a unified tool catalog from multiple MCP server manifests
 *
 * @param manifests - Server manifests from discovery
 * @param servers - Server configurations
 * @param logger - Optional logger for warnings (e.g., name collisions)
 */
export function buildToolCatalog(
  manifests: MCPServerManifest[],
  servers: MCPServerConfig[],
  logger?: RequestLogger
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
        const prefixedName = `${manifest.serverId}_${tool.name}`;
        if (logger) {
          logger.log('mcp_tool_name_collision', {
            original_name: name,
            renamed_to: prefixedName,
            server_id: manifest.serverId,
          });
        }
        name = prefixedName;
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

/** Max length for tool summary in catalog */
const MAX_SUMMARY_LENGTH = 80;

/**
 * Escape markdown special characters to prevent injection
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[|`*_[\]]/g, '\\$&');
}

/**
 * Extract a clean summary from a description
 * - Takes first sentence (ending with period)
 * - Truncates at word boundary if too long
 * - Handles empty/missing descriptions
 */
function extractSummary(description: string | undefined): string {
  if (!description || description.trim().length === 0) {
    return 'No description available';
  }

  // Get first sentence
  const periodIndex = description.indexOf('.');
  const firstSentence = periodIndex > 0 ? description.slice(0, periodIndex) : description;

  // Truncate at word boundary if too long
  if (firstSentence.length <= MAX_SUMMARY_LENGTH) {
    return escapeMarkdown(firstSentence.trim());
  }

  const truncated = firstSentence.slice(0, MAX_SUMMARY_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  const summary = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return escapeMarkdown(summary.trim()) + '...';
}

/**
 * Generate compact tool catalog for system prompt (lasker-api pattern)
 *
 * Only includes name + one-liner description to minimize token usage.
 * Claude must call get_tool_definitions to get full schemas before using tools.
 *
 * Tools are grouped under a per-server `###` heading so the model can tell
 * which resource server each tool belongs to (issue #306). Without server
 * attribution the model treats every tool as one undifferentiated bucket and
 * cannot honor a source-ordered fallback chain (e.g. Translation Helps →
 * Aquifer → training data). Servers appear in first-seen tool order; each
 * server's display name comes from its config (`serverMap`), falling back to
 * the raw server id.
 */
export function generateToolCatalog(catalog: ToolCatalog): string {
  if (catalog.tools.length === 0) {
    return 'No MCP tools are currently available.';
  }

  // Group tool rows by server, preserving first-seen server order.
  const rowsByServer = new Map<string, string[]>();
  for (const t of catalog.tools) {
    const summary = extractSummary(t.description);
    const row = `| ${escapeMarkdown(t.name)} | ${summary} |`;
    const existing = rowsByServer.get(t.serverId);
    if (existing) {
      existing.push(row);
    } else {
      rowsByServer.set(t.serverId, [row]);
    }
  }

  const sections = Array.from(rowsByServer.entries()).map(([serverId, rows]) => {
    const displayName = catalog.serverMap.get(serverId)?.name ?? serverId;
    return `### ${escapeMarkdown(displayName)}

| Tool | Description |
|------|-------------|
${rows.join('\n')}`;
  });

  return `## Available MCP Tools

The following tools are available for use inside \`execute_code\`, grouped by the resource server that provides them.
Before using a tool, call \`get_tool_definitions\` with the tool name(s) to get full documentation.

${sections.join('\n\n')}`;
}
