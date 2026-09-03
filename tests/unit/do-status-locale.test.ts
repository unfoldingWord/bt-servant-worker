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
 * The DO runs against a Map-backed fake DurableObjectState whose storage
 * holds `preferences.response_language = 'pt'` and can gate individual reads.
 * Only the audio service boundary is mocked; everything from the emit site
 * outward — the queue, the SSE writer, the wire frames — is real code. Private
 * methods are reached through a typed cast: the alternative (driving a whole
 * chat turn) needs the Anthropic API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  processingFailureDetail,
  resolveStatusLocale,
  UserDO,
} from '../../src/durable-objects/user-do.js';
import { createStatusEmitter, type StatusEmitter } from '../../src/i18n/status-emitter.js';
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
import type { InternalQueueEntry } from '../../src/types/queue.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import { createTimingContext, type TimingContext } from '../../src/utils/timing.js';
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

type PhaseCtx = { timing: TimingContext; logger: RequestLogger; startTime: number };

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
  processCallbackEntry(entry: InternalQueueEntry, logger: RequestLogger): Promise<void>;
  buildWebhookCallbacks(body: ChatRequest, logger: RequestLogger): StreamCallbacks | undefined;
  processImmediateFinal(
    body: ChatRequest,
    workerOrigin: string,
    messageId: string,
    logger: RequestLogger
  ): Promise<Response>;
  processImmediateCallback(
    body: ChatRequest,
    workerOrigin: string,
    messageId: string,
    logger: RequestLogger
  ): Response;
  processImmediateSSE(
    body: ChatRequest,
    workerOrigin: string,
    messageId: string,
    logger: RequestLogger
  ): Response;
  loadChatContext(
    body: ChatRequest,
    ctx: PhaseCtx,
    callbacks?: StreamCallbacks
  ): Promise<{
    messageText: string;
    history: ChatHistoryEntry[];
    locale: string;
    emitStatus: StatusEmitter | undefined;
  }>;
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
}

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

function phaseCtx(logger: RequestLogger): PhaseCtx {
  return { timing: createTimingContext(), logger, startTime: Date.now() };
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

function createDOFromState(state: DurableObjectState): UserDOInternals {
  const env = {
    DEFAULT_ORG: 'unfoldingWord',
    AI: {},
    OPENAI_API_KEY: 'test-openai-key',
    AUDIO_BUCKET: {},
  } as unknown as Env;
  return new UserDO(state, env) as unknown as UserDOInternals;
}

function createDO(opts: FakeStorageOptions = {}): UserDOInternals {
  return createDOFromState(createFakeState(opts));
}

/** Storage key the DO uses for its processing lock (`PROCESSING_LOCK_KEY`). */
const PROCESSING_LOCK_KEY = '_processing_lock';

function lockReleased(state: DurableObjectState): boolean {
  return vi.mocked(state.storage.delete).mock.calls.some(([key]) => key === PROCESSING_LOCK_KEY);
}

function createCallbacks(statuses: StatusUpdate[]): StreamCallbacks {
  return {
    onStatus: vi.fn((s: StatusUpdate) => statuses.push(s)),
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
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

describe('resolveStatusLocale (the one locale rule)', () => {
  it('uses the stored response_language', () => {
    expect(resolveStatusLocale(textBody, PT_PREFS)).toBe('pt');
  });

  it('prefers a gateway response_language_hint for this request', () => {
    expect(resolveStatusLocale({ ...textBody, response_language_hint: 'en' }, PT_PREFS)).toBe('en');
  });
});

describe('createStatusEmitter', () => {
  it('returns undefined when there are no callbacks (nothing to emit to)', () => {
    expect(createStatusEmitter(undefined, 'pt', createMockLogger())).toBeUndefined();
  });

  it('emits key + localized message through onStatus', async () => {
    const statuses: StatusUpdate[] = [];
    const emit = createStatusEmitter(createCallbacks(statuses), 'pt', createMockLogger());
    await emit?.('status_executing_tools', { n: 2 });
    expect(statuses).toEqual([
      { key: 'status_executing_tools', message: 'Executando 2 ferramentas...' },
    ]);
  });

  it('logs and swallows a throwing callback (a status line never fails the turn)', async () => {
    const logger = createMockLogger();
    const callbacks: StreamCallbacks = {
      onStatus: vi.fn(() => {
        throw new Error('socket closed');
      }),
      onProgress: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };
    const emit = createStatusEmitter(callbacks, 'pt', logger)!;

    await expect(emit('status_processing')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'status_callback_failed',
      expect.objectContaining({ key: 'status_processing', error: 'socket closed' })
    );
  });
});

describe('UserDO queued SSE notice (#405)', () => {
  it('writes status_queued with the Portuguese message as the first frame', async () => {
    const logger = createMockLogger();
    const res = createDO().createQueuedSSEStream('pt', 'msg-1', logger);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    expect(await readFirstSSEEvent(res)).toEqual({
      type: 'status',
      key: 'status_queued',
      message: UI_STRINGS.pt.status_queued,
    });
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
    const failing = createDO({ preferences: new Error('storage unavailable') });

    await expect(failing.readStatusLocale(textBody, logger)).resolves.toBe('en');
    expect(logger.warn).toHaveBeenCalledWith(
      'status_locale_read_failed',
      expect.objectContaining({ error: 'storage unavailable' })
    );
    // A request hint still wins over the English default.
    await expect(
      failing.readStatusLocale({ ...textBody, response_language_hint: 'pt' }, logger)
    ).resolves.toBe('pt');
  });
});

describe('UserDO queued SSE stream registration (#405 review P1)', () => {
  it('a drain that lands during the locale read still delivers every event to the queued client and closes the stream', async () => {
    const prefsGate = deferred<UserPreferencesInternal>();
    const userDo = createDO({ preferences: prefsGate.promise });
    const logger = createMockLogger();
    // The turn is stubbed but still reports through the stream's own callbacks,
    // so the queued notice → first turn status ordering is asserted on one wire.
    const processChat = vi
      .spyOn(userDo, 'processChat')
      .mockImplementation(async (_body, _origin, turnLogger, _timing, callbacks) => {
        await createStatusEmitter(callbacks, 'pt', turnLogger)?.('status_processing');
        return FAKE_RESPONSE;
      });

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
    expect(events.map((e) => e.type)).toEqual(['status', 'status', 'complete']);
    const statuses = events.filter((e): e is SSEStatusEvent => e.type === 'status');
    expect(statuses.map((s) => s.key)).toEqual(['status_queued', 'status_processing']);
    expect(statuses[0]?.message).toBe(UI_STRINGS.pt.status_queued);
    expect(statuses[1]?.message).toBe(UI_STRINGS.pt.status_processing);
  });
});

describe('UserDO queued transports release resources when the locale read throws (#405 review L1)', () => {
  const readFailure = new Error('locale read exploded');

  it('queued SSE: the drain sends the error frame and still closes the writer', async () => {
    const userDo = createDO();
    const logger = createMockLogger();
    const processChat = vi.spyOn(userDo, 'processChat').mockResolvedValue(FAKE_RESPONSE);

    const res = await userDo.enqueueAndReturn(textBody, 'msg-q-fail', '', false, logger);
    // The queued notice already resolved its locale; the turn's own read fails.
    vi.spyOn(userDo, 'readStatusLocale').mockRejectedValue(readFailure);

    const eventsPending = readSSEEvents(res); // fails the test if the writer never closes
    await userDo.drainQueue(logger);
    const events = await eventsPending;

    expect(events.map((e) => e.type)).toEqual(['status', 'error']);
    expect(events[1]).toEqual({ type: 'error', error: 'locale read exploded' });
    expect(processChat).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'sse_entry_processing_error',
      readFailure,
      expect.objectContaining({ message_id: 'msg-q-fail' })
    );
  });

  it('queued callback: onError runs and the error propagates to the retry logic', async () => {
    const userDo = createDO();
    const logger = createMockLogger();
    const onError = vi.fn();
    vi.spyOn(userDo, 'buildWebhookCallbacks').mockReturnValue({
      onStatus: vi.fn(),
      onProgress: vi.fn(),
      onComplete: vi.fn(),
      onError,
    });
    vi.spyOn(userDo, 'readStatusLocale').mockRejectedValue(readFailure);
    const processChat = vi.spyOn(userDo, 'processChat').mockResolvedValue(FAKE_RESPONSE);
    const entry: InternalQueueEntry = {
      message_id: 'msg-cb-q-fail',
      body: { ...textBody, progress_callback_url: 'https://example.test/cb', message_key: 'k' },
      enqueued_at: Date.now(),
      retry_count: 0,
    };

    await expect(userDo.processCallbackEntry(entry, logger)).rejects.toBe(readFailure);

    expect(onError).toHaveBeenCalledWith('locale read exploded');
    expect(processChat).not.toHaveBeenCalled();
  });
});

describe('UserDO immediate transports release resources when the locale read throws (#405 review M1)', () => {
  const readFailure = new Error('locale read exploded');

  it('SSE: the error reaches the client, the writer closes and the lock is released', async () => {
    const state = createFakeState();
    const userDo = createDOFromState(state);
    const logger = createMockLogger();
    vi.spyOn(userDo, 'readStatusLocale').mockRejectedValue(readFailure);
    const processChat = vi.spyOn(userDo, 'processChat').mockResolvedValue(FAKE_RESPONSE);

    const res = userDo.processImmediateSSE(textBody, '', 'msg-sse-fail', logger);
    const events = await readSSEEvents(res); // fails the test if the writer never closes
    await settle(); // the lock release follows the writer close by a microtask

    expect(events).toEqual([{ type: 'error', error: 'locale read exploded' }]);
    expect(processChat).not.toHaveBeenCalled();
    expect(lockReleased(state)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      'immediate_sse_error',
      readFailure,
      expect.objectContaining({ message_id: 'msg-sse-fail' })
    );
  });

  it('callback: the failure is logged and the lock is released', async () => {
    const state = createFakeState();
    const userDo = createDOFromState(state);
    const logger = createMockLogger();
    vi.spyOn(userDo, 'readStatusLocale').mockRejectedValue(readFailure);

    const res = userDo.processImmediateCallback(textBody, '', 'msg-cb-fail', logger);
    expect(res.status).toBe(202);
    await settle();

    expect(lockReleased(state)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      'immediate_callback_error',
      readFailure,
      expect.objectContaining({ message_id: 'msg-cb-fail' })
    );
  });

  it('final: a 500 with the English fallback title is returned and the lock is released', async () => {
    const state = createFakeState();
    const userDo = createDOFromState(state);
    const logger = createMockLogger();
    vi.spyOn(userDo, 'readStatusLocale').mockRejectedValue(readFailure);

    const res = await userDo.processImmediateFinal(textBody, '', 'msg-final-fail', logger);
    await settle(); // lock release + drain run in the background after the response

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: UI_STRINGS.en.error_processing_failed,
      message: 'locale read exploded',
    });
    expect(lockReleased(state)).toBe(true);
  });
});

describe('UserDO loadChatContext locale (#405)', () => {
  beforeEach(primeAudioMocks);
  afterEach(() => vi.clearAllMocks());

  it('transcription status uses the stored pt preference when there is no hint', async () => {
    const statuses: StatusUpdate[] = [];
    const logger = createMockLogger();

    const loaded = await createDO().loadChatContext(
      audioBody,
      phaseCtx(logger),
      createCallbacks(statuses)
    );

    expect(loaded.locale).toBe('pt');
    expect(loaded.messageText).toBe('olá');
    expect(statuses).toEqual([
      { key: 'status_transcribing', message: UI_STRINGS.pt.status_transcribing },
    ]);
  });

  it('transcription status honours the body response_language_hint over the stored pt', async () => {
    const statuses: StatusUpdate[] = [];
    const logger = createMockLogger();

    const loaded = await createDO().loadChatContext(
      { ...audioBody, response_language_hint: 'en' },
      phaseCtx(logger),
      createCallbacks(statuses)
    );

    expect(loaded.locale).toBe('en');
    expect(statuses).toEqual([
      { key: 'status_transcribing', message: UI_STRINGS.en.status_transcribing },
    ]);
  });
});

describe('UserDO loadChatContext ordering (#405 review M1)', () => {
  beforeEach(primeAudioMocks);
  afterEach(() => vi.clearAllMocks());

  it('STT starts (and its status goes out) without waiting for the history read', async () => {
    const historyGate = deferred<ChatHistoryEntry[]>();
    const sttStarted = deferred<void>();
    vi.mocked(transcribeAudio).mockImplementation(async () => {
      sttStarted.resolve();
      return { text: 'olá', duration_ms: 5 };
    });
    const statuses: StatusUpdate[] = [];

    const pending = createDO({ history: historyGate.promise }).loadChatContext(
      audioBody,
      phaseCtx(createMockLogger()),
      createCallbacks(statuses)
    );
    await sttStarted.promise;

    // Whisper is already running and the status already went out — history is still pending.
    expect(statuses).toEqual([
      { key: 'status_transcribing', message: UI_STRINGS.pt.status_transcribing },
    ]);

    historyGate.resolve([]);
    const loaded = await pending;
    expect(loaded.messageText).toBe('olá');
    expect(loaded.history).toEqual([]);
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
    const emit = createStatusEmitter(createCallbacks(statuses), 'pt', createMockLogger());
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
  });

  it('TTS keepalive emits status_tts_still_generating in Portuguese every 15s', async () => {
    vi.useFakeTimers();
    const statuses: StatusUpdate[] = [];
    const emit = createStatusEmitter(createCallbacks(statuses), 'pt', createMockLogger())!;
    const keepalive = createDO().startTtsKeepalive(emit, Date.now(), createMockLogger());
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
    } finally {
      clearInterval(keepalive.interval);
    }

    expect(keepalive.getCount()).toBe(2);
    expect(statuses).toEqual([
      { key: 'status_tts_still_generating', message: UI_STRINGS.pt.status_tts_still_generating },
      { key: 'status_tts_still_generating', message: UI_STRINGS.pt.status_tts_still_generating },
    ]);
  });
});

describe('UserDO TTS keepalive failure (#405 review L3)', () => {
  afterEach(() => vi.useRealTimers());

  it('logs tts_keepalive_failed and stops when an emit rejects', async () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    const emit = vi.fn<StatusEmitter>().mockRejectedValueOnce(new Error('transport gone'));
    const keepalive = createDO().startTtsKeepalive(emit, Date.now(), logger);
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'tts_keepalive_failed',
        expect.objectContaining({ error: 'transport gone', keepalive_number: 1 })
      );

      // The interval is cleared: another tick emits nothing more.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(keepalive.getCount()).toBe(1);
    } finally {
      clearInterval(keepalive.interval);
    }
  });
});

describe('processingFailureDetail (#405)', () => {
  it('localizes the generic fallback when the thrown value is not an Error', () => {
    expect(processingFailureDetail('boom', 'pt')).toBe(UI_STRINGS.pt.error_processing_failed);
  });

  it('passes an upstream Error.message through unchanged (diagnostic, not translated)', () => {
    expect(processingFailureDetail(new Error('Anthropic API returned 529: overloaded'), 'pt')).toBe(
      'Anthropic API returned 529: overloaded'
    );
  });

  it('uses English for an unsupported locale', () => {
    expect(processingFailureDetail('boom', 'sw')).toBe(UI_STRINGS.en.error_processing_failed);
  });
});

describe('SSE status contract (#405)', () => {
  beforeEach(primeAudioMocks);
  afterEach(() => vi.clearAllMocks());

  it('every status frame on the wire carries a key from the closed StatusKey union and the pt message', async () => {
    const userDo = createDO();
    const logger = createMockLogger();
    // The turn itself is stubbed; the voice pipeline inside it is real and
    // emits through the transport callbacks the DO built for this stream.
    vi.spyOn(userDo, 'processChat').mockImplementation(
      async (_body, _origin, turnLogger, _timing, callbacks) => {
        const emit = createStatusEmitter(callbacks, 'pt', turnLogger);
        await emit?.('status_processing');
        await userDo.transcribeAudioMessage(audioBody, turnLogger, emit);
        await userDo.generateVoiceResponse('unfoldingWord', 'u1', ['x'], turnLogger, emit);
        return FAKE_RESPONSE;
      }
    );

    const res = await userDo.enqueueAndReturn(audioBody, 'msg-c', '', false, logger);
    const eventsPending = readSSEEvents(res);
    await userDo.drainQueue(logger);
    const events = await eventsPending;

    const statuses = events.filter((e): e is SSEStatusEvent => e.type === 'status');
    expect(statuses.map((s) => s.key)).toEqual([
      'status_queued',
      'status_processing',
      'status_transcribing',
      'status_tts_generating',
    ]);
    expect(statuses.map((s) => s.message)).toEqual([
      UI_STRINGS.pt.status_queued,
      UI_STRINGS.pt.status_processing,
      UI_STRINGS.pt.status_transcribing,
      UI_STRINGS.pt.status_tts_generating,
    ]);
    for (const s of statuses) expect(STATUS_KEYS).toContain(s.key);
    expect(events.at(-1)?.type).toBe('complete');
  });
});
