/**
 * Tests that every status line / notice the UserDO emits itself is localized
 * by the user's `response_language` and carries a stable `key` (issue #405).
 *
 * Sites under test (src/durable-objects/user-do.ts):
 *   - queued SSE notice        → status_queued
 *   - transcribing audio       → status_transcribing
 *   - TTS generating           → status_tts_generating
 *   - TTS 15s keepalive        → status_tts_still_generating
 *   - 'Processing failed'      → error_processing_failed (fallback only;
 *                                an upstream Error.message passes through)
 *
 * The DO is instantiated against a fake DurableObjectState whose storage
 * holds `preferences.response_language = 'pt'`. Only the audio service
 * boundary is mocked; everything from the emit site outward is real code.
 * The private methods are reached through a typed cast — the alternative
 * (driving a whole chat turn) needs the Anthropic API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createStatusEmitter,
  resolveStatusLocale,
  UserDO,
  type StatusEmitter,
} from '../../src/durable-objects/user-do.js';
import {
  synthesizeSpeech,
  transcribeAudio,
  uploadAudio,
  uploadVoiceSubmission,
} from '../../src/services/audio/index.js';
import { STATUS_KEYS, UI_STRINGS, type StatusUpdate } from '../../src/i18n/ui-strings.js';
import type {
  ChatHistoryEntry,
  ChatRequest,
  ChatResponse,
  SSEEvent,
  SSEStatusEvent,
  StreamCallbacks,
  UserPreferencesInternal,
} from '../../src/types/engine.js';
import type { TimingContext } from '../../src/utils/timing.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { Env } from '../../src/config/types.js';

vi.mock('../../src/services/audio/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/audio/index.js')>();
  return {
    ...actual,
    transcribeAudio: vi.fn(),
    synthesizeSpeech: vi.fn(),
    uploadAudio: vi.fn(),
    uploadVoiceSubmission: vi.fn(),
  };
});

const PT_PREFS: UserPreferencesInternal = { response_language: 'pt', first_interaction: false };

/** The private surface this test reaches into. Kept in one place so a rename is one edit. */
interface UserDOInternals {
  enqueueAndReturn(
    body: ChatRequest,
    messageId: string,
    workerOrigin: string,
    isCallbackDelivery: boolean,
    logger: RequestLogger
  ): Promise<Response>;
  createQueuedSSEStream(locale: string, messageId: string, logger: RequestLogger): Response;
  drainQueue(logger: RequestLogger): Promise<void>;
  processChat(
    body: ChatRequest,
    workerOrigin: string,
    logger: RequestLogger,
    timing: TimingContext,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse>;
  readStatusLocale(body: ChatRequest, logger: RequestLogger): Promise<string>;
  transcribeAudioMessage(
    body: ChatRequest,
    logger: RequestLogger,
    emit?: StatusEmitter
  ): Promise<{ text: string; inboundVoiceKey?: string }>;
  generateVoiceResponse(
    org: string,
    userId: string,
    responses: string[],
    logger: RequestLogger,
    emit?: StatusEmitter
  ): Promise<{ audioKey: string } | null>;
  startTtsKeepalive(
    emit: StatusEmitter,
    genStart: number,
    logger: RequestLogger
  ): { interval: ReturnType<typeof setInterval>; getCount: () => number };
  describeProcessingFailure(
    error: unknown,
    body: ChatRequest,
    logger: RequestLogger
  ): Promise<{ title: string; detail: string }>;
}

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

interface FakeStorageOptions {
  /** Stored preferences; an Error makes the read throw; a Promise gates it. */
  preferences?: UserPreferencesInternal | Error | Promise<UserPreferencesInternal>;
  /** Gate the history read (defaults to an immediate empty history). */
  history?: Promise<ChatHistoryEntry[]>;
}

/**
 * Map-backed DurableObjectState. Enough of the storage API for the queue
 * (`enqueueAndReturn` / `drainQueue`): get/put/delete, `setAlarm`, and a
 * `blockConcurrencyWhile` that just runs its callback.
 */
function createFakeState(opts: FakeStorageOptions = {}): DurableObjectState {
  const store = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => {
      if (key === 'preferences') {
        const prefs = opts.preferences ?? PT_PREFS;
        if (prefs instanceof Error) throw prefs;
        return prefs;
      }
      if (key === 'history' && opts.history) return opts.history;
      return store.get(key);
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => store.delete(key)),
    setAlarm: vi.fn(async () => undefined),
  };
  return {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
}

function createDO(opts: FakeStorageOptions = {}): UserDOInternals {
  const env = {
    DEFAULT_ORG: 'unfoldingWord',
    AI: {},
    OPENAI_API_KEY: 'test-openai-key',
    AUDIO_BUCKET: {},
  } as unknown as Env;
  return new UserDO(createFakeState(opts), env) as unknown as UserDOInternals;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Yield a macrotask so every pending microtask (storage reads, spans) settles. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const FAKE_RESPONSE: ChatResponse = {
  responses: ['ok'],
  response_language: 'pt',
  voice_audio_base64: null,
};

function createCallbacks(statuses: StatusUpdate[]): StreamCallbacks {
  return {
    onStatus: vi.fn((s: StatusUpdate) => statuses.push(s)),
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
}

const textBody: ChatRequest = {
  client_id: 'web-client',
  user_id: 'u1',
  message_type: 'text',
  message: 'hi',
};

const audioBody: ChatRequest = {
  client_id: 'whatsapp-gateway',
  user_id: 'u1',
  message_type: 'audio',
  audio_base64: 'AAAA',
  audio_format: 'ogg',
};

/**
 * Read every SSE frame until the stream closes. Fails (instead of hanging the
 * test) if the producer never closes the writer.
 */
async function readSSEEvents(res: Response, timeoutMs = 2_000): Promise<SSEEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`SSE stream did not close within ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
  }
  return buffer
    .split('\n\n')
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      expect(frame.startsWith('data: ')).toBe(true);
      return JSON.parse(frame.slice('data: '.length)) as SSEEvent;
    });
}

async function readFirstSSEEvent(res: Response): Promise<SSEStatusEvent> {
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const frame = new TextDecoder().decode(value);
  expect(frame.startsWith('data: ')).toBe(true);
  return JSON.parse(frame.slice('data: '.length).trim()) as SSEStatusEvent;
}

describe('resolveStatusLocale', () => {
  it('uses the stored response_language', () => {
    expect(resolveStatusLocale(textBody, PT_PREFS)).toBe('pt');
  });

  it('prefers a gateway response_language_hint for this request', () => {
    expect(resolveStatusLocale({ ...textBody, response_language_hint: 'en' }, PT_PREFS)).toBe('en');
  });
});

describe('createStatusEmitter', () => {
  it('returns undefined when there are no callbacks (nothing to emit to)', () => {
    expect(createStatusEmitter(undefined, 'pt')).toBeUndefined();
  });

  it('emits key + localized message through onStatus', async () => {
    const statuses: StatusUpdate[] = [];
    const emit = createStatusEmitter(createCallbacks(statuses), 'pt');
    await emit?.('status_executing_tools', { n: 2 });
    expect(statuses).toEqual([
      { key: 'status_executing_tools', message: 'Executando 2 ferramenta(s)...' },
    ]);
  });
});

describe('UserDO queued SSE notice (#405)', () => {
  it('emits status_queued with the Portuguese message for a pt user', async () => {
    const logger = createMockLogger();
    const res = createDO().createQueuedSSEStream('pt', 'msg-1', logger);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const event = await readFirstSSEEvent(res);
    expect(event).toEqual({
      type: 'status',
      key: 'status_queued',
      message: UI_STRINGS.pt.status_queued,
    });
    expect(event.message).toBe('Na fila — o processamento começará em breve');
  });

  it('readStatusLocale honours response_language_hint over the stored preference', async () => {
    const logger = createMockLogger();
    await expect(
      createDO().readStatusLocale({ ...textBody, response_language_hint: 'en' }, logger)
    ).resolves.toBe('en');
    await expect(createDO().readStatusLocale(textBody, logger)).resolves.toBe('pt');
  });

  it('readStatusLocale falls back to English and logs when the preferences read fails (no silent catch)', async () => {
    const logger = createMockLogger();
    const locale = await createDO({
      preferences: new Error('storage unavailable'),
    }).readStatusLocale(textBody, logger);
    expect(locale).toBe('en');
    expect(logger.warn).toHaveBeenCalledWith(
      'status_locale_read_failed',
      expect.objectContaining({ error: 'storage unavailable' })
    );
  });
});

describe('UserDO queued SSE stream registration (#405 review P1)', () => {
  it('a drain that lands during the locale read still delivers every event to the queued client and closes the stream', async () => {
    const prefsGate = deferred<UserPreferencesInternal>();
    const userDo = createDO({ preferences: prefsGate.promise });
    const logger = createMockLogger();
    const processChat = vi.spyOn(userDo, 'processChat').mockResolvedValue(FAKE_RESPONSE);

    // Client request arrives while the DO is busy: it is queued for SSE delivery.
    const pending = userDo.enqueueAndReturn(textBody, 'msg-race', '', false, logger);
    await settle(); // runs up to the (still pending) preferences read

    // The active turn finishes now and drains the queue while that read is pending.
    await userDo.drainQueue(logger);

    prefsGate.resolve(PT_PREFS);
    const res = await pending;

    // The client reads concurrently (a TransformStream backpressures otherwise)
    // while the alarm fires for whatever is (still) queued.
    const eventsPending = readSSEEvents(res);
    await userDo.drainQueue(logger);

    const events = await eventsPending;
    expect(processChat).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toEqual(['status', 'complete']);
    expect(events[0]).toEqual({
      type: 'status',
      key: 'status_queued',
      message: UI_STRINGS.pt.status_queued,
    });
  });
});

/** Make the mocked audio boundary succeed: STT returns text, TTS returns bytes, R2 uploads resolve. */
function primeAudioMocks(): void {
  vi.mocked(transcribeAudio).mockResolvedValue({ text: 'olá', duration_ms: 5 });
  vi.mocked(uploadVoiceSubmission).mockResolvedValue(undefined);
  vi.mocked(synthesizeSpeech).mockResolvedValue({
    audio_base64: 'AQIDBA==',
    audio_bytes: new Uint8Array([1, 2, 3, 4]),
    audio_format: 'opus',
    duration_ms: 7,
    input_chars: 3,
  });
  vi.mocked(uploadAudio).mockResolvedValue(undefined);
}

describe('UserDO transcription status (#405)', () => {
  beforeEach(primeAudioMocks);
  afterEach(() => vi.clearAllMocks());

  it('transcribing emits status_transcribing in Portuguese', async () => {
    const statuses: StatusUpdate[] = [];
    const emit = createStatusEmitter(createCallbacks(statuses), 'pt');
    const result = await createDO().transcribeAudioMessage(audioBody, createMockLogger(), emit);

    expect(result.text).toBe('olá');
    expect(statuses).toEqual([
      { key: 'status_transcribing', message: UI_STRINGS.pt.status_transcribing },
    ]);
    expect(statuses[0]?.message).toBe('Transcrevendo o áudio...');
  });
});

describe('UserDO TTS status (#405)', () => {
  beforeEach(primeAudioMocks);
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('TTS generation emits status_tts_generating in Portuguese', async () => {
    const statuses: StatusUpdate[] = [];
    const emit = createStatusEmitter(createCallbacks(statuses), 'pt');
    const result = await createDO().generateVoiceResponse(
      'unfoldingWord',
      'u1',
      ['Olá!'],
      createMockLogger(),
      emit
    );

    expect(result?.audioKey).toBeTruthy();
    expect(statuses).toEqual([
      { key: 'status_tts_generating', message: UI_STRINGS.pt.status_tts_generating },
    ]);
    expect(statuses[0]?.message).toBe('Gerando resposta em áudio...');
  });

  it('TTS keepalive emits status_tts_still_generating in Portuguese every 15s', async () => {
    vi.useFakeTimers();
    const statuses: StatusUpdate[] = [];
    const emit = createStatusEmitter(createCallbacks(statuses), 'pt')!;
    const keepalive = createDO().startTtsKeepalive(emit, Date.now(), createMockLogger());
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
    } finally {
      clearInterval(keepalive.interval);
    }

    expect(keepalive.getCount()).toBe(2);
    expect(statuses).toHaveLength(2);
    for (const s of statuses) {
      expect(s).toEqual({
        key: 'status_tts_still_generating',
        message: UI_STRINGS.pt.status_tts_still_generating,
      });
    }
    expect(statuses[0]?.message).toBe('Ainda gerando o áudio...');
  });
});

describe('UserDO processing-failed fallback (#405)', () => {
  it('localizes the generic fallback when the thrown value is not an Error', async () => {
    const failure = await createDO().describeProcessingFailure(
      'boom',
      textBody,
      createMockLogger()
    );
    expect(failure).toEqual({
      title: UI_STRINGS.pt.error_processing_failed,
      detail: UI_STRINGS.pt.error_processing_failed,
    });
    expect(failure.title).toBe('Falha no processamento');
  });

  it('passes an upstream Error.message through unchanged (diagnostic, not translated)', async () => {
    const failure = await createDO().describeProcessingFailure(
      new Error('Anthropic API returned 529: overloaded'),
      textBody,
      createMockLogger()
    );
    expect(failure.detail).toBe('Anthropic API returned 529: overloaded');
    expect(failure.title).toBe(UI_STRINGS.pt.error_processing_failed);
  });

  it('uses English for an unsupported stored language', async () => {
    const failure = await createDO({
      preferences: { response_language: 'sw', first_interaction: false },
    }).describeProcessingFailure('boom', textBody, createMockLogger());
    expect(failure.detail).toBe('Processing failed');
  });
});

describe('SSE status contract (#405)', () => {
  it('every status event key emitted by the DO is drawn from the closed StatusKey union', async () => {
    const statuses: StatusUpdate[] = [];
    const emit = createStatusEmitter(createCallbacks(statuses), 'pt')!;
    primeAudioMocks();

    const userDo = createDO();
    const logger = createMockLogger();
    await userDo.transcribeAudioMessage(audioBody, logger, emit);
    await userDo.generateVoiceResponse('unfoldingWord', 'u1', ['x'], logger, emit);
    const queued = await readFirstSSEEvent(userDo.createQueuedSSEStream('pt', 'msg-c', logger));

    const events: SSEStatusEvent[] = [
      queued,
      ...statuses.map((s) => ({ type: 'status' as const, ...s })),
    ];
    expect(events.length).toBe(3);
    for (const e of events) {
      expect(e.type).toBe('status');
      expect(STATUS_KEYS).toContain(e.key);
      expect(Object.keys(e).sort()).toEqual(['key', 'message', 'type']);
    }
  });
});
