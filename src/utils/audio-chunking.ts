/**
 * Audio chunking utilities for DO storage.
 *
 * DO storage (backed by SQLite) has a 2 MB per-value limit. TTS audio in
 * complete events can exceed this. These functions split large audio payloads
 * into separate ~1 MB `audio_chunk` events so each value stays under the limit.
 */

import { StoredSSEEvent } from '../types/queue.js';

/** Maximum size for a single chunk of base64 audio data (1 MB). */
export const AUDIO_CHUNK_SIZE = 1_000_000;

/**
 * Split a string into chunks of at most `size` characters.
 */
export function splitStringIntoChunks(str: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

/**
 * If the event is a `complete` SSE event with a large `voice_audio_base64`,
 * strip the audio from the complete event and return it followed by
 * `audio_chunk` events. Otherwise return the event unchanged.
 */
export function maybeChunkCompleteEvent(event: StoredSSEEvent): StoredSSEEvent[] {
  if (event.event !== 'message') return [event];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return [event];
  }

  if (parsed.type !== 'complete') return [event];

  const response = parsed.response as Record<string, unknown> | undefined;
  if (!response) return [event];

  const audioBase64 = response.voice_audio_base64;
  if (typeof audioBase64 !== 'string' || audioBase64.length <= AUDIO_CHUNK_SIZE) {
    return [event];
  }

  // Strip audio from the complete event
  const strippedResponse = { ...response, voice_audio_base64: null };
  const strippedParsed = { ...parsed, response: strippedResponse };
  const strippedEvent: StoredSSEEvent = {
    event: event.event,
    data: JSON.stringify(strippedParsed),
  };

  // Create audio chunk events
  const chunks = splitStringIntoChunks(audioBase64, AUDIO_CHUNK_SIZE);
  const chunkEvents: StoredSSEEvent[] = chunks.map((chunk, index) => ({
    event: 'message',
    data: JSON.stringify({
      type: 'audio_chunk',
      index,
      total: chunks.length,
      data: chunk,
    }),
  }));

  return [strippedEvent, ...chunkEvents];
}

/**
 * Process an array of events, chunking any large complete events that contain
 * audio payloads exceeding the DO storage per-value limit.
 */
export function chunkLargeEvents(events: StoredSSEEvent[]): StoredSSEEvent[] {
  const result: StoredSSEEvent[] = [];
  for (const event of events) {
    result.push(...maybeChunkCompleteEvent(event));
  }
  return result;
}
