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

/**
 * Public (response) projection of an MCP server config: the `authToken`
 * secret is never serialised; `hasAuthToken` says whether one is stored.
 * Every admin route that returns stored configs uses this shape
 * (admin-portal#278 guardrail 2 — the pool is shared with every org's admins).
 */
export type MCPServerConfigPublic = Omit<MCPServerConfig, 'authToken'> & {
  hasAuthToken: boolean;
};

/**
 * Write (request body) shape of an MCP server config. Because reads are
 * redacted, a GET → edit → PUT/POST round-trip cannot echo the token back, so
 * `authToken` on write is a three-way field (admin-portal#278 write rule):
 *
 * - key omitted → preserve whatever is stored for that `id`
 * - `null` or `""` → clear the stored token
 * - non-empty string → set it
 */
export type MCPServerWrite = Omit<MCPServerConfig, 'authToken'> & {
  authToken?: string | null;
};
