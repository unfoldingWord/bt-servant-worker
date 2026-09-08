/**
 * `chat_turn` record shape (#404).
 *
 * `buildChatTurnRecord` is the single source for BOTH the `chat_turn` log
 * payload and the `chat_turns_total` counter labels. These tests pin three
 * things that must stay true independently:
 *
 *   1. The log payload carries `input_language` / `input_language_confidence`
 *      for every client (`"und"` / `null` when detection is null), so the
 *      telemetry half of #353 is recorded uniformly.
 *   2. The per-turn facts #402 added (`turn_id`, mode/language attribution,
 *      model, iterations, token spend) are still on the payload, unchanged.
 *   3. The counter labels are UNCHANGED. Metric label values bound series
 *      cardinality; the detector can emit any of ~20 codes per turn and must
 *      never become a label.
 */
import { describe, it, expect } from 'vitest';
import { buildChatTurnRecord } from '../../../src/durable-objects/user-do.js';
import type { DetectedLanguage } from '../../../src/services/language/index.js';
import type { ChatRequest } from '../../../src/types/engine.js';
import type { ChatTurnText } from '../../../src/services/telemetry/chat-turn-text.js';

const DEFAULT_ORG = 'unfoldingWord';

/** The exact payload keys #402 put on `chat_turn`, which #404 must not disturb. */
const PR_402_PAYLOAD_KEYS = [
  'turn_id',
  'mode',
  'mode_switched_to',
  'language',
  'language_source',
  'model',
  'iterations',
  'exit_reason',
  'stop_reason',
  'mcp_calls_made',
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'billable_input_tokens',
  'duration_ms',
  'had_inbound_voice',
  'had_outbound_voice',
];

function body(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    client_id: 'web',
    user_id: 'u-1',
    message_type: 'text',
    message: 'hello',
    _transport: 'stream',
    ...overrides,
  };
}

/**
 * A `ChatTurnContext` with #402's per-turn facts filled in, so these tests
 * exercise the SAME payload builder production uses rather than a #404-only
 * subset of it.
 */
const TOOL_CALL = {
  name: 'fetch_scripture',
  server_id: 'translation-helps',
  started_at: 1_750_000_000_000,
  duration_ms: 812,
  ok: true,
};

const TEXT: ChatTurnText = {
  user_message: 'What does John 3:16 mean? My pastor Bob asked.',
  assistant_reply: 'John 3:16 says that God loved the world…',
};

function turnContext(inputLanguage: DetectedLanguage | null) {
  return {
    turnId: 'turn-1',
    activeModeName: 'dbs-coach',
    activeLanguageName: 'portuguese',
    languageSource: 'trigger' as const,
    orchestration: {
      model: 'claude-sonnet-4-20250514',
      iterations: 3,
      exitReason: 'done' as const,
      finalStopReason: 'end_turn',
      usage: {
        input_tokens: 120,
        output_tokens: 340,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1500,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        billable_input_tokens: 270,
      },
      mcpCallsMade: 2,
      mode: 'dbs-coach',
      modeSwitchedTo: null,
      toolCalls: [TOOL_CALL],
    },
    durationMs: 4200,
    hadInboundVoice: false,
    hadOutboundVoice: true,
    inputLanguage,
    text: TEXT,
  };
}

describe('buildChatTurnRecord — log payload', () => {
  it.each(['web', 'whatsapp'])(
    'carries input_language and input_language_confidence for client %s',
    (clientId) => {
      const { payload } = buildChatTurnRecord(
        body({ client_id: clientId }),
        'en',
        DEFAULT_ORG,
        turnContext({ code: 'pt', confidence: 0.87 })
      );
      expect(payload).toMatchObject({
        client_id: clientId,
        response_language: 'en',
        input_language: 'pt',
        input_language_confidence: 0.87,
      });
    }
  );

  it('records "und" and a null confidence when detection is null', () => {
    const { payload } = buildChatTurnRecord(body(), 'en', DEFAULT_ORG, turnContext(null));
    expect(payload.input_language).toBe('und');
    expect(payload.input_language_confidence).toBeNull();
  });
});

describe('buildChatTurnRecord — fields that must survive the union', () => {
  it('keeps every per-turn field #402 added', () => {
    const { payload } = buildChatTurnRecord(
      body(),
      'en',
      DEFAULT_ORG,
      turnContext({ code: 'pt', confidence: 0.87 })
    );
    for (const key of PR_402_PAYLOAD_KEYS) {
      expect(payload).toHaveProperty(key);
    }
    expect(payload).toMatchObject({
      turn_id: 'turn-1',
      mode: 'dbs-coach',
      language: 'portuguese',
      language_source: 'trigger',
      model: 'claude-sonnet-4-20250514',
      iterations: 3,
      exit_reason: 'done',
      stop_reason: 'end_turn',
      mcp_calls_made: 2,
      input_tokens: 120,
      output_tokens: 340,
      billable_input_tokens: 270,
      duration_ms: 4200,
      had_inbound_voice: false,
      had_outbound_voice: true,
    });
  });

  it('keeps the pre-existing payload fields intact', () => {
    const { payload } = buildChatTurnRecord(
      body({ org: 'acme', chat_type: 'group', chat_id: 'g-1', _edge_country: 'BR' }),
      'pt',
      DEFAULT_ORG,
      turnContext({ code: 'pt', confidence: 1 })
    );
    expect(payload).toMatchObject({
      user_id: 'u-1',
      org: 'acme',
      client_id: 'web',
      transport: 'stream',
      chat_type: 'group',
      response_language: 'pt',
      input_language: 'pt',
      input_language_confidence: 1,
      user_country: null,
      edge_country: 'BR',
    });
  });
});

describe('buildChatTurnRecord — chat_turns_total labels (cardinality guard)', () => {
  it('reports exactly the labels it did before #404 for a plain web turn', () => {
    const { labels } = buildChatTurnRecord(
      body(),
      'en',
      DEFAULT_ORG,
      turnContext({ code: 'pt', confidence: 0.9 })
    );
    expect(labels).toEqual({ language: 'en', chat_type: 'private', transport: 'stream' });
  });

  it('labels are identical whether or not detection succeeded', () => {
    const detected = buildChatTurnRecord(
      body(),
      'en',
      DEFAULT_ORG,
      turnContext({ code: 'pt', confidence: 0.9 })
    );
    const undetected = buildChatTurnRecord(body(), 'en', DEFAULT_ORG, turnContext(null));
    expect(detected.labels).toEqual(undetected.labels);
  });
});

describe('buildChatTurnRecord — conversation text', () => {
  it('carries both fields verbatim on the payload, and never on the metric labels', () => {
    const { payload, labels } = buildChatTurnRecord(body(), 'en', DEFAULT_ORG, turnContext(null));
    expect(payload.user_message).toBe(TEXT.user_message);
    expect(payload.assistant_reply).toBe(TEXT.assistant_reply);
    expect(Object.keys(labels)).not.toContain('user_message');
    expect(Object.keys(labels)).not.toContain('assistant_reply');
    expect(JSON.stringify(labels)).not.toContain('Bob');
  });
});

describe('buildChatTurnRecord — provenance', () => {
  it('carries the engine version and the tool calls on the payload, never on the labels', () => {
    const { payload, labels } = buildChatTurnRecord(body(), 'en', DEFAULT_ORG, turnContext(null));
    expect(typeof payload.engine_version).toBe('string');
    expect(payload.engine_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(payload.tool_calls).toEqual([TOOL_CALL]);
    expect(Object.keys(labels)).not.toContain('tool_calls');
    expect(Object.keys(labels)).not.toContain('engine_version');
  });
});
