/**
 * OpenAI TTS service using gpt-4o-mini-tts
 */

import OpenAI from 'openai';
import { AudioSynthesisError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { MAX_TTS_INPUT_CHARS, SpeechSynthesisResult } from './types.js';

const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICE = 'ash';
const TTS_FORMAT = 'opus';
/** Abort TTS calls that hang longer than 5 minutes. */
const TTS_TIMEOUT_MS = 5 * 60 * 1000;

const VOICE_INSTRUCTIONS = `Personality/Affect: A knowledgeable and trustworthy guide, providing Scripture readings and translation support with calm confidence.

Voice: Clear, steady, and professional, with a warm and approachable quality, at a brisk and efficient pace — slightly faster than normal conversation.

Tone: Respectful and engaging, encouraging thoughtful reflection and supporting understanding without distraction.

Dialect: Neutral and standard, avoiding slang or overly casual phrasing; suitable for an international audience.

Pronunciation: Careful and precise, ensuring proper enunciation of biblical names and terms, while remaining natural and fluid.

Features: Uses efficient pacing with brief pauses and gentle emphasis to highlight key points. Conveys reverence when reading Scripture and clarity when giving practical instructions. Avoids drawn-out pauses or overly slow delivery.`;

/** Convert a Uint8Array to a base64 string. */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Stream the TTS response body, collecting chunks incrementally. */
async function streamResponseBody(
  response: Response,
  logger: RequestLogger,
  attempt: number
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) throw new AudioSynthesisError('TTS response has no body');

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let chunkCount = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.byteLength;
    chunkCount++;
    if (chunkCount % 10 === 0) {
      logger.log('tts_stream_progress', { attempt, chunks: chunkCount, bytes: totalBytes });
    }
  }

  logger.log('tts_stream_complete', { attempt, total_chunks: chunkCount, total_bytes: totalBytes });

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

interface TtsResponseData {
  audioBytes: Uint8Array;
  audioBase64: string;
}

/** Stream the TTS response, convert to base64, and log each step. */
async function readTtsResponse(
  response: Response,
  logger: RequestLogger,
  attempt: number,
  apiCallStart: number
): Promise<TtsResponseData> {
  logger.log('tts_api_response_received', { attempt, api_call_ms: Date.now() - apiCallStart });

  const streamStart = Date.now();
  const audioBytes = await streamResponseBody(response, logger, attempt);
  logger.log('tts_stream_read', {
    attempt,
    buffer_size_bytes: audioBytes.byteLength,
    read_ms: Date.now() - streamStart,
  });

  const encodeStart = Date.now();
  const audioBase64 = uint8ArrayToBase64(audioBytes);
  logger.log('tts_base64_encode', {
    attempt,
    base64_length: audioBase64.length,
    encode_ms: Date.now() - encodeStart,
    total_api_to_encode_ms: Date.now() - apiCallStart,
  });

  return { audioBytes, audioBase64 };
}

/** Call the OpenAI TTS API with abort timeout and return audio bytes + base64. */
async function callTtsApi(
  client: OpenAI,
  text: string,
  logger: RequestLogger,
  attempt: number
): Promise<TtsResponseData> {
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

/** Strip markdown formatting to produce clean text for TTS. */
export function stripMarkdownForTts(text: string): string {
  let result = text;
  // Remove code blocks (must come before inline code)
  result = result.replace(/```[\s\S]*?```/g, '');
  // Remove headers: "## Title" → "Title"
  result = result.replace(/^#{1,6}\s+/gm, '');
  // Remove bold/italic markers: **text** → text, *text* → text
  result = result.replace(/\*{1,3}(.+?)\*{1,3}/g, '$1');
  result = result.replace(/_{1,3}(.+?)_{1,3}/g, '$1');
  // Remove inline code: `code` → code
  result = result.replace(/`([^`]+)`/g, '$1');
  // Remove image syntax: ![alt](url) → alt (must come before links)
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // Remove link syntax: [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Convert bullet/numbered list markers to plain text
  result = result.replace(/^[\s]*[-*+]\s+/gm, '');
  result = result.replace(/^[\s]*\d+\.\s+/gm, '');
  // Remove horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');
  // Collapse multiple blank lines into a single paragraph break
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

/** Prepare input text, truncating if necessary, and log diagnostics. */
function prepareInput(text: string, logger: RequestLogger) {
  const cleaned = stripMarkdownForTts(text);
  const truncatedText =
    cleaned.length > MAX_TTS_INPUT_CHARS ? cleaned.slice(0, MAX_TTS_INPUT_CHARS) : cleaned;

  logger.log('tts_start', {
    original_input_chars: text.length,
    cleaned_input_chars: cleaned.length,
    chars_stripped: text.length - cleaned.length,
    truncated: cleaned.length > MAX_TTS_INPUT_CHARS,
    truncated_to_chars: truncatedText.length,
    chars_dropped: cleaned.length - truncatedText.length,
    max_tts_input_chars: MAX_TTS_INPUT_CHARS,
    text_preview_first_100: truncatedText.slice(0, 100),
    text_preview_last_100: truncatedText.slice(-100),
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
      const { audioBytes, audioBase64 } = await callTtsApi(client, truncatedText, logger, attempt);
      logger.log('tts_complete', {
        attempt,
        output_size_bytes: audioBytes.byteLength,
        output_base64_length: audioBase64.length,
        attempt_ms: Date.now() - attemptStart,
        total_ms: Date.now() - startTime,
        input_chars: truncatedText.length,
        original_input_chars: text.length,
        was_truncated: text.length > MAX_TTS_INPUT_CHARS,
      });
      return {
        audio_base64: audioBase64,
        audio_bytes: audioBytes,
        audio_format: 'opus',
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
