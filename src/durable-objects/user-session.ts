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
import { formatTOCForPrompt, JsonMemoryStore } from '../services/memory/index.js';
import { buildToolCatalog, discoverAllTools } from '../services/mcp/index.js';
import { MCPServerConfig } from '../services/mcp/types.js';
import {
  createWebhookCallbacks,
  DEFAULT_PROGRESS_MODE,
  DEFAULT_THROTTLE_SECONDS,
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
import {
  DEFAULT_PROMPT_VALUES,
  ModeContext,
  mergePromptOverrides,
  PROMPT_OVERRIDE_SLOTS,
  PromptMode,
  PromptOverrides,
  resolveActiveModeName,
  resolvePromptOverrides,
  validateModeName,
  validatePromptOverrides,
} from '../types/prompt-overrides.js';
import { transcribeAudio, synthesizeSpeech, AudioContext } from '../services/audio/index.js';
import { AppError, AudioTranscriptionError, ValidationError } from '../utils/errors.js';
import { createRequestLogger, RequestLogger } from '../utils/logger.js';
import { applyTemplateVariables } from '../utils/template.js';
const HISTORY_KEY = 'history';
const PREFERENCES_KEY = 'preferences';
const PROMPT_OVERRIDES_KEY = 'prompt_overrides';
const SELECTED_MODE_KEY = 'selected_mode';
const PROCESSING_LOCK_KEY = '_processing_lock';
const LOCK_STALE_THRESHOLD_MS = 90000; // 90 seconds
const RETRY_AFTER_SECONDS = 5;

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

/** Create a standardized error response */
function createErrorResponse(
  error: string,
  code: string,
  message: string,
  status: number
): Response {
  return Response.json({ error, code, message }, { status });
}

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
    this.app.delete('/history', () => this.handleDeleteHistory());
    this.app.get('/prompt-overrides', () => this.handleGetPromptOverrides());
    this.app.put('/prompt-overrides', (c) => this.handleUpdatePromptOverrides(c.req.raw));
    this.app.delete('/prompt-overrides', () => this.handleDeletePromptOverrides());
    this.app.get('/mode', () => this.handleGetMode());
    this.app.put('/mode', (c) => this.handleSetMode(c.req.raw));
    this.app.delete('/mode', () => this.handleDeleteMode());
    this.app.get('/memory', () => this.handleGetMemory());
    this.app.delete('/memory', () => this.handleDeleteMemory());
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
            event: 'CONCURRENT_REQUEST_REJECTED',
            user_id: userId,
            timestamp: Date.now(),
            note: 'UserQueue should prevent this — kept as defense-in-depth',
          })
        );
        return new Response(
          JSON.stringify({
            error: 'Request in progress',
            code: 'CONCURRENT_REQUEST_REJECTED',
            message: 'Another request for this user is currently being processed. Please retry.',
            retry_after_ms: RETRY_AFTER_SECONDS * 1000,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(RETRY_AFTER_SECONDS),
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

  /** Build webhook callbacks from request body fields, if present. */
  private buildWebhookCallbacks(body: ChatRequest): StreamCallbacks | undefined {
    if (!body.progress_callback_url || !body.message_key) return undefined;

    const sender = new ProgressCallbackSender({
      url: body.progress_callback_url,
      user_id: body.user_id,
      message_key: body.message_key,
      token: this.env.ENGINE_API_KEY,
    });
    const throttleSeconds =
      typeof body.progress_throttle_seconds === 'number' && body.progress_throttle_seconds > 0
        ? body.progress_throttle_seconds
        : DEFAULT_THROTTLE_SECONDS;
    return createWebhookCallbacks(sender, {
      mode: body.progress_mode ?? DEFAULT_PROGRESS_MODE,
      throttleSeconds,
    });
  }

  private async handleChat(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    const body = (await request.json()) as ChatRequest;
    const logger = createRequestLogger(requestId, body.user_id);

    logger.log('do_chat_start', { client_id: body.client_id, message_type: body.message_type });

    const callbacks = this.buildWebhookCallbacks(body);
    try {
      const response = await this.processChat(body, logger, callbacks);

      // Send complete callback for webhook-based clients (e.g., WhatsApp gateway)
      await callbacks?.onComplete?.(response);

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
      // Send error callback for webhook-based clients
      await callbacks?.onError?.(error instanceof Error ? error.message : 'Unknown error');

      const totalDuration = Date.now() - startTime;
      logger.error('do_chat_error', error, { total_duration_ms: totalDuration });
      if (error instanceof AppError) {
        return createErrorResponse(error.name, error.code, error.message, error.statusCode);
      }
      const msg = 'An unexpected error occurred while processing your request.';
      return createErrorResponse('Internal server error', 'INTERNAL_ERROR', msg, 500);
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

  private async resolvePrompts(body: ChatRequest, logger: RequestLogger) {
    const orgOverrides = body._org_prompt_overrides ?? {};
    const orgModes = body._org_modes ?? { modes: [] };
    const userSelectedMode = await this.getSelectedMode();
    const activeModeName = resolveActiveModeName(userSelectedMode);

    // Look up the active mode's overrides
    let modeOverrides: PromptOverrides = {};
    if (activeModeName) {
      const mode = orgModes.modes.find((m) => m.name === activeModeName);
      if (mode) {
        modeOverrides = mode.overrides;
      } else {
        logger.warn('mode_not_found', {
          active_mode: activeModeName,
          available_modes: orgModes.modes.map((m) => m.name),
        });
      }
    }

    const userOverrides = await this.getPromptOverrides();
    const resolved = applyTemplateVariables(
      resolvePromptOverrides(orgOverrides, modeOverrides, userOverrides)
    );

    const overriddenSlots = PROMPT_OVERRIDE_SLOTS.filter(
      // eslint-disable-next-line security/detect-object-injection -- s is from PROMPT_OVERRIDE_SLOTS constant
      (s) => resolved[s] !== DEFAULT_PROMPT_VALUES[s]
    );
    if (overriddenSlots.length > 0) {
      logger.log('prompt_overrides_applied', {
        org_overrides: Object.keys(orgOverrides).length,
        mode_overrides: Object.keys(modeOverrides).length,
        active_mode: activeModeName ?? null,
        user_overrides: Object.keys(userOverrides).length,
        overridden_slots: overriddenSlots,
      });
    }
    return { resolved, orgModes, activeModeName };
  }

  private async loadMemoryContext(logger: RequestLogger) {
    const memoryStore = new JsonMemoryStore(this.state.storage, logger);
    const memoryTOC = await memoryStore.getTableOfContents();
    const formattedTOC = formatTOCForPrompt(memoryTOC);
    return { memoryStore, formattedTOC: formattedTOC || undefined };
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

  /**
   * Resolve message text from request body, transcribing audio if needed.
   */
  private async resolveMessageText(
    body: ChatRequest,
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<string> {
    if (body.message_type === 'audio') {
      if (!body.audio_base64 || !body.audio_format) {
        throw new ValidationError(
          'audio_base64 and audio_format are required when message_type is audio'
        );
      }

      await callbacks?.onStatus?.('Transcribing audio...');
      const transcription = await transcribeAudio(
        this.env.AI,
        body.audio_base64,
        body.audio_format,
        logger
      );

      if (!transcription.text) {
        throw new AudioTranscriptionError('Transcription returned empty text');
      }

      logger.log('audio_transcribed', {
        original_format: body.audio_format,
        transcribed_length: transcription.text.length,
        transcription_ms: transcription.duration_ms,
      });
      return transcription.text;
    }

    if (!body.message?.trim()) {
      throw new ValidationError('Message is required');
    }
    return body.message;
  }

  /**
   * Conditionally generate TTS audio based on message type and audio context.
   */
  private async maybeGenerateAudio(
    body: ChatRequest,
    audioContext: AudioContext,
    responses: string[],
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<string | null> {
    const shouldGenerate = body.message_type === 'audio' || audioContext.audioRequested;
    logger.log('audio_decision', {
      message_type: body.message_type,
      audio_requested_by_tool: audioContext.audioRequested,
      should_generate: shouldGenerate,
      has_responses: responses.length > 0,
    });
    if (!shouldGenerate || responses.length === 0) return null;
    const audio = await this.generateVoiceResponse(responses, logger, callbacks);
    logger.log('audio_generation_result', { has_audio: audio !== null });
    return audio;
  }

  /**
   * Generate TTS audio for a response. Non-fatal: returns null on failure.
   */
  private async generateVoiceResponse(
    responses: string[],
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<string | null> {
    try {
      await callbacks?.onStatus?.('Generating audio response...');
      const synthesis = await synthesizeSpeech(this.env.AI, responses.join('\n'), logger);
      logger.log('tts_generated', {
        input_chars: synthesis.input_chars,
        synthesis_ms: synthesis.duration_ms,
      });
      return synthesis.audio_base64;
    } catch (error) {
      logger.error('tts_generation_failed', error);
      return null;
    }
  }

  private async processChat(
    body: ChatRequest,
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse> {
    const messageText = await this.resolveMessageText(body, logger, callbacks);
    const { preferences, history } = await this.loadUserContext(logger);
    const orgConfig = body._org_config ?? {};
    const catalog = await this.discoverMCPTools(body._mcp_servers ?? [], logger);
    const {
      resolved: resolvedPromptValues,
      orgModes,
      activeModeName,
    } = await this.resolvePrompts(body, logger);
    const { memoryStore, formattedTOC } = await this.loadMemoryContext(logger);
    const modeContext = this.buildModeContext(orgModes, activeModeName);
    const audioContext = this.buildAudioContext();
    const responses = await this.runOrchestration(messageText, {
      env: this.env,
      catalog,
      history,
      preferences: {
        response_language: preferences.response_language,
        first_interaction: preferences.first_interaction,
      },
      orgConfig,
      resolvedPromptValues,
      memoryStore,
      memoryTOC: formattedTOC || undefined,
      modeContext,
      audioContext,
      clientId: body.client_id,
      logger,
      callbacks,
    });
    const voiceAudioBase64 = await this.maybeGenerateAudio(
      body,
      audioContext,
      responses,
      logger,
      callbacks
    );
    await this.saveConversation(messageText, responses, preferences, orgConfig, logger);
    return {
      responses,
      response_language: preferences.response_language,
      voice_audio_base64: voiceAudioBase64,
    };
  }

  private async handleGetPromptOverrides(): Promise<Response> {
    try {
      const overrides = await this.getPromptOverrides();
      return Response.json(overrides);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
    }
  }

  private async handleUpdatePromptOverrides(request: Request): Promise<Response> {
    const body = await request.json();
    const error = validatePromptOverrides(body);
    if (error) {
      return Response.json({ error }, { status: 400 });
    }

    try {
      const current = await this.getPromptOverrides();
      const merged = mergePromptOverrides(current, body as PromptOverrides);
      await this.updatePromptOverrides(merged);
      return Response.json(merged);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
    }
  }

  private async handleDeleteHistory(): Promise<Response> {
    try {
      await this.state.storage.delete(HISTORY_KEY);
      return Response.json({ message: 'User history cleared' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
    }
  }

  private async handleDeletePromptOverrides(): Promise<Response> {
    try {
      await this.state.storage.delete(PROMPT_OVERRIDES_KEY);
      return Response.json({ message: 'User prompt overrides cleared' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
    }
  }

  private async handleGetMemory(): Promise<Response> {
    try {
      const logger = createRequestLogger(crypto.randomUUID());
      const store = new JsonMemoryStore(this.state.storage, logger);
      const content = await store.read();
      const toc = await store.getTableOfContents();
      return Response.json({ content, toc });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
    }
  }

  private async handleDeleteMemory(): Promise<Response> {
    try {
      const logger = createRequestLogger(crypto.randomUUID());
      const store = new JsonMemoryStore(this.state.storage, logger);
      await store.clear();
      return Response.json({ message: 'User memory cleared' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
    }
  }

  // ─── Mode selection handlers ──────────────────────────────────────────────────

  private async handleGetMode(): Promise<Response> {
    const mode = await this.getSelectedMode();
    return Response.json({ mode: mode ?? null });
  }

  // NOTE: This handler validates name format but cannot verify that the mode exists in the org's
  // mode list, because the DO does not have access to KV. Mode existence is validated at two other
  // points: (1) the switch_mode tool checks availableModes before persisting, and (2) prompt
  // resolution gracefully ignores unknown modes (falls through to no mode).
  private async handleSetMode(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const nameError = validateModeName(body.mode);
    if (nameError) {
      return Response.json({ error: nameError }, { status: 400 });
    }
    await this.state.storage.put(SELECTED_MODE_KEY, body.mode as string);
    return Response.json({ mode: body.mode, message: 'User mode updated' });
  }

  private async handleDeleteMode(): Promise<Response> {
    await this.state.storage.delete(SELECTED_MODE_KEY);
    return Response.json({ mode: null, message: 'User mode cleared' });
  }

  /** Run orchestration and log duration */
  private async runOrchestration(
    messageText: string,
    options: Parameters<typeof orchestrate>[1]
  ): Promise<string[]> {
    const startTime = Date.now();
    const responses = await orchestrate(messageText, options);
    options.logger.log('phase_orchestration_complete', {
      response_count: responses.length,
      duration_ms: Date.now() - startTime,
    });
    return responses;
  }

  private buildAudioContext(): AudioContext {
    const ctx: AudioContext = {
      audioRequested: false,
      requestAudio: () => {
        ctx.audioRequested = true;
      },
    };
    return ctx;
  }

  private buildModeContext(
    orgModes: { modes: PromptMode[] },
    activeModeName: string | undefined
  ): ModeContext {
    return {
      availableModes: orgModes.modes,
      activeModeName,
      setSelectedMode: async (name: string | null) => {
        if (name === null) {
          await this.state.storage.delete(SELECTED_MODE_KEY);
        } else {
          await this.state.storage.put(SELECTED_MODE_KEY, name);
        }
      },
    };
  }

  private async getSelectedMode(): Promise<string | undefined> {
    return this.state.storage.get<string>(SELECTED_MODE_KEY);
  }

  // ─── Prompt overrides storage ────────────────────────────────────────────────

  private async getPromptOverrides(): Promise<PromptOverrides> {
    return (await this.state.storage.get<PromptOverrides>(PROMPT_OVERRIDES_KEY)) ?? {};
  }

  private async updatePromptOverrides(overrides: PromptOverrides): Promise<void> {
    await this.state.storage.put(PROMPT_OVERRIDES_KEY, overrides);
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
