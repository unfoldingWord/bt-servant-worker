import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transcribeAudio, synthesizeSpeech } from '../../src/services/audio/workers-ai.js';
import { AudioTranscriptionError, AudioSynthesisError } from '../../src/utils/errors.js';
import { MAX_AUDIO_SIZE_BYTES } from '../../src/services/audio/types.js';
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
    const mockAi = createMockAi();
    const audio = makeBase64(100);
    await expect(transcribeAudio(mockAi, audio, 'aac', logger)).rejects.toThrow(
      AudioTranscriptionError
    );
    await expect(transcribeAudio(mockAi, audio, 'aac', logger)).rejects.toThrow(
      /Unsupported audio format/
    );
  });

  it('rejects oversized audio', async () => {
    const originalAtob = globalThis.atob;
    globalThis.atob = vi.fn().mockReturnValue('x'.repeat(MAX_AUDIO_SIZE_BYTES + 1));
    try {
      await expect(transcribeAudio(createMockAi(), 'fake', 'ogg', logger)).rejects.toThrow(
        /exceeds maximum/
      );
    } finally {
      globalThis.atob = originalAtob;
    }
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

describe('synthesizeSpeech', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('synthesizes speech and returns base64', async () => {
    const mockAudio = btoa('fake-audio-data');
    const mockAi = createMockAi(mockAudio);
    const result = await synthesizeSpeech(mockAi, 'Hello', logger);

    expect(result.audio_base64).toBe(mockAudio);
    expect(result.audio_format).toBe('mp3');
    expect(result.input_chars).toBe(5);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(mockAi.run).toHaveBeenCalledWith('@cf/deepgram/aura-2-en', {
      text: 'Hello',
      speaker: 'luna',
      encoding: 'mp3',
    });
  });

  it('handles API error', async () => {
    const mockAi = {
      run: vi.fn().mockRejectedValue(new Error('TTS unavailable')),
    } as unknown as Ai;
    await expect(synthesizeSpeech(mockAi, 'Hello', logger)).rejects.toThrow(AudioSynthesisError);
    await expect(synthesizeSpeech(mockAi, 'Hello', logger)).rejects.toThrow(
      /Speech synthesis failed/
    );
  });

  it('preserves AudioSynthesisError thrown internally', async () => {
    const mockAi = {
      run: vi.fn().mockRejectedValue(new AudioSynthesisError('Custom error')),
    } as unknown as Ai;
    await expect(synthesizeSpeech(mockAi, 'Hello', logger)).rejects.toThrow('Custom error');
  });
});
