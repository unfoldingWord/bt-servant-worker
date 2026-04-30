/**
 * MCP server configuration type
 *
 * This is defined here (in src/types/) to avoid circular imports.
 * Both engine.ts and services/mcp/types.ts use this type.
 */
/**
 * MCP transport variant.
 *
 * - `'json-rpc'` (default) — stateless single-shot JSON-RPC over HTTP. What
 *   most servers we run today use (translation-helps, fia, aquifer). Each
 *   request is independent; no session header.
 * - `'streamable-http'` — the MCP "Streamable HTTP" transport with stateful
 *   sessions. Server returns an `Mcp-Session-Id` on `initialize` that the
 *   client must echo on every subsequent request. Responses come back as
 *   `text/event-stream` framing. Required for ptxprint-mcp and any server
 *   built on `agents/mcp` + `@modelcontextprotocol/sdk` that doesn't expose
 *   a stateless mode.
 *
 * When this field is omitted the server is treated as `'json-rpc'` for
 * backward compatibility with everything registered before the field
 * existed.
 */
export type MCPTransport = 'json-rpc' | 'streamable-http';

export interface MCPServerConfig {
  id: string;
  name: string;
  url: string;
  authToken?: string;
  enabled: boolean;
  priority: number;
  allowedTools?: string[];
  transport?: MCPTransport;
}
