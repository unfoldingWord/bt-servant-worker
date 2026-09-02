/**
 * MCP Server validation utilities
 *
 * Extracted from user-session.ts for reuse in both worker and DO.
 */

import { MCPServerConfig } from '../services/mcp/types.js';

/** Max length for server ID to prevent DoS */
export const MAX_SERVER_ID_LENGTH = 64;

/** Max length for server name to prevent DoS */
export const MAX_SERVER_NAME_LENGTH = 128;

/**
 * Reserved KV key under which the single global MCP server pool is stored.
 *
 * MCP servers are global by decision (admin-portal#278): the pool is one
 * library shared by every organization, unlike modes/languages which stay
 * per org. The `:org` path parameter on the admin routes is ignored for
 * storage; an org literally named this value is rejected at the route.
 */
export const MCP_GLOBAL_KEY = '__global__';

/** Maximum servers in the global pool */
export const MAX_SERVERS = 50;

/**
 * Reject a request whose `:org` path parameter collides with the reserved
 * global pool key. Org names are unconstrained strings, so the collision has
 * to be checked explicitly.
 * @returns Error message if the org is reserved, null otherwise
 */
export function validateOrgNotReserved(org: string): string | null {
  if (org === MCP_GLOBAL_KEY) {
    return `Org '${MCP_GLOBAL_KEY}' is reserved for the global MCP server pool`;
  }
  return null;
}

/** Pattern for valid server IDs: alphanumeric, hyphens, underscores */
export const SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate server ID format
 * @returns Error message if invalid, null if valid
 */
export function validateServerId(id: unknown): string | null {
  if (!id || typeof id !== 'string') return 'Server id is required and must be a string';
  if (id.length > MAX_SERVER_ID_LENGTH) {
    return `Server id must be <= ${MAX_SERVER_ID_LENGTH} characters`;
  }
  if (!SERVER_ID_PATTERN.test(id)) {
    return 'Server id must contain only alphanumeric characters, hyphens, and underscores';
  }
  return null;
}

/**
 * Validate server URL format
 * @returns Error message if invalid, null if valid
 */
export function validateServerUrl(url: unknown): string | null {
  if (!url || typeof url !== 'string') return 'Server url is required and must be a string';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'Server url must use http or https protocol';
    }
  } catch {
    return 'Server url must be a valid URL';
  }
  return null;
}

/**
 * Validate server name format
 * @returns Error message if invalid, null if valid
 */
export function validateServerName(name: unknown): string | null {
  if (name === undefined) return null;
  if (typeof name !== 'string') return 'Server name must be a string';
  if (name.length > MAX_SERVER_NAME_LENGTH) {
    return `Server name must be <= ${MAX_SERVER_NAME_LENGTH} characters`;
  }
  return null;
}

/**
 * Validate server priority value
 * @returns Error message if invalid, null if valid
 */
export function validateServerPriority(priority: unknown): string | null {
  if (priority === undefined) return null;
  if (typeof priority !== 'number' || priority < 0 || priority > 100) {
    return 'Server priority must be a number between 0 and 100';
  }
  return null;
}

/**
 * Validate allowedTools array
 * @returns Error message if invalid, null if valid
 */
export function validateAllowedTools(allowedTools: unknown): string | null {
  if (allowedTools === undefined) return null;
  if (!Array.isArray(allowedTools)) return 'allowedTools must be an array of strings';
  if (!allowedTools.every((t) => typeof t === 'string')) {
    return 'allowedTools must contain only strings';
  }
  return null;
}

/**
 * Validate optional MCP transport field.
 * @returns Error message if invalid, null if valid
 */
export function validateTransport(transport: unknown): string | null {
  if (transport === undefined) return null;
  if (transport !== 'json-rpc' && transport !== 'streamable-http') {
    return "transport must be 'json-rpc' or 'streamable-http'";
  }
  return null;
}

/**
 * Validate optional MCP server fields
 * @returns Error message if invalid, null if valid
 */
export function validateOptionalFields(server: MCPServerConfig): string | null {
  return (
    validateServerName(server.name) ||
    validateServerPriority(server.priority) ||
    validateAllowedTools(server.allowedTools) ||
    validateTransport(server.transport)
  );
}

/**
 * Validate complete MCP server config
 * @returns Error message if invalid, null if valid
 */
export function validateServerConfig(server: MCPServerConfig): string | null {
  return (
    validateServerId(server.id) || validateServerUrl(server.url) || validateOptionalFields(server)
  );
}
