/**
 * Environment bindings for Cloudflare Worker
 */
export interface Env {
  // Environment variables
  ENVIRONMENT: string;
  MAX_ORCHESTRATION_ITERATIONS: string;
  CODE_EXEC_TIMEOUT_MS: string;
  DEFAULT_ORG: string;

  // Rate limiting (optional - has defaults)
  ADMIN_RATE_LIMIT_MAX?: string;
  ADMIN_RATE_LIMIT_WINDOW_MS?: string;

  // Claude configuration (optional - has defaults)
  CLAUDE_MODEL?: string;
  CLAUDE_MAX_TOKENS?: string;

  // MCP call limits (optional - has defaults)
  MAX_MCP_CALLS_PER_EXECUTION?: string;

  // MCP resilience configuration (optional - has defaults)
  MAX_DOWNSTREAM_CALLS_PER_REQUEST?: string;
  DEFAULT_DOWNSTREAM_PER_MCP_CALL?: string;
  MAX_MCP_RESPONSE_SIZE_BYTES?: string;

  // Secrets (set via wrangler secret put)
  ANTHROPIC_API_KEY: string;
  ENGINE_API_KEY: string;

  // KV Namespaces
  ORG_ADMIN_KEYS: KVNamespace;
  MCP_SERVERS: KVNamespace;
  ORG_CONFIG: KVNamespace;
  PROMPT_OVERRIDES: KVNamespace;

  // Durable Object bindings
  USER_SESSION: DurableObjectNamespace;
}

/**
 * Request context passed through the application
 */
export interface RequestContext {
  requestId: string;
  userId: string;
  clientId: string;
  env: Env;
}
