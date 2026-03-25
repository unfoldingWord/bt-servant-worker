import { describe, it, expect } from 'vitest';
import {
  chunkLargeEvents,
  maybeChunkCompleteEvent,
  splitStringIntoChunks,
  AUDIO_CHUNK_SIZE,
} from '../../src/utils/audio-chunking.js';
import { StoredSSEEvent } from '../../src/types/queue.js';

function makeCompleteEvent(audioBase64: string | null): StoredSSEEvent {
  return {
    event: 'data',
    data: JSON.stringify({
      type: 'complete',
      response: {
        responses: [{ text: 'Hello' }],
        voice_audio_base64: audioBase64,
      },
    }),
  };
}

function makeProgressEvent(): StoredSSEEvent {
  return {
    event: 'data',
    data: JSON.stringify({ type: 'progress', text: 'Thinking...' }),
  };
}

describe('splitStringIntoChunks', () => {
  it('splits a string into chunks of the given size', () => {
    const result = splitStringIntoChunks('abcdefghij', 3);
    expect(result).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('returns a single chunk when string is shorter than size', () => {
    const result = splitStringIntoChunks('abc', 10);
    expect(result).toEqual(['abc']);
  });

  it('handles exact boundary (no remainder)', () => {
    const result = splitStringIntoChunks('abcdef', 3);
    expect(result).toEqual(['abc', 'def']);
  });

  it('handles empty string', () => {
    const result = splitStringIntoChunks('', 3);
    expect(result).toEqual([]);
  });

  it('throws on zero or negative size', () => {
    expect(() => splitStringIntoChunks('abc', 0)).toThrow('size must be positive');
    expect(() => splitStringIntoChunks('abc', -1)).toThrow('size must be positive');
  });
});

describe('maybeChunkCompleteEvent — passthrough', () => {
  it('passes through non-message events unchanged', () => {
    const event: StoredSSEEvent = { event: 'done', data: '{}' };
    expect(maybeChunkCompleteEvent(event)).toEqual([event]);
  });

  it('passes through non-complete message events unchanged', () => {
    const event = makeProgressEvent();
    expect(maybeChunkCompleteEvent(event)).toEqual([event]);
  });

  it('passes through complete events with null audio unchanged', () => {
    const event = makeCompleteEvent(null);
    expect(maybeChunkCompleteEvent(event)).toEqual([event]);
  });

  it('passes through complete events with small audio unchanged', () => {
    const smallAudio = 'a'.repeat(AUDIO_CHUNK_SIZE);
    const event = makeCompleteEvent(smallAudio);
    expect(maybeChunkCompleteEvent(event)).toEqual([event]);
  });

  it('passes through events with unparseable data unchanged', () => {
    const event: StoredSSEEvent = { event: 'data', data: 'not json' };
    expect(maybeChunkCompleteEvent(event)).toEqual([event]);
  });
});

describe('maybeChunkCompleteEvent — splitting', () => {
  it('chunks large audio into stripped complete + audio_chunk events', () => {
    const largeAudio = 'B'.repeat(AUDIO_CHUNK_SIZE * 3);
    const result = maybeChunkCompleteEvent(makeCompleteEvent(largeAudio));

    expect(result).toHaveLength(4);

    const completeParsed = JSON.parse(result[0].data);
    expect(completeParsed.type).toBe('complete');
    expect(completeParsed.response.voice_audio_base64).toBeNull();
    expect(completeParsed.response.responses).toEqual([{ text: 'Hello' }]);

    for (let i = 0; i < 3; i++) {
      const chunk = JSON.parse(result[i + 1].data);
      expect(chunk.type).toBe('audio_chunk');
      expect(chunk.index).toBe(i);
      expect(chunk.total).toBe(3);
      expect(result[i + 1].event).toBe('data');
    }
  });

  it('produces correct chunk metadata (index, total)', () => {
    const result = maybeChunkCompleteEvent(
      makeCompleteEvent('X'.repeat(AUDIO_CHUNK_SIZE * 2 + 500))
    );
    expect(result).toHaveLength(4);
    for (let i = 1; i < result.length; i++) {
      const chunk = JSON.parse(result[i].data);
      expect(chunk.index).toBe(i - 1);
      expect(chunk.total).toBe(3);
    }
  });
});

describe('maybeChunkCompleteEvent — reassembly', () => {
  it('reassembles chunks back into the original audio', () => {
    const originalAudio = 'C'.repeat(AUDIO_CHUNK_SIZE * 3 + 42);
    const result = maybeChunkCompleteEvent(makeCompleteEvent(originalAudio));
    const reassembled = result
      .slice(1)
      .map((e) => JSON.parse(e.data).data)
      .join('');
    expect(reassembled).toBe(originalAudio);
  });

  it('handles audio exactly at chunk boundary + 1', () => {
    const audio = 'Z'.repeat(AUDIO_CHUNK_SIZE + 1);
    const result = maybeChunkCompleteEvent(makeCompleteEvent(audio));

    expect(result).toHaveLength(3);
    const chunk0 = JSON.parse(result[1].data);
    expect(chunk0.data).toHaveLength(AUDIO_CHUNK_SIZE);
    expect(chunk0.total).toBe(2);
    const chunk1 = JSON.parse(result[2].data);
    expect(chunk1.data).toHaveLength(1);
    expect(chunk1.total).toBe(2);
  });
});

describe('chunkLargeEvents', () => {
  it('passes through small events unchanged', () => {
    const events: StoredSSEEvent[] = [
      makeProgressEvent(),
      makeCompleteEvent(null),
      { event: 'done', data: '{}' },
    ];
    expect(chunkLargeEvents(events)).toEqual(events);
  });

  it('does not chunk large non-complete events', () => {
    const largeEvent: StoredSSEEvent = {
      event: 'data',
      data: JSON.stringify({ type: 'progress', text: 'x'.repeat(2_000_000) }),
    };
    expect(chunkLargeEvents([largeEvent])).toEqual([largeEvent]);
  });

  it('chunks only the complete event with large audio in a mixed array', () => {
    const progress = makeProgressEvent();
    const largeComplete = makeCompleteEvent('A'.repeat(AUDIO_CHUNK_SIZE * 2));
    const done: StoredSSEEvent = { event: 'done', data: '{}' };

    const result = chunkLargeEvents([progress, largeComplete, done]);

    // progress + stripped complete + 2 chunks + done = 5
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual(progress);
    expect(JSON.parse(result[1].data).type).toBe('complete');
    expect(JSON.parse(result[1].data).response.voice_audio_base64).toBeNull();
    expect(JSON.parse(result[2].data).type).toBe('audio_chunk');
    expect(JSON.parse(result[3].data).type).toBe('audio_chunk');
    expect(result[4]).toEqual(done);
  });
});
