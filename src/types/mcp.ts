/**
 * MCP server configuration type
 *
 * This is defined here (in src/types/) to avoid circular imports.
 * Both engine.ts and services/mcp/types.ts use this type.
 */
export interface MCPServerConfig {
  id: string;
  name: string;
  url: string;
  authToken?: string;
  enabled: boolean;
  priority: number;
  allowedTools?: string[];
}
