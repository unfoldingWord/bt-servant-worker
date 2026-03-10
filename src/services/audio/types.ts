/**
 * Audio service type definitions for STT (Speech-to-Text) and TTS (Text-to-Speech)
 */

export interface TranscriptionResult {
  text: string;
  duration_ms: number;
}

export interface SpeechSynthesisResult {
  audio_base64: string;
  audio_format: 'mp3';
  duration_ms: number;
  input_chars: number;
}

export const SUPPORTED_AUDIO_FORMATS = ['ogg', 'mp3', 'wav', 'webm', 'flac', 'm4a'] as const;
export type AudioFormat = (typeof SUPPORTED_AUDIO_FORMATS)[number];

/** 25 MB max audio size in bytes */
export const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024;

/** Max characters for TTS input (Deepgram Aura-2 practical limit) */
export const MAX_TTS_INPUT_CHARS = 10_000;
