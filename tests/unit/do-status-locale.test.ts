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
  ChatRequest,
  SSEStatusEvent,
  StreamCallbacks,
  UserPreferencesInternal,
} from '../../src/types/engine.js';
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
  createQueuedSSEStream(
    body: ChatRequest,
    messageId: string,
    logger: RequestLogger
  ): Promise<Response>;
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

function createFakeState(prefs: UserPreferencesInternal | Error): DurableObjectState {
  const storage = {
    get: vi.fn(async (key: string) => {
      if (key !== 'preferences') return undefined;
      if (prefs instanceof Error) throw prefs;
      return prefs;
    }),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
  };
  return { storage } as unknown as DurableObjectState;
}

function createDO(prefs: UserPreferencesInternal | Error = PT_PREFS): UserDOInternals {
  const env = {
    DEFAULT_ORG: 'unfoldingWord',
    AI: {},
    OPENAI_API_KEY: 'test-openai-key',
    AUDIO_BUCKET: {},
  } as unknown as Env;
  return new UserDO(createFakeState(prefs), env) as unknown as UserDOInternals;
}

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
    const res = await createDO().createQueuedSSEStream(textBody, 'msg-1', logger);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const event = await readFirstSSEEvent(res);
    expect(event).toEqual({
      type: 'status',
      key: 'status_queued',
      message: UI_STRINGS.pt.status_queued,
    });
    expect(event.message).toBe('Na fila — o processamento começará em breve');
  });

  it('honours response_language_hint over the stored preference', async () => {
    const logger = createMockLogger();
    const res = await createDO().createQueuedSSEStream(
      { ...textBody, response_language_hint: 'en' },
      'msg-2',
      logger
    );
    const event = await readFirstSSEEvent(res);
    expect(event.message).toBe(UI_STRINGS.en.status_queued);
  });

  it('falls back to English and logs when the preferences read fails (no silent catch)', async () => {
    const logger = createMockLogger();
    const res = await createDO(new Error('storage unavailable')).createQueuedSSEStream(
      textBody,
      'msg-3',
      logger
    );
    const event = await readFirstSSEEvent(res);
    expect(event).toEqual({
      type: 'status',
      key: 'status_queued',
      message: UI_STRINGS.en.status_queued,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'status_locale_read_failed',
      expect.objectContaining({ error: 'storage unavailable' })
    );
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
      response_language: 'sw',
      first_interaction: false,
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
    const queued = await readFirstSSEEvent(
      await userDo.createQueuedSSEStream(textBody, 'msg-c', logger)
    );

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
