/**
 * UserSession Durable Object
 *
 * Provides per-user request serialization (only one request per user at a time),
 * chat history storage, MCP server registry, and user preferences.
 *
 * DESIGN NOTE: Request Serialization
 * ----------------------------------
 * The orchestration loop intentionally blocks the Durable Object during processing.
 * This is by design - we want to serialize requests per user to:
 * 1. Prevent race conditions in conversation history
 * 2. Ensure consistent state during multi-turn tool execution
 * 3. Avoid duplicate/conflicting responses to the same user
 *
 * Each user gets their own DO instance, so this only affects concurrent requests
 * from the same user. Different users are processed independently in parallel.
 *
 * Trade-offs:
 * - Long-running orchestrations (10+ tool calls) may take 30+ seconds
 * - Subsequent requests from the same user queue until completion
 * - Streaming provides real-time progress despite blocking
 */

import { Hono } from 'hono';
import { Env } from '../config/types.js';
import { orchestrate } from '../services/claude/index.js';
import {
  addMCPServer,
  buildToolCatalog,
  discoverAllTools,
  getEnabledMCPServers,
  getMCPServers,
  removeMCPServer,
  updateMCPServers,
} from '../services/mcp/index.js';
import { MCPServerConfig } from '../services/mcp/types.js';
import {
  createWebhookCallbacks,
  ProgressCallbackConfig,
  ProgressCallbackSender,
} from '../services/progress/index.js';
import {
  ChatHistoryEntry,
  ChatHistoryResponse,
  ChatRequest,
  ChatResponse,
  SSEEvent,
  StreamCallbacks,
  UpdatePreferencesRequest,
  UserPreferencesAPI,
  UserPreferencesInternal,
} from '../types/engine.js';
import { ValidationError } from '../utils/errors.js';
import { createRequestLogger, RequestLogger } from '../utils/logger.js';

const MAX_HISTORY_ENTRIES = 50;
const HISTORY_KEY = 'history';
const PREFERENCES_KEY = 'preferences';

/** Default rate limiting for admin endpoints (can be overridden via env vars) */
const DEFAULT_ADMIN_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const DEFAULT_ADMIN_RATE_LIMIT_MAX_REQUESTS = 100; // max requests per window

/**
 * Validates ISO 639-1 language code format (2 lowercase letters).
 * Does not validate against the full ISO 639-1 standard, just the format.
 */
const ISO_639_1_PATTERN = /^[a-z]{2}$/;

function isValidLanguageCode(code: string): boolean {
  return ISO_639_1_PATTERN.test(code);
}

const DEFAULT_PREFERENCES: UserPreferencesInternal = {
  response_language: 'en',
  first_interaction: true,
};

export class UserSession {
  private state: DurableObjectState;
  private env: Env;
  private app: Hono;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.app = new Hono();
    this.app.post('/stream', (c) => this.handleStreamingChat(c.req.raw));
    this.app.post('/chat', (c) => this.handleChat(c.req.raw));
    this.app.get('/preferences', () => this.handleGetPreferences());
    this.app.put('/preferences', (c) => this.handleUpdatePreferences(c.req.raw));
    this.app.get('/history', (c) => this.handleGetHistory(new URL(c.req.url)));

    // MCP server management (admin routes)
    this.app.get('/mcp-servers', (c) => this.handleGetMCPServers(new URL(c.req.url)));
    this.app.put('/mcp-servers', (c) => this.handleReplaceMCPServers(c.req.raw));
    this.app.post('/mcp-servers', (c) => this.handleAddMCPServer(c.req.raw));
    this.app.delete('/mcp-servers/:serverId', (c) => {
      const serverId = c.req.param('serverId');
      return this.handleDeleteMCPServer(new URL(c.req.url), serverId);
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }

  private async handleChat(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    const body = (await request.json()) as ChatRequest;
    const logger = createRequestLogger(requestId, body.user_id);

    logger.log('do_chat_start', { client_id: body.client_id, message_type: body.message_type });

    try {
      // Create webhook callbacks if progress_callback_url is provided
      let callbacks: StreamCallbacks | undefined;
      if (body.progress_callback_url && body.message_key) {
        const config: ProgressCallbackConfig = {
          url: body.progress_callback_url,
          user_id: body.user_id,
          message_key: body.message_key,
          token: this.env.ENGINE_API_KEY,
        };
        const sender = new ProgressCallbackSender(config);
        callbacks = createWebhookCallbacks(sender);
      }

      const response = await this.processChat(body, logger, callbacks);
      const totalDuration = Date.now() - startTime;
      logger.log('do_chat_complete', {
        response_count: response.responses.length,
        total_duration_ms: totalDuration,
      });
      logger.log('final_response', {
        responses: response.responses,
        response_language: response.response_language,
      });
      return Response.json(response);
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error('do_chat_error', error, { total_duration_ms: totalDuration });
      if (error instanceof ValidationError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  }

  private async handleStreamingChat(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    const body = (await request.json()) as ChatRequest;
    const logger = createRequestLogger(requestId, body.user_id);

    logger.log('do_stream_start', { client_id: body.client_id, message_type: body.message_type });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Track time to first token
    let firstTokenTime: number | null = null;

    const sendEvent = async (event: SSEEvent): Promise<void> => {
      // Log time to first token on first progress event
      if (event.type === 'progress' && firstTokenTime === null) {
        firstTokenTime = Date.now() - startTime;
        logger.log('stream_first_token', { time_to_first_token_ms: firstTokenTime });
      }
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    this.processStreamingChat(body, sendEvent, writer, logger, startTime).catch(async (error) => {
      const totalDuration = Date.now() - startTime;
      logger.error('do_stream_error', error, { total_duration_ms: totalDuration });
      await sendEvent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      await writer.close();
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  private async handleGetPreferences(): Promise<Response> {
    const prefs = await this.getPreferences();
    const apiPrefs: UserPreferencesAPI = {
      response_language: prefs.response_language,
    };
    return Response.json(apiPrefs);
  }

  private async handleUpdatePreferences(request: Request): Promise<Response> {
    const updates = (await request.json()) as UpdatePreferencesRequest;

    // Validate response_language format (ISO 639-1: 2 lowercase letters)
    if (updates.response_language !== undefined) {
      if (
        typeof updates.response_language !== 'string' ||
        !isValidLanguageCode(updates.response_language)
      ) {
        return Response.json(
          {
            error: 'Invalid response_language',
            message:
              'Must be a valid ISO 639-1 language code (2 lowercase letters, e.g., "en", "es", "fr")',
          },
          { status: 400 }
        );
      }
    }

    const current = await this.getPreferences();

    const updated: UserPreferencesInternal = {
      ...current,
      ...(updates.response_language !== undefined && {
        response_language: updates.response_language,
      }),
    };

    await this.updatePreferences(updated);

    const apiPrefs: UserPreferencesAPI = {
      response_language: updated.response_language,
    };
    return Response.json(apiPrefs);
  }

  private async handleGetHistory(url: URL): Promise<Response> {
    const limit = Math.min(
      parseInt(url.searchParams.get('limit') ?? '50', 10),
      MAX_HISTORY_ENTRIES
    );
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const userId = url.searchParams.get('user_id') ?? '';

    const allHistory = await this.getHistory();
    const total = allHistory.length;
    const entries = allHistory.slice(offset, offset + limit).map((e) => ({
      ...e,
      created_at: e.timestamp ? new Date(e.timestamp).toISOString() : null,
    }));

    const response: ChatHistoryResponse = {
      user_id: userId,
      entries,
      total_count: total,
      limit,
      offset,
    };
    return Response.json(response);
  }

  private async processStreamingChat(
    body: ChatRequest,
    sendEvent: (event: SSEEvent) => Promise<void>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    logger: RequestLogger,
    startTime: number
  ): Promise<void> {
    const callbacks: StreamCallbacks = {
      onStatus: async (message) => sendEvent({ type: 'status', message }),
      onProgress: async (text) => sendEvent({ type: 'progress', text }),
      onComplete: async (response) => sendEvent({ type: 'complete', response }),
      onError: async (error) => sendEvent({ type: 'error', error }),
      onToolUse: async (tool, input) => sendEvent({ type: 'tool_use', tool, input }),
      onToolResult: async (tool, result) => sendEvent({ type: 'tool_result', tool, result }),
    };

    try {
      const response = await this.processChat(body, logger, callbacks);
      const totalDuration = Date.now() - startTime;
      logger.log('do_stream_complete', {
        response_count: response.responses.length,
        total_duration_ms: totalDuration,
      });
      logger.log('final_response', {
        responses: response.responses,
        response_language: response.response_language,
      });
      await sendEvent({ type: 'complete', response });
    } finally {
      await writer.close();
    }
  }

  private async loadUserContext(logger: RequestLogger) {
    const startTime = Date.now();
    const [preferences, history] = await Promise.all([this.getPreferences(), this.getHistory()]);
    logger.log('phase_load_complete', {
      history_count: history.length,
      duration_ms: Date.now() - startTime,
    });
    return { preferences, history };
  }

  private async discoverMCPTools(org: string, logger: RequestLogger) {
    const startTime = Date.now();
    const servers = await getEnabledMCPServers(this.state.storage, org);
    const manifests = await discoverAllTools(servers, logger);
    const catalog = buildToolCatalog(manifests, servers, logger);
    logger.log('mcp_catalog_built', {
      server_count: servers.length,
      tool_count: catalog.tools.length,
      discovery_duration_ms: Date.now() - startTime,
    });
    return catalog;
  }

  private async saveConversation(
    message: string,
    responses: string[],
    preferences: UserPreferencesInternal,
    logger: RequestLogger
  ) {
    const startTime = Date.now();
    await this.addHistoryEntry({
      user_message: message,
      assistant_response: responses.join('\n'),
      timestamp: Date.now(),
    });
    if (preferences.first_interaction) {
      await this.updatePreferences({ ...preferences, first_interaction: false });
    }
    logger.log('phase_save_complete', { duration_ms: Date.now() - startTime });
  }

  private async processChat(
    body: ChatRequest,
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse> {
    if (!body.message?.trim()) {
      throw new ValidationError('Message is required');
    }

    const org = body.org ?? this.env.DEFAULT_ORG;
    const { preferences, history } = await this.loadUserContext(logger);
    const catalog = await this.discoverMCPTools(org, logger);

    const startTime = Date.now();
    const responses = await orchestrate(body.message, {
      env: this.env,
      catalog,
      history,
      preferences: {
        response_language: preferences.response_language,
        first_interaction: preferences.first_interaction,
      },
      logger,
      callbacks,
    });
    logger.log('phase_orchestration_complete', {
      response_count: responses.length,
      duration_ms: Date.now() - startTime,
    });

    await this.saveConversation(body.message, responses, preferences, logger);

    return {
      responses,
      response_language: preferences.response_language,
      voice_audio_base64: null,
    };
  }

  private async getHistory(): Promise<ChatHistoryEntry[]> {
    const history = await this.state.storage.get<ChatHistoryEntry[]>(HISTORY_KEY);
    return history ?? [];
  }

  private async addHistoryEntry(entry: ChatHistoryEntry): Promise<void> {
    const history = await this.getHistory();
    history.push(entry);
    const trimmed = history.slice(-MAX_HISTORY_ENTRIES);
    await this.state.storage.put(HISTORY_KEY, trimmed);
  }

  private async getPreferences(): Promise<UserPreferencesInternal> {
    const prefs = await this.state.storage.get<UserPreferencesInternal>(PREFERENCES_KEY);
    return prefs ?? DEFAULT_PREFERENCES;
  }

  private async updatePreferences(preferences: UserPreferencesInternal): Promise<void> {
    await this.state.storage.put(PREFERENCES_KEY, preferences);
  }

  // ==================== Rate Limiting ====================

  /** Get configured rate limit window (ms) */
  private getRateLimitWindow(): number {
    return this.env.ADMIN_RATE_LIMIT_WINDOW_MS
      ? parseInt(this.env.ADMIN_RATE_LIMIT_WINDOW_MS, 10)
      : DEFAULT_ADMIN_RATE_LIMIT_WINDOW_MS;
  }

  /** Get configured rate limit max requests */
  private getRateLimitMax(): number {
    return this.env.ADMIN_RATE_LIMIT_MAX
      ? parseInt(this.env.ADMIN_RATE_LIMIT_MAX, 10)
      : DEFAULT_ADMIN_RATE_LIMIT_MAX_REQUESTS;
  }

  /**
   * Check rate limit for admin endpoints.
   * Returns null if within limit, or a 429 Response if rate limited.
   */
  private async checkAdminRateLimit(org: string): Promise<Response | null> {
    const key = `rate_limit:admin:${org}`;
    const now = Date.now();
    const windowMs = this.getRateLimitWindow();
    const maxRequests = this.getRateLimitMax();

    const data = await this.state.storage.get<{ count: number; windowStart: number }>(key);

    if (!data || now - data.windowStart > windowMs) {
      // Start new window
      await this.state.storage.put(key, { count: 1, windowStart: now });
      return null;
    }

    if (data.count >= maxRequests) {
      const retryAfter = Math.ceil((data.windowStart + windowMs - now) / 1000);
      return new Response(
        JSON.stringify({
          error: 'Rate limit exceeded',
          retry_after_seconds: retryAfter,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
          },
        }
      );
    }

    // Increment count
    await this.state.storage.put(key, { count: data.count + 1, windowStart: data.windowStart });
    return null;
  }

  // ==================== MCP Server Management ====================

  /** Max length for server ID and name to prevent DoS */
  private static readonly MAX_SERVER_ID_LENGTH = 64;
  private static readonly MAX_SERVER_NAME_LENGTH = 128;
  private static readonly MAX_SERVERS_PER_ORG = 50;
  private static readonly SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

  private validateServerId(id: unknown): string | null {
    if (!id || typeof id !== 'string') return 'Server id is required and must be a string';
    if (id.length > UserSession.MAX_SERVER_ID_LENGTH) {
      return `Server id must be <= ${UserSession.MAX_SERVER_ID_LENGTH} characters`;
    }
    if (!UserSession.SERVER_ID_PATTERN.test(id)) {
      return 'Server id must contain only alphanumeric characters, hyphens, and underscores';
    }
    return null;
  }

  private validateServerUrl(url: unknown): string | null {
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

  private validateServerName(name: unknown): string | null {
    if (name === undefined) return null;
    if (typeof name !== 'string') return 'Server name must be a string';
    if (name.length > UserSession.MAX_SERVER_NAME_LENGTH) {
      return `Server name must be <= ${UserSession.MAX_SERVER_NAME_LENGTH} characters`;
    }
    return null;
  }

  private validateServerPriority(priority: unknown): string | null {
    if (priority === undefined) return null;
    if (typeof priority !== 'number' || priority < 0 || priority > 100) {
      return 'Server priority must be a number between 0 and 100';
    }
    return null;
  }

  private validateAllowedTools(allowedTools: unknown): string | null {
    if (allowedTools === undefined) return null;
    if (!Array.isArray(allowedTools)) return 'allowedTools must be an array of strings';
    if (!allowedTools.every((t) => typeof t === 'string')) {
      return 'allowedTools must contain only strings';
    }
    return null;
  }

  private validateOptionalFields(server: MCPServerConfig): string | null {
    return (
      this.validateServerName(server.name) ||
      this.validateServerPriority(server.priority) ||
      this.validateAllowedTools(server.allowedTools)
    );
  }

  /** Validate MCP server config. Returns error message if invalid, null if valid */
  private validateServerConfig(server: MCPServerConfig): string | null {
    return (
      this.validateServerId(server.id) ||
      this.validateServerUrl(server.url) ||
      this.validateOptionalFields(server)
    );
  }

  private logAdminAction(action: string, org: string, details: Record<string, unknown> = {}): void {
    // Use stderr for admin audit logs (allowed by linter)
    console.error(
      JSON.stringify({ event: 'admin_action', timestamp: Date.now(), action, org, ...details })
    );
  }

  private async handleGetMCPServers(url: URL): Promise<Response> {
    const org = url.searchParams.get('org') ?? this.env.DEFAULT_ORG;
    const discover = url.searchParams.get('discover') === 'true';

    const rateLimited = await this.checkAdminRateLimit(org);
    if (rateLimited) return rateLimited;

    const servers = await getMCPServers(this.state.storage, org);
    this.logAdminAction('list_mcp_servers', org, { server_count: servers.length, discover });

    // If discover=true, run discovery and include status/errors in response
    if (discover && servers.length > 0) {
      const enabledServers = servers.filter((s) => s.enabled);
      const logger = createRequestLogger(crypto.randomUUID());
      const manifests = await discoverAllTools(enabledServers, logger);

      // Build server status map including discovery results
      const serverStatuses = servers.map((server) => {
        const manifest = manifests.find((m) => m.serverId === server.id);
        return {
          ...server,
          discovery_status: manifest ? (manifest.error ? 'error' : 'ok') : 'skipped',
          discovery_error: manifest?.error ?? null,
          tools_count: manifest?.tools.length ?? 0,
        };
      });

      return Response.json({ org, servers: serverStatuses });
    }

    return Response.json({ org, servers });
  }

  private async handleReplaceMCPServers(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const org = url.searchParams.get('org') ?? this.env.DEFAULT_ORG;

    const rateLimited = await this.checkAdminRateLimit(org);
    if (rateLimited) return rateLimited;

    const servers = (await request.json()) as MCPServerConfig[];

    if (!Array.isArray(servers)) {
      return Response.json(
        { error: 'Request body must be an array of server configs' },
        { status: 400 }
      );
    }

    if (servers.length > UserSession.MAX_SERVERS_PER_ORG) {
      return Response.json(
        { error: `Cannot have more than ${UserSession.MAX_SERVERS_PER_ORG} servers per org` },
        { status: 400 }
      );
    }

    for (const server of servers) {
      const error = this.validateServerConfig(server);
      if (error) {
        return Response.json({ error, server_id: server.id }, { status: 400 });
      }
    }

    await updateMCPServers(this.state.storage, org, servers);
    this.logAdminAction('replace_mcp_servers', org, {
      server_count: servers.length,
      server_ids: servers.map((s) => s.id),
    });
    return Response.json({ org, servers, message: 'MCP servers updated' });
  }

  private async handleAddMCPServer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const org = url.searchParams.get('org') ?? this.env.DEFAULT_ORG;

    const rateLimited = await this.checkAdminRateLimit(org);
    if (rateLimited) return rateLimited;

    const body = (await request.json()) as Partial<MCPServerConfig>;
    // Default enabled to true if not specified
    const server: MCPServerConfig = {
      ...body,
      enabled: body.enabled ?? true,
    } as MCPServerConfig;

    const error = this.validateServerConfig(server);
    if (error) {
      return Response.json({ error }, { status: 400 });
    }

    const existing = await getMCPServers(this.state.storage, org);
    if (existing.length >= UserSession.MAX_SERVERS_PER_ORG) {
      return Response.json(
        { error: `Cannot have more than ${UserSession.MAX_SERVERS_PER_ORG} servers per org` },
        { status: 400 }
      );
    }

    await addMCPServer(this.state.storage, org, server);
    const servers = await getMCPServers(this.state.storage, org);
    this.logAdminAction('add_mcp_server', org, { server_id: server.id, server_url: server.url });
    return Response.json({ org, servers, message: 'MCP server added' });
  }

  private async handleDeleteMCPServer(url: URL, serverId: string): Promise<Response> {
    const org = url.searchParams.get('org') ?? this.env.DEFAULT_ORG;

    const rateLimited = await this.checkAdminRateLimit(org);
    if (rateLimited) return rateLimited;

    if (!serverId) {
      return Response.json({ error: 'Server ID is required' }, { status: 400 });
    }

    await removeMCPServer(this.state.storage, org, serverId);
    const servers = await getMCPServers(this.state.storage, org);
    this.logAdminAction('remove_mcp_server', org, { server_id: serverId });
    return Response.json({ org, servers, message: 'MCP server removed' });
  }
}
