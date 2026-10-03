// Where a recorded take goes on the song's timeline.

export interface Placement {
  /** First sample of the take to copy. */
  srcStart: number;
  /** Song frame it is copied to. */
  dstStart: number;
  /** How many samples to copy (may be 0). */
  count: number;
}

/**
 * `startPos` is the song frame the playhead was at when recording began; `latencyFrames` is the round-trip
 * delay to take off (see latency.ts); `punchEnd`, when punching in on a loop, is the frame recording must
 * not run past. A take that would start before the song's beginning has its lead-in dropped instead.
 */
export function placeTake(takeLen: number, startPos: number, latencyFrames: number, songLen: number, punchEnd: number | null = null): Placement {
  const start = Math.min(songLen, Math.max(0, startPos));
  const dst = start - Math.max(0, latencyFrames);
  const srcStart = dst < 0 ? -dst : 0;
  const dstStart = Math.max(0, dst);
  let count = Math.min(takeLen - srcStart, songLen - dstStart);
  if (punchEnd != null) count = Math.min(count, punchEnd - dstStart);
  return { srcStart, dstStart, count: Math.max(0, count) };
}

/** A copy of a take moved by `frames` (positive = later, negative = earlier), same length, silence filling the gap. */
export function shiftTake(data: Float32Array[], frames: number): Float32Array[] {
  return data.map((ch) => {
    const out = new Float32Array(ch.length);
    const n = Math.round(frames);
    if (n >= 0) out.set(ch.subarray(0, Math.max(0, ch.length - n)), Math.min(n, ch.length));
    else out.set(ch.subarray(Math.min(-n, ch.length)));
    return out;
  });
}
