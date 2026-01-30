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
import { buildToolCatalog, discoverAllTools, getEnabledMCPServers } from '../services/mcp/index.js';
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
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }

  private async handleChat(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
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
      logger.log('do_chat_complete', { response_count: response.responses.length });
      return Response.json(response);
    } catch (error) {
      logger.error('do_chat_error', error);
      if (error instanceof ValidationError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  }

  private async handleStreamingChat(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const body = (await request.json()) as ChatRequest;
    const logger = createRequestLogger(requestId, body.user_id);

    logger.log('do_stream_start', { client_id: body.client_id, message_type: body.message_type });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const sendEvent = async (event: SSEEvent): Promise<void> => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    this.processStreamingChat(body, sendEvent, writer, logger).catch(async (error) => {
      logger.error('do_stream_error', error);
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
    logger: RequestLogger
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
      await sendEvent({ type: 'complete', response });
    } finally {
      await writer.close();
    }
  }

  private async processChat(
    body: ChatRequest,
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse> {
    if (!body.message?.trim()) {
      throw new ValidationError('Message is required');
    }

    const [preferences, history] = await Promise.all([this.getPreferences(), this.getHistory()]);

    const servers = await getEnabledMCPServers(this.state.storage);
    const manifests = await discoverAllTools(servers, logger);
    const catalog = buildToolCatalog(manifests, servers);

    logger.log('mcp_catalog_built', {
      server_count: servers.length,
      tool_count: catalog.tools.length,
    });

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

    await this.addHistoryEntry({
      user_message: body.message,
      assistant_response: responses.join('\n'),
      timestamp: Date.now(),
    });

    if (preferences.first_interaction) {
      await this.updatePreferences({ ...preferences, first_interaction: false });
    }

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
}
