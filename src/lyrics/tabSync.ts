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

// ---- column space --------------------------------------------------------------------------------
// Interpolating over raw character offsets is wrong for real tab: a stacked block's six string-rows
// are six runs of text, so an offset that runs from the first row's start to the last row's end sweeps
// the cursor across the block six times over. What matters is the *column* — how far along the music
// you are — regardless of which string row you clicked. So the text is treated as a row of blocks
// (runs of non-blank lines) laid end to end, and every position is a single column coordinate.

export interface TabBlock {
  firstRow: number;
  lastRow: number;
  /** Column coordinate where this block starts (the widths of the blocks before it, summed). */
  start: number;
  /** Width of its longest row. */
  width: number;
}

export function tabBlocks(text: string): TabBlock[] {
  const lines = text.split('\n');
  const blocks: TabBlock[] = [];
  let start = 0;
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    let j = i;
    let width = 0;
    while (j < lines.length && lines[j].trim()) width = Math.max(width, lines[j++].length);
    blocks.push({ firstRow: i, lastRow: j - 1, start, width });
    start += width;
    i = j;
  }
  return blocks;
}

/** The column coordinate of a character offset, whichever string row it is in. An offset in a blank
 * line snaps to the start of the next block (or the end of the last). Null if there is no tab at all. */
export function offsetToCoord(text: string, blocks: TabBlock[], charOffset: number): number | null {
  if (!blocks.length) return null;
  const { row, col } = rowCol(text, charOffset);
  const b = blocks.find((k) => row <= k.lastRow);
  if (!b) return blocks[blocks.length - 1].start + blocks[blocks.length - 1].width;
  if (row < b.firstRow) return b.start;
  return b.start + Math.min(col, b.width);
}

/** Where a column coordinate sits: which block (as its first/last rows) and how far across it. */
export function coordToPlace(blocks: TabBlock[], coord: number): { firstRow: number; lastRow: number; col: number } | null {
  if (!blocks.length) return null;
  const c = Math.max(0, coord);
  const b = blocks.find((k) => c < k.start + k.width) ?? blocks[blocks.length - 1];
  return { firstRow: b.firstRow, lastRow: b.lastRow, col: Math.min(b.width, c - b.start) };
}

/** Everything together: where in the tab is time `t`, given the taps. Null with too few taps or no tab. */
export function tabPositionAt(text: string, anchors: TabAnchor[], t: number) {
  const blocks = tabBlocks(text);
  const coords: TabAnchor[] = [];
  for (const a of anchors) {
    const c = offsetToCoord(text, blocks, a.charOffset);
    if (c !== null) coords.push({ charOffset: c, time: a.time });
  }
  const coord = charOffsetAt(coords, t);
  return coord === null ? null : coordToPlace(blocks, coord);
}
