/**
 * Stream-and-retract for the SSE transport (#421).
 *
 * SSE clients get model text as it streams, so time-to-first-token is kept
 * (the reason #478 was reverted in #482: it held every round back until the
 * round was known to be final, which meant nothing streamed at all). When a
 * round that streamed text then turns out to end in tool calls, that text was
 * narration, not the answer, and the orchestrator sends a `retract` frame:
 * "discard all progress text since the turn started or since the last
 * retract". The turn's `responses` then carry only what was streamed after
 * the last retract, so `complete` and saved history match what the client is
 * left showing.
 *
 * Only a transport that wires `StreamCallbacks.onRetract` gets this. The
 * callback/webhook transport never does: gateways 400 on unknown event types,
 * and their narration is deliberately unchanged (Ian, #421, 2026-11-11).
 */

import type { RetractNotice, StreamCallbacks } from '../../types/engine.js';

/** Per-turn retract bookkeeping. Absent (null) on transports without `onRetract`. */
export interface RetractState {
  /** `progress` characters sent since the turn started or the last retract. */
  pendingChars: number;
  /** Index into the turn's `responses` where the text the client still shows begins. */
  visibleStart: number;
  /** The transport's retract sink. */
  send: (retract: RetractNotice) => void;
}

/**
 * Build the retract state for a turn, and the callbacks the orchestrator must
 * use so every `progress` character is counted. Returns the callbacks
 * untouched (and no state) when the transport cannot retract.
 */
export function withRetractTracking(callbacks: StreamCallbacks | undefined): {
  callbacks: StreamCallbacks | undefined;
  retract: RetractState | null;
} {
  const onRetract = callbacks?.onRetract;
  if (!callbacks || !onRetract) return { callbacks, retract: null };
  const retract: RetractState = { pendingChars: 0, visibleStart: 0, send: onRetract };
  const onProgress = callbacks.onProgress;
  return {
    retract,
    callbacks: {
      ...callbacks,
      onProgress: (text: string) => {
        retract.pendingChars += text.length;
        return onProgress(text);
      },
    },
  };
}

/** Where the text the client still shows begins (0 when nothing can be retracted). */
export function visibleStartOf(retract: RetractState | null): number {
  return retract?.visibleStart ?? 0;
}
