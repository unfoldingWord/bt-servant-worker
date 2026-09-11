/**
 * Audio service type definitions for STT (Speech-to-Text) and TTS (Text-to-Speech)
 */

import type { VoiceFormat } from '../../types/engine.js';

export interface TranscriptionResult {
  text: string;
  duration_ms: number;
}

export interface SpeechSynthesisResult {
  audio_base64: string;
  audio_bytes: Uint8Array;
  audio_format: VoiceFormat;
  duration_ms: number;
  input_chars: number;
}

/**
 * Per-format R2 key extension and content type for outbound TTS audio.
 * Distinct from the inbound-STT format machinery below — the outbound set is
 * what OpenAI TTS can synthesize and gateways can render, not what STT accepts.
 *
 * OpenAI's 'opus' output is Ogg-encapsulated (hence `audio/ogg`); its 'aac'
 * output is a raw ADTS stream (`audio/aac`), which Signal clients render as a
 * native inline voice bubble.
 */
export function voiceFormatSpec(format: VoiceFormat): { extension: string; contentType: string } {
  switch (format) {
    case 'opus':
      return { extension: 'opus', contentType: 'audio/ogg' };
    case 'aac':
      return { extension: 'aac', contentType: 'audio/aac' };
  }
}

export const SUPPORTED_AUDIO_FORMATS = ['ogg', 'mp3', 'wav', 'webm', 'flac', 'm4a', 'aac'] as const;
export type AudioFormat = (typeof SUPPORTED_AUDIO_FORMATS)[number];

/**
 * Map canonical IANA MIME types (and a few widely-seen variants) to the bare
 * `AudioFormat` extension used internally. The MIME subtype does not always
 * match the file extension — `mp3` is `audio/mpeg`, `m4a` is `audio/mp4`,
 * etc. — so a plain `audio/<ext>` strip is not sufficient.
 */
const MIME_TO_BARE_EXTENSION: ReadonlyMap<string, AudioFormat> = new Map([
  ['audio/ogg', 'ogg'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'], // not IANA, but widely sent in the wild
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/webm', 'webm'],
  ['audio/flac', 'flac'],
  ['audio/x-flac', 'flac'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/aac', 'aac'],
]);

const SUPPORTED_AUDIO_FORMATS_SET: ReadonlySet<string> = new Set(SUPPORTED_AUDIO_FORMATS);

/**
 * Normalise an inbound `audio_format` value to its bare extension. Accepts:
 *  - the bare extension form (`ogg`, `mp3`, `m4a`, …),
 *  - the canonical IANA MIME form (`audio/ogg`, `audio/mpeg`, `audio/mp4`, …),
 *  - common non-canonical MIME variants seen in the wild (`audio/mp3`,
 *    `audio/x-wav`, `audio/x-m4a`, …).
 *
 * Comparison is case-insensitive per RFC 6838. Returns null when the format
 * is not recognised so callers can throw a single, accurate error.
 */
export function normalizeAudioFormat(format: string): AudioFormat | null {
  const lower = format.toLowerCase();
  if (SUPPORTED_AUDIO_FORMATS_SET.has(lower)) {
    return lower as AudioFormat;
  }
  return MIME_TO_BARE_EXTENSION.get(lower) ?? null;
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
