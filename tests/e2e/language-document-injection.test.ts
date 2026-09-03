/**
 * E2E test for end-to-end language document injection (#191).
 *
 * Exercises the full chain through UserDO via miniflare: classifier →
 * applyTriggerOverrides → resolveEffectiveLanguage → orchestrator system
 * prompt. Asserts against the captured Anthropic request body's `system`
 * field — the cleanest observable seam (telemetry logs in user-do are
 * `logger.log` calls, not an event bus). The capture harness lives in
 * tests/helpers/anthropic-capture.ts, which also explains why the seam is
 * `globalThis.fetch` rather than the SDK.
 *
 * Each test seeds a fresh DO so persistence assertions roundtrip through
 * real DO storage (isolatedStorage is disabled in vitest.config.ts, but a
 * fresh DurableObjectId per test gives the same effect for multi-request
 * scenarios).
 */

/* eslint-disable max-lines-per-function */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatRequest } from '../../src/types/engine.js';
import type { OrgLanguages } from '../../src/types/languages.js';
import {
  buildChatBody,
  postChatFinal,
  setupAnthropicFetchCapture,
} from '../helpers/anthropic-capture.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

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
  return buildChatBody(overrides, {
    client_id: 'web-client',
    user_id: 'e2e-language-injection-user',
    _org_languages: buildOrgLanguages(),
  });
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
