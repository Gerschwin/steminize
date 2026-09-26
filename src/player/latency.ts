// Measuring the round-trip audio delay (output to speakers or cable, back in through the input).
//
// A take is recorded in real time while the song plays. What you hear is late by the output latency,
// so you play late by that much, and the recording is late again by the input latency: the take lands
// behind the song by the round trip. Playing clicks at known frames and finding when they arrive in
// the input measures exactly that delay, which recording then subtracts.

/** Frames of the click burst window searched after each click was scheduled, in seconds. */
const SEARCH_S = 0.6;
/** Noise floor is measured over this stretch just before each click, in seconds. */
const QUIET_S = 0.25;

export interface LatencyResult {
  ms: number;
  /** How many of the clicks were found consistently. */
  hits: number;
  total: number;
}

/**
 * `input` holds mono samples whose first sample is frame `inputStartFrame`; `clickFrames` are the frames
 * the clicks were scheduled to play at. Returns the median delay, or null if the clicks weren't heard
 * clearly and consistently (too quiet, no path from output to input, or too noisy).
 */
export function detectLatency(input: Float32Array, inputStartFrame: number, clickFrames: number[], sr: number): LatencyResult | null {
  const delays: number[] = [];
  for (const click of clickFrames) {
    const at = click - inputStartFrame;
    const quietFrom = Math.max(0, at - Math.round(QUIET_S * sr));
    const quietTo = Math.max(0, at - Math.round(0.02 * sr));
    const end = Math.min(input.length, at + Math.round(SEARCH_S * sr));
    if (at < 0 || quietTo <= quietFrom || end <= at) continue;
    let peakNoise = 0;
    for (let i = quietFrom; i < quietTo; i++) peakNoise = Math.max(peakNoise, Math.abs(input[i]));
    const threshold = Math.max(0.02, peakNoise * 4);
    for (let i = at; i < end - 3; i++) {
      // Two of the next three samples also above the threshold, so one stray spike isn't taken for the click.
      if (Math.abs(input[i]) > threshold && Math.abs(input[i + 1]) + Math.abs(input[i + 2]) + Math.abs(input[i + 3]) > threshold * 1.5) {
        delays.push(i - at);
        break;
      }
    }
  }
  if (delays.length < 2) return null;
  delays.sort((a, b) => a - b);
  const median = delays[Math.floor(delays.length / 2)];
  // The delay of a real audio path barely changes from click to click; wildly different readings mean
  // we were hearing something else.
  const consistent = delays.filter((d) => Math.abs(d - median) <= 0.006 * sr);
  if (consistent.length < 2 || consistent.length < delays.length * 0.6) return null;
  return { ms: Math.round((median / sr) * 1000), hits: consistent.length, total: clickFrames.length };
}
