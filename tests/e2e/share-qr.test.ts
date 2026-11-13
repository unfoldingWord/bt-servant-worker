/**
 * E2E tests for the one-time share QR (#474).
 *
 * The callback path is driven through the DO's real `processCallbackEntry`
 * with the Anthropic call mocked as SSE and the gateway webhook captured at
 * `globalThis.fetch`, so these assert the exact payloads the WhatsApp gateway
 * receives. The SSE and `/chat/final` suites prove the opt-in field changes
 * nothing on those transports (the ETEN summit hold on worker #421). The route
 * suite fetches the public PNG and scans it with an independent QR decoder.
 */

import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildChatBody,
  postChatFinal,
  readMockRequestBody,
  setupAnthropicFetchCapture,
} from '../helpers/anthropic-capture.js';
import { decodeGrayPng, scanQr } from '../helpers/png-decode.js';
import type { Env } from '../../src/config/types';
import worker from '../../src/index';
import type { ChatRequest, UserPreferencesInternal } from '../../src/types/engine.js';
import type { OrgModes, PromptMode } from '../../src/types/prompt-overrides.js';
import type { InternalQueueEntry } from '../../src/types/queue.js';
import { createRequestLogger, type RequestLogger } from '../../src/utils/logger.js';
import { shareQrImagePath, shareQrSignature } from '../../src/utils/share-qr.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const HOOK_URL = 'https://gateway.example.test/progress-callback';
const ORIGIN = 'https://worker.example.test';
const LINK = 'https://wa.me/15558196461';

interface QueueInstance {
  processCallbackEntry(entry: InternalQueueEntry, logger: RequestLogger): Promise<void>;
}

const SPOKEN: PromptMode = {
  name: 'spoken',
  label: 'Spoken',
  published: true,
  welcome_message: 'Welcome to Spoken mode!',
  overrides: {},
};
const FIA: PromptMode = { name: 'fia-coach', label: 'FIA Coach', published: true, overrides: {} };
const ORG_MODES: OrgModes = { modes: [SPOKEN, FIA] };

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function sse(events: object[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n`).join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function messageStart(): object {
  return {
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: null, stop_sequence: null, usage: USAGE, content: [] }, // prettier-ignore
  };
}

function textAnswer(text: string): Response {
  return sse([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: USAGE }, // prettier-ignore
    { type: 'message_stop' },
  ]);
}

function switchModeCall(mode: string): Response {
  return sse([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'switch_mode', input: {} } }, // prettier-ignore
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ mode }) } }, // prettier-ignore
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: USAGE }, // prettier-ignore
    { type: 'message_stop' },
  ]);
}

/**
 * Mock Anthropic (each call takes the next scripted response, then 'ok') and
 * capture every gateway webhook POST, in arrival order, answering `hookStatus`.
 */
function setupMocks(
  script: Array<() => Response> = [],
  hookStatus: (type: unknown) => number = () => 200
): { hooks: Array<Record<string, unknown>> } {
  const hooks: Array<Record<string, unknown>> = [];
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.anthropic.com')) return (script.shift() ?? (() => textAnswer('ok')))();
    if (url.startsWith(HOOK_URL)) {
      const hook = JSON.parse(await readMockRequestBody(input, init)) as Record<string, unknown>;
      hooks.push(hook);
      return new Response('ok', { status: hookStatus(hook.type) });
    }
    return realFetch(input, init);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { hooks };
}

/** A WhatsApp-gateway callback request, opted in to the share QR. */
function waBody(message: string, overrides: Partial<ChatRequest> = {}): ChatRequest {
  return buildChatBody({
    message,
    client_id: 'whatsapp',
    org: 'unfoldingWord',
    progress_callback_url: HOOK_URL,
    progress_mode: 'iteration',
    message_key: `k-${crypto.randomUUID()}`,
    accepts_share_qr: true,
    _transport: 'callback',
    _worker_origin: ORIGIN,
    _org_modes: ORG_MODES,
    ...overrides,
  });
}

async function runCallbackTurn(stub: DurableObjectStub, body: ChatRequest): Promise<void> {
  const entry: InternalQueueEntry = {
    message_id: body.message_key as string,
    body,
    enqueued_at: Date.now(),
    retry_count: 0,
  };
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as QueueInstance).processCallbackEntry(entry, createRequestLogger('t'))
  );
}

function completeOf(hooks: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return hooks.filter((h) => h.type === 'complete').at(-1);
}

function readFlag(stub: DurableObjectStub, suffix: string): Promise<boolean | undefined> {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.get<boolean>(`share_qr_sent:${suffix}`)
  );
}

function listShareFlags(stub: DurableObjectStub): Promise<string[]> {
  return runInDurableObject(stub, async (_i, state) => [
    ...(await state.storage.list({ prefix: 'share_qr_sent:' })).keys(),
  ]);
}

function seedExistingUser(stub: DurableObjectStub, selectedMode?: string): Promise<void> {
  return runInDurableObject(stub, async (_i, state) => {
    const prefs: Partial<UserPreferencesInternal> = {
      response_language: 'en',
      first_interaction: false,
    };
    await state.storage.put('preferences', prefs);
    if (selectedMode) await state.storage.put('selected_mode', selectedMode);
  });
}

describe('share QR — WhatsApp callback path (#474)', () => {
  let stub: DurableObjectStub;
  let hooks: Array<Record<string, unknown>>;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    hooks = setupMocks().hooks;
  });
  afterEach(() => vi.restoreAllMocks());

  it('scan-in: welcome, then the answer, then the QR on the complete callback', async () => {
    await runCallbackTurn(stub, waBody('#spoken hi'));

    const welcomeIdx = hooks.findIndex(
      (h) => h.type === 'progress' && String(h.text).includes('Welcome to Spoken mode!')
    );
    const completeIdx = hooks.findIndex((h) => h.type === 'complete');
    expect(welcomeIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(welcomeIdx);
    const complete = hooks.at(completeIdx);
    expect(complete?.text).toBe('ok');
    expect(complete?.share_qr).toEqual({
      url: `${ORIGIN}${await signedPath('spoken')}`,
      caption: `Share BT Servant with others: scan this code, or forward this image.\n${LINK}?text=%23spoken`, // prettier-ignore
      code: 'spoken',
    });
    expect(await readFlag(stub, 'spoken')).toBe(true);
  });

  it('sends it once per mode: not again in the same mode, again for a new mode', async () => {
    await runCallbackTurn(stub, waBody('#spoken hi'));
    expect(completeOf(hooks)?.share_qr).toBeDefined();

    await runCallbackTurn(stub, waBody('and again'));
    expect(completeOf(hooks)).not.toHaveProperty('share_qr');

    await runCallbackTurn(stub, waBody('#fia-coach hello'));
    expect((completeOf(hooks)?.share_qr as { code: string }).code).toBe('fia-coach');

    // Back into a mode whose QR was already sent: nothing.
    await runCallbackTurn(stub, waBody('#spoken back'));
    expect(completeOf(hooks)).not.toHaveProperty('share_qr');
    expect((await listShareFlags(stub)).sort()).toEqual([
      'share_qr_sent:fia-coach',
      'share_qr_sent:spoken',
    ]);
  });

  it('counts a switch_mode tool call as entering the mode', async () => {
    await seedExistingUser(stub);
    vi.restoreAllMocks();
    const scripted = setupMocks([() => switchModeCall('fia-coach'), () => textAnswer('Switched.')]);
    await runCallbackTurn(stub, waBody('please use the FIA coach'));
    const complete = completeOf(scripted.hooks);
    expect(complete?.text).toBe('Switched.');
    expect((complete?.share_qr as { code: string } | undefined)?.code).toBe('fia-coach');
    expect(await readFlag(stub, 'fia-coach')).toBe(true);
  });
});

describe('share QR — no-mode users, locale and gating (#474)', () => {
  let stub: DurableObjectStub;
  let hooks: Array<Record<string, unknown>>;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    hooks = setupMocks().hooks;
  });
  afterEach(() => vi.restoreAllMocks());

  it('a brand-new user with no mode gets the bare BT Servant QR', async () => {
    await runCallbackTurn(stub, waBody('hi'));
    const qr = completeOf(hooks)?.share_qr as { url: string; code: null; caption: string };
    expect(qr.code).toBeNull();
    expect(qr.url).toBe(`${ORIGIN}${await signedPath(null)}`);
    expect(qr.caption.endsWith(`\n${LINK}`)).toBe(true);
    expect(await readFlag(stub, '@bare')).toBe(true);
  });

  it('an existing user gets none on a plain turn, with or without a mode', async () => {
    await seedExistingUser(stub, 'spoken');
    await runCallbackTurn(stub, waBody('hi'));
    expect(completeOf(hooks)).not.toHaveProperty('share_qr');

    const other = env.USER_DO.get(env.USER_DO.newUniqueId());
    await seedExistingUser(other);
    await runCallbackTurn(other, waBody('hi'));
    expect(completeOf(hooks)).not.toHaveProperty('share_qr');
    expect(await listShareFlags(stub)).toEqual([]);
    expect(await listShareFlags(other)).toEqual([]);
  });

  it('translates the caption into the user language (pt)', async () => {
    await runCallbackTurn(stub, waBody('#spoken oi', { response_language_hint: 'pt' }));
    const qr = completeOf(hooks)?.share_qr as { caption: string };
    expect(qr.caption.startsWith('Compartilhe o BT Servant')).toBe(true);
  });

  const gated: Array<[string, Partial<ChatRequest>]> = [
    ['the gateway did not opt in', { accepts_share_qr: undefined }],
    ['the client is not the WhatsApp gateway', { client_id: 'telegram' }],
    ['the org is not unfoldingWord', { org: 'wordcollective' }],
    ['the client suppressed the welcome', { suppress_welcome: true }],
  ];
  for (const [why, overrides] of gated) {
    it(`attaches nothing and writes no flag when ${why}`, async () => {
      await runCallbackTurn(stub, waBody('#spoken hi', overrides));
      expect(completeOf(hooks)?.text).toBe('ok');
      expect(completeOf(hooks)).not.toHaveProperty('share_qr');
      expect(await listShareFlags(stub)).toEqual([]);
    });
  }
});

describe('share QR — failures are non-fatal (#474)', () => {
  let stub: DurableObjectStub;
  let hooks: Array<Record<string, unknown>>;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    hooks = setupMocks().hooks;
  });
  afterEach(() => vi.restoreAllMocks());

  /** Run one callback turn with the share-QR flag write failing, capturing log lines. */
  async function runWithFailingFlagWrite(): Promise<string[]> {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    const body = waBody('#spoken hi');
    const entry: InternalQueueEntry = { message_id: body.message_key as string, body, enqueued_at: Date.now(), retry_count: 0 }; // prettier-ignore
    await runInDurableObject(stub, async (instance, state) => {
      const realPut = state.storage.put.bind(state.storage) as (k: string, v: unknown) => Promise<void>; // prettier-ignore
      vi.spyOn(state.storage, 'put').mockImplementation((async (key: unknown, value: unknown) => {
        if (typeof key === 'string' && key.startsWith('share_qr_sent:')) {
          throw new Error('storage down');
        }
        return realPut(key as string, value);
      }) as typeof state.storage.put);
      await (instance as unknown as QueueInstance).processCallbackEntry(entry, createRequestLogger('t')); // prettier-ignore
    });
    return logged;
  }

  it('a failed flag write sends the answer without a QR and logs a warning', async () => {
    const logged = await runWithFailingFlagWrite();
    const complete = completeOf(hooks);
    expect(complete?.text).toBe('ok');
    expect(complete).not.toHaveProperty('share_qr');
    expect(hooks.some((h) => h.type === 'error')).toBe(false);
    expect(logged.some((line) => line.includes('share_qr_attach_failed'))).toBe(true);
    expect(await listShareFlags(stub)).toEqual([]);
  });
});

describe('share QR — a failed complete webhook is not re-emitted (#474)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
  });
  afterEach(() => vi.restoreAllMocks());

  it('a failed complete webhook still burns the flag: no re-emit on re-entry (decided 2026-11-05)', async () => {
    let failComplete = true;
    const run = setupMocks([], (type) => (type === 'complete' && failComplete ? 503 : 200));
    await runCallbackTurn(stub, waBody('#spoken hi'));
    expect(completeOf(run.hooks)?.share_qr).toBeDefined();
    expect(await readFlag(stub, 'spoken')).toBe(true);

    // Leave and re-enter the mode with the gateway healthy again.
    failComplete = false;
    await runCallbackTurn(stub, waBody('#fia-coach hello'));
    expect((completeOf(run.hooks)?.share_qr as { code: string }).code).toBe('fia-coach');
    await runCallbackTurn(stub, waBody('#spoken again'));
    expect(completeOf(run.hooks)?.text).toBe('ok');
    expect(completeOf(run.hooks)).not.toHaveProperty('share_qr');
  });
});

/**
 * Blank the values of fields that differ run to run (ids, clocks, timings) in
 * a RAW body, leaving framing, whitespace and key order intact, so the
 * comparison below is byte-for-byte on everything else.
 */
const VOLATILE_RE =
  /"(timestamp|message_id|request_id|turn_id|duration_ms|processing_ms|first_token_ms|created_at)":("[^"]*"|-?[0-9.]+)/g;

function blankVolatile(raw: string): string {
  return raw.replace(VOLATILE_RE, '"$1":"<volatile>"');
}

/** A first-contact `#spoken` turn, with or without the opt-in. */
function sseBody(optIn: boolean): ChatRequest {
  return buildChatBody({
    message: '#spoken hi',
    client_id: 'whatsapp',
    _org_modes: ORG_MODES,
    _worker_origin: ORIGIN,
    ...(optIn ? { accepts_share_qr: true } : {}),
  });
}

describe('share QR — SSE stream is unchanged (ETEN hold, #421)', () => {
  beforeEach(() => setupMocks());
  afterEach(() => vi.restoreAllMocks());

  it('/chat/stream sends the same bytes with or without accepts_share_qr', async () => {
    const runs: string[] = [];
    for (const optIn of [false, true]) {
      const stub = env.USER_DO.get(env.USER_DO.newUniqueId());
      const response = await stub.fetch('http://fake-host/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sseBody(optIn)),
      });
      const raw = await response.text();
      expect(raw).toContain('"type":"complete"');
      expect(raw).not.toContain('share_qr');
      expect(await listShareFlags(stub)).toEqual([]);
      runs.push(blankVolatile(raw));
    }
    expect(runs[1]).toBe(runs[0]);
  });
});

describe('share QR — /chat/final is unchanged (#474)', () => {
  beforeEach(() => {
    setupAnthropicFetchCapture();
  });
  afterEach(() => vi.restoreAllMocks());

  it('/chat/final returns the same bytes with or without accepts_share_qr', async () => {
    const runs: string[] = [];
    for (const optIn of [false, true]) {
      const stub = env.USER_DO.get(env.USER_DO.newUniqueId());
      const response = await postChatFinal(stub, sseBody(optIn));
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain('share_qr');
      expect(await listShareFlags(stub)).toEqual([]);
      runs.push(blankVolatile(raw));
    }
    expect(runs[1]).toBe(runs[0]);
  });
});

async function fetchPublic(path: string, overrides: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const handler = worker as unknown as {
    fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  };
  const res = await handler.fetch(new Request(`https://worker${path}`), { ...env, ...overrides }, ctx); // prettier-ignore
  await waitOnExecutionContext(ctx);
  return res;
}

/** A worker-issued (signed) image path for `code`, as the DO builds it. */
async function signedPath(code: string | null): Promise<string> {
  const sig = await shareQrSignature(env.ENGINE_API_KEY, code);
  return `${shareQrImagePath(code)}?s=${sig}`;
}

describe('share QR — public PNG route (#474)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const cases: Array<[string | null, string]> = [
    ['spoken', `${LINK}?text=%23spoken`],
    ['fia-coach', `${LINK}?text=%23fia-coach`],
    ['wordcollective/bible-study', `${LINK}?text=%23wordcollective%2Fbible-study`],
    [null, LINK],
  ];
  for (const [code, link] of cases) {
    it(`serves a signed PNG for ${code ?? '(bare)'} that scans to ${link}`, async () => {
      const res = await fetchPublic(await signedPath(code));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Number(res.headers.get('Content-Length'))).toBe(bytes.length);
      expect(scanQr(await decodeGrayPng(bytes))).toBe(link);
    });
  }
});

describe('share QR — public PNG route refusals and caching (#474)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('404s an unsigned URL, a wrong signature, and a signature for another code', async () => {
    expect((await fetchPublic('/public/share-qr/spoken.png')).status).toBe(404);
    expect((await fetchPublic('/public/share-qr/spoken.png?s=00')).status).toBe(404);
    const other = await shareQrSignature(env.ENGINE_API_KEY, 'fia-coach');
    expect((await fetchPublic(`/public/share-qr/spoken.png?s=${other}`)).status).toBe(404);
  });

  it('404s a signed clear token (default)', async () => {
    expect((await fetchPublic(await signedPath('default'))).status).toBe(404);
  });

  for (const path of [
    '/public/share-qr/Spoken.png',
    '/public/share-qr/a/b/c.png',
    '/public/share-qr/spoken',
    '/public/share-qr/',
  ]) {
    it(`404s ${path}`, async () => {
      expect((await fetchPublic(path)).status).toBe(404);
    });
  }

  it('renders once per link: a replay or an extra query parameter is a cache hit', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const code = `cache-probe-${Date.now()}`;
    const path = await signedPath(code);
    const first = await fetchPublic(path);
    const replay = await fetchPublic(path);
    const busted = await fetchPublic(`${path}&x=1`);
    const bodies = await Promise.all([first, replay, busted].map((r) => r.arrayBuffer()));
    expect([first.status, replay.status, busted.status]).toEqual([200, 200, 200]);
    expect(new Uint8Array(bodies[1] as ArrayBuffer)).toEqual(new Uint8Array(bodies[0] as ArrayBuffer)); // prettier-ignore
    const served = lines.filter((l) => l.includes('share_qr_served'));
    expect(served).toHaveLength(3);
    expect(served.filter((l) => l.includes('"cache":"miss"'))).toHaveLength(1);
    expect(served.filter((l) => l.includes('"cache":"hit"'))).toHaveLength(2);
  });

  it('503s when WHATSAPP_NUMBER is not configured', async () => {
    const res = await fetchPublic(await signedPath('spoken'), { WHATSAPP_NUMBER: undefined });
    expect(res.status).toBe(503);
  });
});
