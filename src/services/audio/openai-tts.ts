/**
 * OpenAI TTS service using gpt-4o-mini-tts
 */

import OpenAI from 'openai';
import { AudioSynthesisError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { MAX_TTS_INPUT_CHARS, SpeechSynthesisResult } from './types.js';

const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICE = 'ash';
const TTS_FORMAT = 'mp3';

const VOICE_INSTRUCTIONS = [
  'Speak in a warm, friendly, and natural conversational tone.',
  'Be clear and articulate but not robotic.',
  'Use appropriate pacing — not too fast, not too slow.',
  'Match the emotional tone of the content being read.',
  'Sound like a helpful, knowledgeable friend.',
].join(' ');

/** Convert an ArrayBuffer to a base64 string. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Call the OpenAI TTS API and return a base64-encoded audio string. */
async function callTtsApi(client: OpenAI, text: string): Promise<string> {
  const response = await client.audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: text,
    response_format: TTS_FORMAT,
    instructions: VOICE_INSTRUCTIONS,
  });
  return arrayBufferToBase64(await response.arrayBuffer());
}

/** Returns true if the error is a non-retryable 4xx client error (excludes 429 rate-limit). */
function isClientError(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

/**
 * Synthesize text to speech using OpenAI gpt-4o-mini-tts.
 * Returns base64-encoded MP3 audio.
 *
 * Retries once on 5xx/network errors; fails immediately on 4xx.
 */
export async function synthesizeSpeech(
  apiKey: string,
  text: string,
  logger: RequestLogger
): Promise<SpeechSynthesisResult> {
  const startTime = Date.now();
  const truncatedText =
    text.length > MAX_TTS_INPUT_CHARS ? text.slice(0, MAX_TTS_INPUT_CHARS) : text;

  logger.log('tts_start', {
    input_chars: text.length,
    truncated: text.length > MAX_TTS_INPUT_CHARS,
  });

  const client = new OpenAI({ apiKey });
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const audioBase64 = await callTtsApi(client, truncatedText);
      const durationMs = Date.now() - startTime;

      logger.log('tts_complete', { output_size: audioBase64.length, duration_ms: durationMs });

      return {
        audio_base64: audioBase64,
        audio_format: 'mp3',
        duration_ms: durationMs,
        input_chars: text.length,
      };
    } catch (error) {
      lastError = error;
      if (isClientError(error)) {
        break;
      }
      if (attempt === 0) {
        logger.warn('tts_retry', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (lastError instanceof AudioSynthesisError) throw lastError;
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  logger.error('tts_error', lastError);
  throw new AudioSynthesisError(`Speech synthesis failed: ${msg}`);
}
