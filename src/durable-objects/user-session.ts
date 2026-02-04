/**
 * UserSession Durable Object
 *
 * Provides per-user request serialization (only one request per user at a time),
 * chat history storage, and user preferences.
 *
 * MCP server configuration is passed in via the request body (from KV in the worker),
 * not stored in the DO anymore.
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
import { buildToolCatalog, discoverAllTools } from '../services/mcp/index.js';
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
import { DEFAULT_ORG_CONFIG, OrgConfig } from '../types/org-config.js';
import { ValidationError } from '../utils/errors.js';
import { createRequestLogger, RequestLogger } from '../utils/logger.js';
const HISTORY_KEY = 'history';
const PREFERENCES_KEY = 'preferences';
const PROCESSING_LOCK_KEY = '_processing_lock';
const LOCK_STALE_THRESHOLD_MS = 90000; // 90 seconds

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
    // Note: /stream is handled directly in fetch() for proper lock management
    this.app.post('/chat', (c) => this.handleChat(c.req.raw));
    this.app.get('/preferences', () => this.handleGetPreferences());
    this.app.put('/preferences', (c) => this.handleUpdatePreferences(c.req.raw));
    this.app.get('/history', (c) => this.handleGetHistory(new URL(c.req.url)));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Only lock chat endpoints (not preferences/history reads)
    if (url.pathname === '/chat' || url.pathname === '/stream') {
      const acquired = await this.tryAcquireLock();
      if (!acquired) {
        const userId = url.searchParams.get('user_id') || 'unknown';
        console.warn(
          JSON.stringify({
            event: 'concurrent_request_rejected',
            user_id: userId,
            timestamp: Date.now(),
          })
        );
        return new Response(
          JSON.stringify({
            error: 'Request in progress',
            code: 'CONCURRENT_REQUEST',
            message: 'Another request for this user is currently being processed. Please retry.',
            retry_after_ms: 5000,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '5',
            },
          }
        );
      }

      // For streaming, lock is released by the streaming handler when complete
      if (url.pathname === '/stream') {
        return this.handleStreamingChatWithLock(request);
      }

      // For non-streaming, release lock when request completes
      try {
        return await this.app.fetch(request);
      } finally {
        await this.releaseLock();
      }
    }

    // Non-chat endpoints don't need locking
    return this.app.fetch(request);
  }

  private async tryAcquireLock(): Promise<boolean> {
    // Use blockConcurrencyWhile to make the check-and-set atomic
    return this.state.blockConcurrencyWhile(async () => {
      const lock = await this.state.storage.get<number>(PROCESSING_LOCK_KEY);
      const now = Date.now();
      if (lock && now - lock < LOCK_STALE_THRESHOLD_MS) {
        return false; // Already processing
      }
      if (lock) {
        // Overwriting a stale lock - log this as it indicates a crash/timeout
        console.warn(
          JSON.stringify({
            event: 'stale_lock_overwritten',
            lock_age_ms: now - lock,
            timestamp: now,
          })
        );
      }
      await this.state.storage.put(PROCESSING_LOCK_KEY, now);
      return true;
    });
  }

  private async releaseLock(): Promise<void> {
    await this.state.storage.delete(PROCESSING_LOCK_KEY);
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

  /**
   * Handle streaming chat with proper lock management.
   * Lock is released when streaming completes, not when Response is returned.
   */
  private async handleStreamingChatWithLock(request: Request): Promise<Response> {
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

    // Process streaming and release lock when done (success or error)
    this.processStreamingChat(body, sendEvent, writer, logger, startTime)
      .catch(async (error) => {
        const totalDuration = Date.now() - startTime;
        logger.error('do_stream_error', error, { total_duration_ms: totalDuration });
        await sendEvent({
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        await writer.close();
      })
      .finally(() => this.releaseLock());

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
    const requestedLimit = parseInt(
      url.searchParams.get('limit') ?? String(DEFAULT_ORG_CONFIG.max_history_storage),
      10
    );
    const limit = Math.min(requestedLimit, DEFAULT_ORG_CONFIG.max_history_storage);
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

  /**
   * Build MCP tool catalog from servers passed via request body.
   * MCP config is now stored in KV and passed from the worker.
   */
  private async discoverMCPTools(mcpServers: MCPServerConfig[], logger: RequestLogger) {
    const startTime = Date.now();
    // Filter to enabled servers and sort by priority
    const servers = mcpServers.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
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
    orgConfig: OrgConfig,
    logger: RequestLogger
  ) {
    const startTime = Date.now();
    const storageMax = orgConfig.max_history_storage ?? DEFAULT_ORG_CONFIG.max_history_storage;
    await this.addHistoryEntry(
      {
        user_message: message,
        assistant_response: responses.join('\n'),
        timestamp: Date.now(),
      },
      storageMax
    );
    if (preferences.first_interaction) {
      await this.updatePreferences({ ...preferences, first_interaction: false });
    }
    logger.log('phase_save_complete', { duration_ms: Date.now() - startTime, storageMax });
  }

  private async processChat(
    body: ChatRequest,
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse> {
    if (!body.message?.trim()) {
      throw new ValidationError('Message is required');
    }

    const { preferences, history } = await this.loadUserContext(logger);
    // Use MCP servers from request body (injected by worker from KV)
    const mcpServers = body._mcp_servers ?? [];
    // Use org config from request body (injected by worker from KV)
    const orgConfig = body._org_config ?? {};
    const catalog = await this.discoverMCPTools(mcpServers, logger);

    const startTime = Date.now();
    const responses = await orchestrate(body.message, {
      env: this.env,
      catalog,
      history,
      preferences: {
        response_language: preferences.response_language,
        first_interaction: preferences.first_interaction,
      },
      orgConfig,
      logger,
      callbacks,
    });
    logger.log('phase_orchestration_complete', {
      response_count: responses.length,
      duration_ms: Date.now() - startTime,
    });

    await this.saveConversation(body.message, responses, preferences, orgConfig, logger);

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

  private async addHistoryEntry(entry: ChatHistoryEntry, maxStorage: number): Promise<void> {
    const history = await this.getHistory();
    history.push(entry);
    const trimmed = history.slice(-maxStorage);
    await this.state.storage.put(HISTORY_KEY, trimmed);
  }

  private async getPreferences(): Promise<UserPreferencesInternal> {
    const prefs = await this.state.storage.get<UserPreferencesInternal>(PREFERENCES_KEY);
    return prefs ?? DEFAULT_PREFERENCES;
  }

  private async updatePreferences(preferences: UserPreferencesInternal): Promise<void> {
    await this.state.storage.put(PREFERENCES_KEY, preferences);
  }
}
