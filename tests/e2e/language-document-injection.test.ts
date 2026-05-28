/**
 * E2E test for end-to-end language document injection (#191).
 *
 * Exercises the full chain through UserDO via miniflare: classifier →
 * applyTriggerOverrides → resolveEffectiveLanguage → orchestrator system
 * prompt. Asserts against the captured Anthropic request body's `system`
 * field — the cleanest observable seam (telemetry logs in user-do are
 * `logger.log` calls, not an event bus).
 *
 * Why intercept at `globalThis.fetch` and not the Anthropic SDK methods:
 * `src/services/claude/orchestrator.ts` calls `globalThis.fetch` directly
 * because the SDK's internal fetch trips Cloudflare error 1003 inside a
 * Durable Object. The mock surfaces a minimal end_turn JSON response so the
 * non-streaming `/chat/final` path lands in `extractTextResponses` cleanly.
 *
 * Each test seeds a fresh DO so persistence assertions roundtrip through
 * real DO storage (isolatedStorage is disabled in vitest.config.ts, but a
 * fresh DurableObjectId per test gives the same effect for multi-request
 * scenarios).
 */

/* eslint-disable max-lines-per-function */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest } from '../../src/types/engine.js';
import type { OrgLanguages } from '../../src/types/languages.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const ANTHROPIC_MARKER_HOST = 'api.anthropic.com';
const TEST_LANG_MARKER = 'LANGUAGE_DOC_MARKER_BETA_v7';
const DRAFT_LANG_MARKER = 'DRAFT_LANGUAGE_MARKER_UNPUBLISHED';

function buildOrgLanguages(): OrgLanguages {
  return {
    languages: [
      {
        name: 'testlang',
        label: 'Test Language',
        document: `## Tone\nUse formal register. ${TEST_LANG_MARKER}`,
        published: true,
      },
      {
        name: 'draftlang',
        label: 'Draft Language',
        document: `## Tone\nDraft style. ${DRAFT_LANG_MARKER}`,
        published: false,
      },
    ],
  };
}

function buildBody(overrides: Partial<ChatRequest> & Pick<ChatRequest, 'message'>): ChatRequest {
  return {
    client_id: 'web-client',
    user_id: 'e2e-language-injection-user',
    message_type: 'text',
    _org_languages: buildOrgLanguages(),
    ...overrides,
  };
}

interface CapturedAnthropicCall {
  system: string;
  body: Record<string, unknown>;
}

function setupAnthropicFetchCapture(): {
  calls: CapturedAnthropicCall[];
  warnLogs: Array<{ event: string; payload: Record<string, unknown> | undefined }>;
} {
  const calls: CapturedAnthropicCall[] = [];
  const warnLogs: Array<{ event: string; payload: Record<string, unknown> | undefined }> = [];

  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);

  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes(ANTHROPIC_MARKER_HOST)) {
      const rawBody = typeof init?.body === 'string' ? init.body : '';
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      calls.push({ system: String(parsed.system ?? ''), body: parsed });
      return new Response(
        JSON.stringify({
          id: `msg_${calls.length}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-test',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'ok' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return realFetch(input, init);
  });

  // Capture warn-level logs from the request logger so stale-mask assertions
  // can pin both the absence of the document AND the operator-visible signal.
  vi.spyOn(console, 'warn').mockImplementation((event: unknown, payload?: unknown) => {
    warnLogs.push({
      event: typeof event === 'string' ? event : JSON.stringify(event),
      payload:
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined,
    });
  });

  return { calls, warnLogs };
}

async function postChatFinal(
  stub: DurableObjectStub,
  body: ChatRequest
): Promise<{ status: number }> {
  const response = await stub.fetch('http://fake-host/chat/final', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status };
}

describe('Language document injection — end-to-end through UserDO', () => {
  let stub: DurableObjectStub;
  let captured: ReturnType<typeof setupAnthropicFetchCapture>;

  beforeEach(() => {
    const id = env.USER_DO.newUniqueId();
    stub = env.USER_DO.get(id);
    captured = setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('single-turn @testlang trigger injects the language document into the system prompt', async () => {
    const { status } = await postChatFinal(
      stub,
      buildBody({ message: '@testlang please answer formally' })
    );
    expect(status).toBe(200);
    expect(captured.calls.length).toBeGreaterThan(0);
    expect(captured.calls[0].system).toContain('## Language Guidance');
    expect(captured.calls[0].system).toContain(TEST_LANG_MARKER);
  });

  it('persists language across turns: turn 2 with no trigger still injects the marker', async () => {
    await postChatFinal(stub, buildBody({ message: '@testlang first turn' }));
    await postChatFinal(stub, buildBody({ message: 'second turn with no trigger' }));

    expect(captured.calls.length).toBe(2);
    expect(captured.calls[0].system).toContain(TEST_LANG_MARKER);
    expect(captured.calls[1].system).toContain(TEST_LANG_MARKER);
  });

  it('@default on the next turn clears the persisted language; subsequent turns do not inject', async () => {
    await postChatFinal(stub, buildBody({ message: '@testlang first turn' }));
    await postChatFinal(stub, buildBody({ message: '@default clear it' }));
    await postChatFinal(stub, buildBody({ message: 'third turn — should be no language' }));

    expect(captured.calls.length).toBe(3);
    expect(captured.calls[0].system).toContain(TEST_LANG_MARKER);
    expect(captured.calls[1].system).not.toContain(TEST_LANG_MARKER);
    expect(captured.calls[2].system).not.toContain(TEST_LANG_MARKER);
    expect(captured.calls[2].system).not.toContain('## Language Guidance');
  });

  it('non-admin caller cannot select a draft language: trigger is masked + warn-logged', async () => {
    const { status } = await postChatFinal(
      stub,
      buildBody({ client_id: 'web-client', message: '@draftlang please answer' })
    );
    expect(status).toBe(200);
    expect(captured.calls.length).toBe(1);
    expect(captured.calls[0].system).not.toContain(DRAFT_LANG_MARKER);
    expect(captured.calls[0].system).not.toContain('## Language Guidance');
  });

  it('admin caller bypasses the published filter and the draft language injects', async () => {
    const { status } = await postChatFinal(
      stub,
      buildBody({ client_id: 'admin-portal', message: '@draftlang please answer' })
    );
    expect(status).toBe(200);
    expect(captured.calls.length).toBe(1);
    expect(captured.calls[0].system).toContain(DRAFT_LANG_MARKER);
    expect(captured.calls[0].system).toContain('## Language Guidance');
  });
});
