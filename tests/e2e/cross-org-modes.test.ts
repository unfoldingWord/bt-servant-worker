/**
 * E2E for the flat cross-org published-mode list (admin-portal#336), driven
 * through the WORKER fetch path (`POST /api/v1/chat` via `SELF`) so the KV
 * enumeration + merge in `readAllOrgKV` is exercised for real, not injected
 * through `_org_modes`.
 *
 * KV is seeded with a home org and two foreign orgs (one of which shares a
 * bare slug with home). Org names carry a `e2e336` marker and every key is
 * removed after each test because vitest storage is not isolated.
 */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ChatResponse } from '../../src/types/engine.js';
import type { PromptMode } from '../../src/types/prompt-overrides.js';
import {
  readMockRequestBody,
  setupAnthropicFetchCapture,
  type AnthropicCapture,
} from '../helpers/anthropic-capture.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const HOME_ORG = 'e2e336-home';
const PBT_ORG = 'E2E336 PBT';
const TO_ORG = 'E2E336 Test Organization';

const HOME_TC_MARKER = 'HOME_TRANSLATION_COACH_MARKER_336';
const TO_TC_MARKER = 'TEST_ORG_TRANSLATION_COACH_MARKER_336';
const PBT_OBT_MARKER = 'PBT_OBT_COACH_MARKER_336';
const PBT_DRAFT_MARKER = 'PBT_DRAFT_MARKER_336';

const HOME_MODES: PromptMode[] = [
  {
    name: 'translation-coach',
    label: 'Translation Coach',
    published: true,
    overrides: { identity: HOME_TC_MARKER },
  },
  { name: 'home-draft', label: 'Home Draft', overrides: { identity: 'HOME_DRAFT_336' } },
];
const PBT_MODES: PromptMode[] = [
  {
    name: 'obt-coach',
    label: 'OBT Coach',
    published: true,
    welcome_message: 'Welcome to OBT coaching.',
    overrides: { identity: PBT_OBT_MARKER },
  },
  { name: 'pbt-draft', label: 'PBT Draft', overrides: { identity: PBT_DRAFT_MARKER } },
];
const TO_MODES: PromptMode[] = [
  {
    name: 'translation-coach',
    label: 'TO Translation Coach',
    published: true,
    overrides: { identity: TO_TC_MARKER },
  },
];

const KEYS = [`${HOME_ORG}:modes`, `${PBT_ORG}:modes`, `${TO_ORG}:modes`];

async function seedKV(): Promise<void> {
  await env.PROMPT_OVERRIDES.put(`${HOME_ORG}:modes`, JSON.stringify({ modes: HOME_MODES }));
  await env.PROMPT_OVERRIDES.put(`${PBT_ORG}:modes`, JSON.stringify({ modes: PBT_MODES }));
  await env.PROMPT_OVERRIDES.put(`${TO_ORG}:modes`, JSON.stringify({ modes: TO_MODES }));
}

const AUTH = { Authorization: 'Bearer test-api-key', 'Content-Type': 'application/json' };

let userSeq = 0;
function freshUserId(): string {
  userSeq += 1;
  return `e2e336-user-${Date.now()}-${userSeq}`;
}

async function postChat(body: Partial<ChatRequest> & Pick<ChatRequest, 'message' | 'user_id'>) {
  const res = await SELF.fetch('http://fake-host/api/v1/chat', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ client_id: 'web', message_type: 'text', org: HOME_ORG, ...body }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ChatResponse;
}

function userStub(userId: string): DurableObjectStub {
  return env.USER_DO.get(env.USER_DO.idFromName(`user:${HOME_ORG}:${userId}`));
}

function readSelectedMode(userId: string): Promise<string | undefined> {
  return runInDurableObject(userStub(userId), (_i, state) =>
    state.storage.get<string>('selected_mode')
  );
}

function seedSelectedMode(userId: string, mode: string): Promise<void> {
  return runInDurableObject(userStub(userId), (_i, state) =>
    state.storage.put('selected_mode', mode)
  );
}

describe('cross-org modes through the worker fetch path (#336)', () => {
  let capture: AnthropicCapture;

  beforeEach(async () => {
    await seedKV();
    capture = setupAnthropicFetchCapture();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(KEYS.map((k) => env.PROMPT_OVERRIDES.delete(k)));
  });

  it('a `#pbt/obt-coach` turn persists the qualified slug and lands PBT overrides on the next turn', async () => {
    const user_id = freshUserId();

    const first = await postChat({ user_id, message: '#e2e336-pbt/obt-coach hello' });
    expect(await readSelectedMode(user_id)).toBe('e2e336-pbt/obt-coach');
    // First-contact welcome for the foreign mode carries the qualified share link.
    expect(first.responses[0]).toContain('Welcome to OBT coaching.');
    expect(first.responses[0]).toContain('?text=%23e2e336-pbt%2Fobt-coach');

    await postChat({ user_id, message: 'and now a plain follow-up' });
    const secondSystem = capture.calls[1]?.system ?? '';
    expect(secondSystem).toContain(PBT_OBT_MARKER);
    expect(secondSystem).not.toContain(HOME_TC_MARKER);
  });

  it('a pre-seeded bare `translation-coach` still resolves to HOME when a foreign org shares the slug', async () => {
    const user_id = freshUserId();
    await seedSelectedMode(user_id, 'translation-coach');

    await postChat({ user_id, message: 'hello' });
    const system = capture.calls[0]?.system ?? '';
    expect(system).toContain(HOME_TC_MARKER);
    expect(system).not.toContain(TO_TC_MARKER);
    expect(await readSelectedMode(user_id)).toBe('translation-coach');
  });

  it('a bare `#translation-coach` trigger selects HOME, and the qualified form selects the foreign one', async () => {
    const user_id = freshUserId();
    await postChat({ user_id, message: '#translation-coach hi' });
    expect(await readSelectedMode(user_id)).toBe('translation-coach');
    expect(capture.calls[0]?.system).toContain(HOME_TC_MARKER);

    await postChat({ user_id, message: '#e2e336-test-organization/translation-coach hi' });
    expect(await readSelectedMode(user_id)).toBe('e2e336-test-organization/translation-coach');
    expect(capture.calls[1]?.system).toContain(TO_TC_MARKER);
    expect(capture.calls[1]?.system).not.toContain(HOME_TC_MARKER);
  });

  it('a bare `#obt-coach` never reaches the foreign mode', async () => {
    const user_id = freshUserId();
    await postChat({ user_id, message: '#obt-coach hi' });
    expect(await readSelectedMode(user_id)).toBeUndefined();
    expect(capture.calls[0]?.system).not.toContain(PBT_OBT_MARKER);
  });
});

/** Script the model to call list_modes once, then answer; capture the tool_result it was handed. */
function setupListModesScript(): { toolResults: unknown[] } {
  const toolResults: unknown[] = [];
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const realFetch = globalThis.fetch.bind(globalThis);
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes('api.anthropic.com')) return realFetch(input, init);
    const parsed = JSON.parse(await readMockRequestBody(input, init)) as {
      messages: Array<{ content: unknown }>;
    };
    const last = parsed.messages[parsed.messages.length - 1];
    const blocks = Array.isArray(last?.content)
      ? (last.content as Array<Record<string, unknown>>)
      : [];
    const result = blocks.find((b) => b.type === 'tool_result');
    const content = result
      ? [{ type: 'text', text: 'done' }]
      : [{ type: 'tool_use', id: 'tool_1', name: 'list_modes', input: {} }];
    if (result) toolResults.push(JSON.parse(result.content as string));
    return new Response(
      JSON.stringify({
        id: `msg_${toolResults.length}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        stop_reason: result ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        usage,
        content,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { toolResults };
}

describe('list_modes visibility across orgs (#336)', () => {
  beforeEach(seedKV);
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(KEYS.map((k) => env.PROMPT_OVERRIDES.delete(k)));
  });

  it('an admin client sees its own drafts and foreign PUBLISHED modes, never a foreign draft', async () => {
    const { toolResults } = setupListModesScript();
    await postChat({ user_id: freshUserId(), client_id: 'admin-portal', message: 'which modes?' });
    const listed = (toolResults[0] as { modes: Array<{ name: string; org: string | null }> }).modes;
    const names = listed.map((m) => m.name);
    expect(names).toContain('translation-coach');
    expect(names).toContain('home-draft');
    expect(names).toContain('e2e336-pbt/obt-coach');
    expect(names).toContain('e2e336-test-organization/translation-coach');
    expect(names).not.toContain('e2e336-pbt/pbt-draft');
    expect(names).not.toContain('pbt-draft');
    expect(listed.find((m) => m.name === 'e2e336-pbt/obt-coach')?.org).toBe(PBT_ORG);
    expect(listed.find((m) => m.name === 'translation-coach')?.org).toBeNull();
  });

  it('an end-user client sees published modes of every org and no drafts at all', async () => {
    const { toolResults } = setupListModesScript();
    await postChat({ user_id: freshUserId(), message: 'which modes?' });
    const names = (toolResults[0] as { modes: Array<{ name: string }> }).modes.map((m) => m.name);
    expect(names).toContain('translation-coach');
    expect(names).toContain('e2e336-pbt/obt-coach');
    expect(names).not.toContain('home-draft');
    expect(names).not.toContain('e2e336-pbt/pbt-draft');
  });
});

describe('admin DO PUT /mode accepts bare or org-qualified selections (#336)', () => {
  async function putMode(mode: unknown): Promise<Response> {
    const stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    return stub.fetch('http://fake-host/mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  it('accepts a bare slug', async () => {
    const res = await putMode('translation-coach');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: 'translation-coach' });
  });

  it('accepts `<orgslug>/<modeslug>`', async () => {
    const res = await putMode('pbt/obt-coach');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: 'pbt/obt-coach' });
  });

  it('rejects a malformed org half or mode half', async () => {
    expect((await putMode('PBT/obt-coach')).status).toBe(400);
    expect((await putMode('pbt/OBT Coach')).status).toBe(400);
    expect((await putMode('pbt/a/b')).status).toBe(400);
    expect((await putMode('/obt-coach')).status).toBe(400);
  });
});
