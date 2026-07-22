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

// Read the outbound request body regardless of fetch calling convention: direct
// orchestrator calls pass (url, init) with a string body, but the OTel fetch
// instrumentation (active inside the instrumented DO trace context) normalizes to
// fetch(Request), where the body lives on the Request and `init` is undefined.
async function readMockRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request) return input.clone().text();
  return '';
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
      const rawBody = await readMockRequestBody(input, init);
      const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
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
  // The request logger emits a single JSON-stringified entry per call
  // (src/utils/logger.ts:43), so we parse it back into structured form. A
  // non-JSON call (raw console.warn from somewhere else) is preserved as a
  // free-text event without a payload.
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const raw = args[0];
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const event = typeof parsed.event === 'string' ? parsed.event : raw;
        warnLogs.push({ event, payload: parsed });
        return;
      } catch {
        warnLogs.push({ event: raw, payload: undefined });
        return;
      }
    }
    warnLogs.push({ event: String(raw), payload: undefined });
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

  it('stale-mask: persisted language that has since been unpublished is masked + warn-logged for non-admin', async () => {
    // Turn 1: testlang is published, user persists it via @-trigger.
    await postChatFinal(stub, buildBody({ message: '@testlang first turn' }));
    expect(captured.calls[0].system).toContain(TEST_LANG_MARKER);

    // Turn 2: the curator has since unpublished testlang. The persisted
    // selection in DO storage is intentionally untouched (it may come back if
    // republished), but the resolver must mask the document for non-admin
    // callers AND emit `language_not_found` so operators can see the divergence.
    const stale: OrgLanguages = {
      languages: [
        {
          name: 'testlang',
          label: 'Test Language',
          document: `## Tone\nUse formal register. ${TEST_LANG_MARKER}`,
          published: false,
        },
      ],
    };
    await postChatFinal(
      stub,
      buildBody({ message: 'second turn no trigger', _org_languages: stale })
    );

    expect(captured.calls.length).toBe(2);
    expect(captured.calls[1].system).not.toContain(TEST_LANG_MARKER);
    expect(captured.calls[1].system).not.toContain('## Language Guidance');

    const staleMaskWarn = captured.warnLogs.find(
      (w) =>
        w.event === 'language_not_found' &&
        w.payload?.active_language === 'testlang' &&
        w.payload?.reason === 'unpublished' &&
        w.payload?.source === 'persisted'
    );
    expect(staleMaskWarn).toBeDefined();
  });

  it('admin caller bypasses the published filter and the persisted draft language still injects', async () => {
    // Turn 1: admin persists testlang while it is published.
    await postChatFinal(
      stub,
      buildBody({ client_id: 'admin-portal', message: '@testlang first turn' })
    );
    expect(captured.calls[0].system).toContain(TEST_LANG_MARKER);

    // Turn 2: testlang has been unpublished, but the admin client's
    // includeUnpublished flag flows through so the document still injects.
    const stale: OrgLanguages = {
      languages: [
        {
          name: 'testlang',
          label: 'Test Language',
          document: `## Tone\nUse formal register. ${TEST_LANG_MARKER}`,
          published: false,
        },
      ],
    };
    await postChatFinal(
      stub,
      buildBody({
        client_id: 'admin-portal',
        message: 'second turn no trigger',
        _org_languages: stale,
      })
    );

    expect(captured.calls.length).toBe(2);
    expect(captured.calls[1].system).toContain(TEST_LANG_MARKER);
    expect(captured.calls[1].system).toContain('## Language Guidance');

    // No `language_not_found` warn should fire for the admin bypass.
    const anyStaleMaskWarn = captured.warnLogs.find((w) => w.event === 'language_not_found');
    expect(anyStaleMaskWarn).toBeUndefined();
  });
});
