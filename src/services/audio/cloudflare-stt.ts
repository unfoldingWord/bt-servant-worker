/**
 * Cloudflare Workers AI Speech-to-Text (STT)
 *
 * Model: @cf/openai/whisper-large-v3-turbo
 */

import { AudioTranscriptionError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import {
  AudioFormat,
  MAX_AUDIO_SIZE_BYTES,
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
  logger.log('stt_start', {
    format: audioFormat,
    size_bytes: decodedSize,
    base64_length: audioBase64.length,
    model: '@cf/openai/whisper-large-v3-turbo',
  });

  try {
    const aiCallStart = Date.now();
    // Whisper expects base64 string directly
    const result = await ai.run('@cf/openai/whisper-large-v3-turbo', {
      audio: audioBase64,
    });
    const aiCallDuration = Date.now() - aiCallStart;

    const text = result.text?.trim() ?? '';
    const durationMs = Date.now() - startTime;

    logger.log('stt_complete', {
      text_length: text.length,
      text_preview: text.slice(0, 100),
      ai_call_ms: aiCallDuration,
      total_ms: durationMs,
      had_text: text.length > 0,
    });

    return { text, duration_ms: durationMs };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    if (error instanceof AudioTranscriptionError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('stt_error', error, {
      duration_ms: durationMs,
      error_type: error instanceof Error ? error.constructor.name : typeof error,
    });
    throw new AudioTranscriptionError(`Transcription failed: ${msg}`);
  }
}
