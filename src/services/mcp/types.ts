/**
 * MCP (Model Context Protocol) types for tool discovery and execution
 */

/**
 * MCP server configuration stored in Durable Object
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

/**
 * JSON Schema for tool parameters
 */
export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  enum?: string[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
}

/**
 * MCP tool definition from server discovery
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * MCP server manifest returned from discovery
 */
export interface MCPServerManifest {
  serverId: string;
  serverName: string;
  tools: MCPToolDefinition[];
}

/**
 * Unified tool catalog combining tools from all MCP servers
 */
export interface ToolCatalog {
  tools: CatalogTool[];
  serverMap: Map<string, MCPServerConfig>;
}

/**
 * Tool in the unified catalog with server attribution
 */
export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  serverId: string;
  serverUrl: string;
}

/**
 * Result of calling an MCP tool
 */
export interface MCPToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * No default MCP servers - each org must explicitly configure their servers.
 * This ensures orgs intentionally set up their MCP infrastructure.
 */
