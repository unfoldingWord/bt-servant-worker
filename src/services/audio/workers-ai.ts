/**
 * Cloudflare Workers AI audio services (STT + TTS)
 *
 * STT: @cf/openai/whisper-large-v3-turbo
 * TTS: @cf/deepgram/aura-2-en
 */

import { AudioTranscriptionError, AudioSynthesisError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import {
  AudioFormat,
  MAX_AUDIO_SIZE_BYTES,
  MAX_TTS_INPUT_CHARS,
  SpeechSynthesisResult,
  SUPPORTED_AUDIO_FORMATS,
  TranscriptionResult,
} from './types.js';

/** Validate audio input and return the estimated decoded size in bytes. */
function validateAudioInput(audioBase64: string, audioFormat: string): number {
  if (!SUPPORTED_AUDIO_FORMATS.includes(audioFormat as AudioFormat)) {
    throw new AudioTranscriptionError(
      `Unsupported audio format: ${audioFormat}. Supported: ${SUPPORTED_AUDIO_FORMATS.join(', ')}`
    );
  }

  try {
    atob(audioBase64.slice(0, 16));
  } catch {
    throw new AudioTranscriptionError('Invalid base64 audio data');
  }

  // Compute decoded size arithmetically to avoid allocating the full decoded buffer
  const padding = audioBase64.endsWith('==') ? 2 : audioBase64.endsWith('=') ? 1 : 0;
  const decodedSize = Math.floor((audioBase64.length * 3) / 4) - padding;

  if (decodedSize > MAX_AUDIO_SIZE_BYTES) {
    throw new AudioTranscriptionError(
      `Audio size ${decodedSize} bytes exceeds maximum of ${MAX_AUDIO_SIZE_BYTES} bytes (25 MB)`
    );
  }
  return decodedSize;
}

/**
 * Transcribe audio to text using Cloudflare Workers AI (Whisper).
 */
export async function transcribeAudio(
  ai: Ai,
  audioBase64: string,
  audioFormat: string,
  logger: RequestLogger
): Promise<TranscriptionResult> {
  const startTime = Date.now();
  const decodedSize = validateAudioInput(audioBase64, audioFormat);
  logger.log('stt_start', { format: audioFormat, size_bytes: decodedSize });

  try {
    // Whisper expects base64 string directly
    const result = await ai.run('@cf/openai/whisper-large-v3-turbo', {
      audio: audioBase64,
    });

    const text = result.text?.trim() ?? '';
    const durationMs = Date.now() - startTime;

    logger.log('stt_complete', {
      text_length: text.length,
      duration_ms: durationMs,
    });

    return { text, duration_ms: durationMs };
  } catch (error) {
    if (error instanceof AudioTranscriptionError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('stt_error', error);
    throw new AudioTranscriptionError(`Transcription failed: ${msg}`);
  }
}

/**
 * Synthesize text to speech using Cloudflare Workers AI (Deepgram Aura-2).
 * Returns base64-encoded MP3 audio.
 */
export async function synthesizeSpeech(
  ai: Ai,
  text: string,
  logger: RequestLogger
): Promise<SpeechSynthesisResult> {
  const startTime = Date.now();

  // Truncate to avoid slow/failed requests on very large inputs
  const truncatedText =
    text.length > MAX_TTS_INPUT_CHARS ? text.slice(0, MAX_TTS_INPUT_CHARS) : text;
  logger.log('tts_start', {
    input_chars: text.length,
    truncated: text.length > MAX_TTS_INPUT_CHARS,
  });

  try {
    // Aura-2 returns a base64-encoded audio string
    const audioBase64 = await ai.run('@cf/deepgram/aura-2-en', {
      text: truncatedText,
      speaker: 'luna',
      encoding: 'mp3',
    });

    const durationMs = Date.now() - startTime;

    logger.log('tts_complete', {
      output_size: audioBase64.length,
      duration_ms: durationMs,
    });

    return {
      audio_base64: audioBase64,
      audio_format: 'mp3',
      duration_ms: durationMs,
      input_chars: text.length,
    };
  } catch (error) {
    if (error instanceof AudioSynthesisError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('tts_error', error);
    throw new AudioSynthesisError(`Speech synthesis failed: ${msg}`);
  }
}
