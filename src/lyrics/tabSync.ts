// Timing for the Scratchpad's Tab pane ("tab+"): unlike lyrics, tab has no one-line-per-moment
// structure (a "line" is one string's row within a stacked block, and several bars usually run
// together on one long unwrapped line), so it's synced by tapping a handful of anchors — character
// offset in the raw tab text, paired with a playback time — while listening, then interpolating
// between them for everything in between. Pure functions, no browser needed.

export interface TabAnchor {
  /** Index into the raw tab text (can land mid-surrogate-pair in theory; tab text is ASCII in practice). */
  charOffset: number;
  /** Seconds into the song. */
  time: number;
}

/** Fewer anchors than this and there isn't a meaningful span to interpolate within. */
export const MIN_ANCHORS = 2;

/** Anchors in time order, de-duplicated by charOffset (a re-tap at the same spot replaces the old
 * time rather than adding a second point, which would make the interpolation ambiguous there). */
export function addAnchor(anchors: TabAnchor[], next: TabAnchor): TabAnchor[] {
  const out = anchors.filter((a) => a.charOffset !== next.charOffset);
  out.push(next);
  return out.sort((a, b) => a.charOffset - b.charOffset);
}

/** The character offset "sounding" at time `t`, linearly interpolated between the two anchors either
 * side of it (by time, not by their order in the text — a repeated section can be tapped out of
 * character order). Clamped to the first/last anchor's position outside their time range. Null with
 * fewer than MIN_ANCHORS anchors: not enough to interpolate, nothing to show. */
export function charOffsetAt(anchors: TabAnchor[], t: number): number | null {
  if (anchors.length < MIN_ANCHORS) return null;
  const byTime = [...anchors].sort((a, b) => a.time - b.time);
  if (t <= byTime[0].time) return byTime[0].charOffset;
  if (t >= byTime[byTime.length - 1].time) return byTime[byTime.length - 1].charOffset;
  let lo = 0;
  let hi = byTime.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (byTime[mid].time <= t) lo = mid;
    else hi = mid;
  }
  const a = byTime[lo];
  const b = byTime[hi];
  const span = b.time - a.time;
  const frac = span > 0 ? (t - a.time) / span : 0;
  return a.charOffset + (b.charOffset - a.charOffset) * frac;
}

/** Row/column (0-based) of a possibly-fractional character offset within monospace text, for
 * positioning a cursor overlay. The fractional part carries into a fractional column, for a smooth
 * sweep rather than a per-character stutter. */
export function rowCol(text: string, charOffset: number): { row: number; col: number } {
  const clamped = Math.max(0, Math.min(text.length, charOffset));
  const whole = Math.floor(clamped);
  const before = text.slice(0, whole).split('\n');
  const row = before.length - 1;
  const col = before[row].length + (clamped - whole);
  return { row, col };
}
