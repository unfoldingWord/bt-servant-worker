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
/** Abort TTS calls that hang longer than 5 minutes. */
const TTS_TIMEOUT_MS = 5 * 60 * 1000;

const VOICE_INSTRUCTIONS = `Personality/Affect: A knowledgeable and trustworthy guide, providing Scripture readings and translation support with calm confidence.

Voice: Clear, steady, and professional, with a warm and approachable quality, at conversational speaking pace.

Tone: Respectful and engaging, encouraging thoughtful reflection and supporting understanding without distraction.

Dialect: Neutral and standard, avoiding slang or overly casual phrasing; suitable for an international audience.

Pronunciation: Careful and precise, ensuring proper enunciation of biblical names and terms, while remaining natural and fluid.

Features: Uses measured pacing, appropriate pauses, and gentle emphasis to highlight key points. Conveys reverence when reading Scripture and clarity when giving practical instructions.`;

/** Convert an ArrayBuffer to a base64 string. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Read the TTS response, convert to base64, and log each step. */
async function readTtsResponse(
  response: Response,
  logger: RequestLogger,
  attempt: number,
  apiCallStart: number
): Promise<string> {
  logger.log('tts_api_response_received', { attempt, api_call_ms: Date.now() - apiCallStart });

  const arrayBufferStart = Date.now();
  const buffer = await response.arrayBuffer();
  logger.log('tts_arraybuffer_read', {
    attempt,
    buffer_size_bytes: buffer.byteLength,
    read_ms: Date.now() - arrayBufferStart,
  });

  const encodeStart = Date.now();
  const base64 = arrayBufferToBase64(buffer);
  logger.log('tts_base64_encode', {
    attempt,
    base64_length: base64.length,
    encode_ms: Date.now() - encodeStart,
    total_api_to_encode_ms: Date.now() - apiCallStart,
  });

  return base64;
}

/** Call the OpenAI TTS API with abort timeout and return a base64-encoded audio string. */
async function callTtsApi(
  client: OpenAI,
  text: string,
  logger: RequestLogger,
  attempt: number
): Promise<string> {
  const apiCallStart = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  logger.log('tts_api_call_start', {
    attempt,
    model: TTS_MODEL,
    voice: TTS_VOICE,
    format: TTS_FORMAT,
    input_chars: text.length,
    instructions_chars: VOICE_INSTRUCTIONS.length,
    timeout_ms: TTS_TIMEOUT_MS,
  });

  let response;
  try {
    response = await client.audio.speech.create(
      {
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input: text,
        response_format: TTS_FORMAT,
        instructions: VOICE_INSTRUCTIONS,
      },
      { signal: controller.signal }
    );
  } finally {
    clearTimeout(timeout);
  }

  return readTtsResponse(response, logger, attempt, apiCallStart);
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

/** Prepare input text, truncating if necessary, and log diagnostics. */
function prepareInput(text: string, logger: RequestLogger) {
  const truncatedText =
    text.length > MAX_TTS_INPUT_CHARS ? text.slice(0, MAX_TTS_INPUT_CHARS) : text;

  logger.log('tts_start', {
    input_chars: text.length,
    truncated: text.length > MAX_TTS_INPUT_CHARS,
    truncated_to_chars: truncatedText.length,
    chars_dropped: text.length - truncatedText.length,
    max_tts_input_chars: MAX_TTS_INPUT_CHARS,
    text_preview_first_100: text.slice(0, 100),
    text_preview_last_100: text.slice(-100),
  });

  return truncatedText;
}

/** Log a failed attempt and return whether to stop retrying. */
function logAttemptFailure(
  error: unknown,
  attempt: number,
  attemptStart: number,
  overallStart: number,
  logger: RequestLogger
): boolean {
  const isClient = isClientError(error);
  logger.warn('tts_attempt_failed', {
    attempt,
    attempt_ms: Date.now() - attemptStart,
    elapsed_total_ms: Date.now() - overallStart,
    is_client_error: isClient,
    will_retry: attempt === 0 && !isClient,
    error_type: error instanceof Error ? error.constructor.name : typeof error,
    error_message: error instanceof Error ? error.message : String(error),
    status: error instanceof OpenAI.APIError ? error.status : undefined,
  });
  return isClient;
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
  const truncatedText = prepareInput(text, logger);
  const client = new OpenAI({ apiKey });
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptStart = Date.now();
    logger.log('tts_attempt_start', {
      attempt,
      elapsed_since_tts_start_ms: attemptStart - startTime,
    });

    try {
      const audioBase64 = await callTtsApi(client, truncatedText, logger, attempt);
      logger.log('tts_complete', {
        attempt,
        output_size_bytes: audioBase64.length,
        attempt_ms: Date.now() - attemptStart,
        total_ms: Date.now() - startTime,
        input_chars: truncatedText.length,
        original_input_chars: text.length,
        was_truncated: text.length > MAX_TTS_INPUT_CHARS,
      });
      return {
        audio_base64: audioBase64,
        audio_format: 'mp3',
        duration_ms: Date.now() - startTime,
        input_chars: text.length,
      };
    } catch (error) {
      lastError = error;
      if (logAttemptFailure(error, attempt, attemptStart, startTime, logger)) break;
    }
  }

  logger.error('tts_all_attempts_exhausted', lastError, {
    total_ms: Date.now() - startTime,
    input_chars: truncatedText.length,
  });
  if (lastError instanceof AudioSynthesisError) throw lastError;
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new AudioSynthesisError(`Speech synthesis failed: ${msg}`);
}
