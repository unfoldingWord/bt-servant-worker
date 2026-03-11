import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transcribeAudio } from '../../src/services/audio/cloudflare-stt.js';
import { synthesizeSpeech } from '../../src/services/audio/openai-tts.js';
import { AudioTranscriptionError, AudioSynthesisError } from '../../src/utils/errors.js';
import {
  MAX_AUDIO_SIZE_BYTES,
  MAX_TTS_INPUT_CHARS,
  AudioContext,
} from '../../src/services/audio/types.js';
import { createRequestLogger } from '../../src/utils/logger.js';

const logger = createRequestLogger('test-request-id', 'test-user');

function createMockAi(result: unknown = { text: 'Hello world' }) {
  return { run: vi.fn().mockResolvedValue(result) } as unknown as Ai;
}

function makeBase64(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  for (let idx = 0; idx < byteLength; idx++) bytes[idx] = idx % 256;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ─── Mock OpenAI ────────────────────────────────────────────────────────────

const mockSpeechCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class OpenAI {
      audio = { speech: { create: mockSpeechCreate } };
      static APIError = class APIError extends Error {
        status: number;
        constructor(status: number, message: string) {
          super(message);
          this.status = status;
          this.name = 'APIError';
        }
      };
    },
  };
});

function mockSpeechResponse(audioContent = 'fake-audio-data') {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(audioContent).buffer;
  return { arrayBuffer: () => Promise.resolve(buffer) };
}

// ─── STT Tests ──────────────────────────────────────────────────────────────

describe('transcribeAudio - happy path', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('transcribes audio successfully', async () => {
    const mockAi = createMockAi({ text: 'Hello world' });
    const audio = makeBase64(100);
    const result = await transcribeAudio(mockAi, audio, 'ogg', logger);

    expect(result.text).toBe('Hello world');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(mockAi.run).toHaveBeenCalledWith('@cf/openai/whisper-large-v3-turbo', { audio });
  });

  it('trims whitespace from transcription', async () => {
    const mockAi = createMockAi({ text: '  Hello world  ' });
    const result = await transcribeAudio(mockAi, makeBase64(100), 'mp3', logger);
    expect(result.text).toBe('Hello world');
  });

  it('accepts all supported formats', async () => {
    for (const format of ['ogg', 'mp3', 'wav', 'webm', 'flac', 'm4a']) {
      const mockAi = createMockAi({ text: 'test' });
      const result = await transcribeAudio(mockAi, makeBase64(50), format, logger);
      expect(result.text).toBe('test');
    }
  });

  it('handles empty transcription result', async () => {
    const result = await transcribeAudio(
      createMockAi({ text: '' }),
      makeBase64(100),
      'ogg',
      logger
    );
    expect(result.text).toBe('');
  });

  it('handles undefined text in result', async () => {
    const result = await transcribeAudio(createMockAi({}), makeBase64(100), 'ogg', logger);
    expect(result.text).toBe('');
  });
});

describe('transcribeAudio - validation and errors', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects unsupported audio format', async () => {
    const audio = makeBase64(100);
    await expect(transcribeAudio(createMockAi(), audio, 'aac', logger)).rejects.toThrow(
      /Unsupported audio format/
    );
  });

  it('rejects oversized audio via arithmetic size check', async () => {
    const oversizedChars = Math.ceil(((MAX_AUDIO_SIZE_BYTES + 4) * 4) / 3);
    const oversizedBase64 = 'A'.repeat(oversizedChars);
    await expect(transcribeAudio(createMockAi(), oversizedBase64, 'ogg', logger)).rejects.toThrow(
      /exceeds maximum/
    );
  });

  it('rejects invalid base64', async () => {
    await expect(transcribeAudio(createMockAi(), '!!!invalid!!!', 'ogg', logger)).rejects.toThrow(
      AudioTranscriptionError
    );
  });

  it('handles API error', async () => {
    const mockAi = {
      run: vi.fn().mockRejectedValue(new Error('API unavailable')),
    } as unknown as Ai;
    await expect(transcribeAudio(mockAi, makeBase64(100), 'ogg', logger)).rejects.toThrow(
      /Transcription failed/
    );
  });
});

// ─── AudioContext Tests ─────────────────────────────────────────────────────

describe('AudioContext', () => {
  it('starts with audioRequested false', () => {
    const ctx: AudioContext = {
      audioRequested: false,
      requestAudio: () => {
        ctx.audioRequested = true;
      },
    };
    expect(ctx.audioRequested).toBe(false);
  });

  it('sets audioRequested to true when requestAudio is called', () => {
    const ctx: AudioContext = {
      audioRequested: false,
      requestAudio: () => {
        ctx.audioRequested = true;
      },
    };
    ctx.requestAudio();
    expect(ctx.audioRequested).toBe(true);
  });

  it('remains true after multiple calls', () => {
    const ctx: AudioContext = {
      audioRequested: false,
      requestAudio: () => {
        ctx.audioRequested = true;
      },
    };
    ctx.requestAudio();
    ctx.requestAudio();
    expect(ctx.audioRequested).toBe(true);
  });
});

// ─── TTS Tests (OpenAI) ────────────────────────────────────────────────────

describe('synthesizeSpeech - happy path', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSpeechCreate.mockReset();
  });

  it('synthesizes speech and returns base64', async () => {
    mockSpeechCreate.mockResolvedValue(mockSpeechResponse('fake-audio'));
    const result = await synthesizeSpeech('test-key', 'Hello', logger);

    expect(result.audio_base64).toBeTruthy();
    expect(result.audio_format).toBe('mp3');
    expect(result.input_chars).toBe(5);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('passes correct model, voice, and instructions', async () => {
    mockSpeechCreate.mockResolvedValue(mockSpeechResponse('audio'));
    await synthesizeSpeech('test-key', 'Hello', logger);

    expect(mockSpeechCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-mini-tts',
        voice: 'ash',
        input: 'Hello',
        response_format: 'mp3',
        instructions: expect.stringContaining('knowledgeable'),
      })
    );
  });

  it('truncates text exceeding MAX_TTS_INPUT_CHARS', async () => {
    const longText = 'a'.repeat(MAX_TTS_INPUT_CHARS + 500);
    mockSpeechCreate.mockResolvedValue(mockSpeechResponse('audio'));
    await synthesizeSpeech('test-key', longText, logger);

    const callArgs = mockSpeechCreate.mock.calls[0][0] as { input: string };
    expect(callArgs.input.length).toBe(MAX_TTS_INPUT_CHARS);
  });
});

describe('synthesizeSpeech - retry behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSpeechCreate.mockReset();
  });

  it('retries once on 5xx error', async () => {
    const OpenAI = (await import('openai')).default;
    const Err = OpenAI as unknown as { APIError: new (s: number, m: string) => Error };
    mockSpeechCreate
      .mockRejectedValueOnce(new Err.APIError(500, 'Internal server error'))
      .mockResolvedValueOnce(mockSpeechResponse('audio'));

    const result = await synthesizeSpeech('test-key', 'Hello', logger);
    expect(result.audio_base64).toBeTruthy();
    expect(mockSpeechCreate).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx error', async () => {
    const OpenAI = (await import('openai')).default;
    const Err = OpenAI as unknown as { APIError: new (s: number, m: string) => Error };
    mockSpeechCreate.mockRejectedValue(new Err.APIError(401, 'Unauthorized'));

    await expect(synthesizeSpeech('test-key', 'Hello', logger)).rejects.toThrow(
      AudioSynthesisError
    );
    expect(mockSpeechCreate).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 rate-limit error', async () => {
    const OpenAI = (await import('openai')).default;
    const Err = OpenAI as unknown as { APIError: new (s: number, m: string) => Error };
    mockSpeechCreate
      .mockRejectedValueOnce(new Err.APIError(429, 'Rate limit exceeded'))
      .mockResolvedValueOnce(mockSpeechResponse('audio'));

    const result = await synthesizeSpeech('test-key', 'Hello', logger);
    expect(result.audio_base64).toBeTruthy();
    expect(mockSpeechCreate).toHaveBeenCalledTimes(2);
  });

  it('retries on network error', async () => {
    mockSpeechCreate
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(mockSpeechResponse('audio'));

    const result = await synthesizeSpeech('test-key', 'Hello', logger);
    expect(result.audio_base64).toBeTruthy();
    expect(mockSpeechCreate).toHaveBeenCalledTimes(2);
  });
});

describe('synthesizeSpeech - error handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSpeechCreate.mockReset();
  });

  it('wraps errors in AudioSynthesisError', async () => {
    mockSpeechCreate.mockRejectedValue(new Error('TTS unavailable'));
    await expect(synthesizeSpeech('test-key', 'Hello', logger)).rejects.toThrow(
      AudioSynthesisError
    );
    await expect(synthesizeSpeech('test-key', 'Hello', logger)).rejects.toThrow(
      /Speech synthesis failed/
    );
  });

  it('preserves AudioSynthesisError thrown internally', async () => {
    mockSpeechCreate.mockRejectedValue(new AudioSynthesisError('Custom error'));
    await expect(synthesizeSpeech('test-key', 'Hello', logger)).rejects.toThrow('Custom error');
  });
});
