/**
 * `chat_turn` record shape (#404).
 *
 * `buildChatTurnRecord` is the single source for BOTH the `chat_turn` log
 * payload and the `chat_turns_total` counter labels. These tests pin three
 * things that must stay true independently:
 *
 *   1. The log payload carries `input_language` / `input_language_confidence`
 *      for EVERY client (`"und"` / `null` when detection is null), so the
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

const DEFAULT_ORG = 'unfoldingWord';

/** The exact label set `chat_turns_total` reported before #404. */
const PRE_404_LABEL_KEYS = ['language', 'chat_type', 'transport', 'user_country', 'edge_country'];

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
    },
    durationMs: 4200,
    hadInboundVoice: false,
    hadOutboundVoice: true,
    inputLanguage,
  };
}

describe('buildChatTurnRecord — log payload', () => {
  it.each(['web', 'whatsapp', 'signal-gateway', 'telegram', 'admin-portal'])(
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
    expect('input_language' in payload).toBe(true);
    expect('input_language_confidence' in payload).toBe(true);
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
  it('never adds the detected language to the metric labels', () => {
    const { labels } = buildChatTurnRecord(
      body({ client_id: 'whatsapp', user_id: 'whatsapp:5511999999999', _edge_country: 'BR' }),
      'en',
      DEFAULT_ORG,
      turnContext({ code: 'pt', confidence: 0.9 })
    );
    for (const key of Object.keys(labels)) {
      expect(PRE_404_LABEL_KEYS).toContain(key);
    }
    expect(labels).not.toHaveProperty('input_language');
    expect(labels).not.toHaveProperty('input_language_confidence');
    expect(JSON.stringify(labels)).not.toContain('input_language');
  });

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
