/**
 * Audio service type definitions for STT (Speech-to-Text) and TTS (Text-to-Speech)
 */

export interface TranscriptionResult {
  text: string;
  duration_ms: number;
}

export interface SpeechSynthesisResult {
  audio_base64: string;
  audio_bytes: Uint8Array;
  audio_format: 'opus';
  duration_ms: number;
  input_chars: number;
}

export const SUPPORTED_AUDIO_FORMATS = ['ogg', 'mp3', 'wav', 'webm', 'flac', 'm4a'] as const;
export type AudioFormat = (typeof SUPPORTED_AUDIO_FORMATS)[number];

/**
 * Normalise an inbound `audio_format` value to its bare extension. Accepts
 * both bare-extension form (`ogg`) and MIME form (`audio/ogg`) so callers
 * upstream — the Telegram gateway, future SDKs, test harnesses — can use
 * whichever feels natural. Returns null when the format is not in the
 * supported list, so callers can throw a single, accurate error.
 */
export function normalizeAudioFormat(format: string): AudioFormat | null {
  const bare = format.startsWith('audio/') ? format.slice('audio/'.length) : format;
  return (SUPPORTED_AUDIO_FORMATS as readonly string[]).includes(bare)
    ? (bare as AudioFormat)
    : null;
}

/** 25 MB max audio size in bytes */
export const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024;

/** Max characters for TTS input */
export const MAX_TTS_INPUT_CHARS = 10_000;

/** Context for tracking whether audio output has been requested during orchestration */
export interface AudioContext {
  audioRequested: boolean;
  requestAudio: () => void;
}
