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
  /** A locked tap can't be dragged, re-tapped over or removed until it is unlocked. */
  locked?: boolean;
}

/** Fewer anchors than this and there isn't a meaningful span to interpolate within. */
export const MIN_ANCHORS = 2;

/** Anchors in time order, de-duplicated by charOffset (a re-tap at the same spot replaces the old
 * time rather than adding a second point, which would make the interpolation ambiguous there). */
export function addAnchor(anchors: TabAnchor[], next: TabAnchor): TabAnchor[] {
  if (isLockedAt(anchors, next.charOffset)) return anchors;
  const out = anchors.filter((a) => a.charOffset !== next.charOffset);
  out.push(next);
  return out.sort((a, b) => a.charOffset - b.charOffset);
}

export function isLockedAt(anchors: TabAnchor[], charOffset: number): boolean {
  return anchors.some((a) => a.charOffset === charOffset && a.locked);
}

/** Moves one tap to a new time (a locked tap stays put). */
export function moveAnchor(anchors: TabAnchor[], charOffset: number, time: number): TabAnchor[] {
  return anchors.map((a) => (a.charOffset === charOffset && !a.locked ? { ...a, time } : a));
}

export function toggleAnchorLock(anchors: TabAnchor[], charOffset: number): TabAnchor[] {
  return anchors.map((a) => {
    if (a.charOffset !== charOffset) return a;
    const { locked: _was, ...rest } = a;
    return a.locked ? rest : { ...rest, locked: true };
  });
}

/** Removes one tap (a locked tap stays). */
export function removeAnchor(anchors: TabAnchor[], charOffset: number): TabAnchor[] {
  return anchors.filter((a) => a.charOffset !== charOffset || a.locked);
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
//
// Not every column is time, though: the row label ("e|"), bar lines and the second digit of a
// two-digit fret take space on the page but no time in the music. Those columns are zero-width in
// the coordinate, so the highlight doesn't dawdle across them. (What can't be known from the text is
// a note that is held longer than its spacing suggests; taps in between correct for that.)

export interface TabBlock {
  firstRow: number;
  lastRow: number;
  /** Time-coordinate where this block starts (the widths of the blocks before it, summed). */
  start: number;
  /** Time-width of the block (its columns that count as time). */
  width: number;
  /** Visual columns in the block (its longest row). */
  chars: number;
  /** How many leading columns are the row label ("e|"). */
  label: number;
  /** cum[j] = time-coordinate at visual column j, for j = 0..chars. */
  cum: number[];
  /** counts[j] = whether visual column j is a time column. */
  counts: boolean[];
  /** barLine[j] = whether visual column j is a bar line. */
  barLine: boolean[];
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** Length of a row's label, i.e. up to and including the first '|' when only a short string name precedes it. */
function labelLength(line: string): number {
  const p = line.indexOf('|');
  return p >= 0 && p <= 3 && /^[A-Za-z#0-9 ]*$/.test(line.slice(0, p)) ? p + 1 : 0;
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
    while (j < lines.length && lines[j].trim()) j++;
    const rows = lines.slice(i, j);
    const chars = Math.max(...rows.map((r) => r.length));
    const label = Math.max(...rows.map(labelLength));
    const counts: boolean[] = [];
    const barLine: boolean[] = [];
    for (let c = 0; c < chars; c++) {
      const bar = rows.some((r) => r[c] === '|');
      const continuation = rows.some((r) => isDigit(r[c]) && isDigit(r[c - 1]));
      counts.push(c >= label && !bar && !continuation);
      barLine.push(c >= label && bar);
    }
    const cum = [0];
    for (let c = 0; c < chars; c++) cum.push(cum[c] + (counts[c] ? 1 : 0));
    const width = cum[chars];
    blocks.push({ firstRow: i, lastRow: j - 1, start, width, chars, label, cum, counts, barLine });
    start += width;
    i = j;
  }
  return blocks;
}

/** The time-coordinate of a character offset, whichever string row it is in. An offset in a blank line
 * snaps to the start of the next block (or the end of the last). Null if there is no tab at all. */
export function offsetToCoord(text: string, blocks: TabBlock[], charOffset: number): number | null {
  if (!blocks.length) return null;
  const { row, col } = rowCol(text, charOffset);
  const b = blocks.find((k) => row <= k.lastRow);
  if (!b) return blocks[blocks.length - 1].start + blocks[blocks.length - 1].width;
  if (row < b.firstRow) return b.start;
  const j = Math.min(b.chars, Math.floor(col));
  return b.start + b.cum[j] + (j < b.chars && b.counts[j] ? col - j : 0);
}

/** Where a time-coordinate sits: which block (as its first/last rows) and how far across it, in
 * visual columns (so it can be drawn where it belongs on the page, skipping bar lines and labels). */
export function coordToPlace(blocks: TabBlock[], coord: number): { firstRow: number; lastRow: number; col: number } | null {
  if (!blocks.length) return null;
  const c = Math.max(0, coord);
  const b = blocks.find((k) => c < k.start + k.width) ?? blocks[blocks.length - 1];
  const local = Math.min(b.width, c - b.start);
  for (let j = 0; j < b.chars; j++) {
    if (b.counts[j] && local >= b.cum[j] && local < b.cum[j] + 1) return { firstRow: b.firstRow, lastRow: b.lastRow, col: j + (local - b.cum[j]) };
  }
  // At (or past) the very end of the block: just after its last time column.
  let last = b.chars - 1;
  while (last > 0 && !b.counts[last]) last--;
  return { firstRow: b.firstRow, lastRow: b.lastRow, col: last + 1 };
}

/** The taps as time-coordinates (see above), for repeated use without redoing the block layout each frame. */
export function anchorCoords(text: string, blocks: TabBlock[], anchors: TabAnchor[]): TabAnchor[] {
  const coords: TabAnchor[] = [];
  for (const a of anchors) {
    const c = offsetToCoord(text, blocks, a.charOffset);
    if (c !== null) coords.push({ charOffset: c, time: a.time });
  }
  return coords;
}

/** Everything together: where in the tab is time `t`, given the taps. Null with too few taps or no tab. */
export function tabPositionAt(text: string, anchors: TabAnchor[], t: number) {
  const blocks = tabBlocks(text);
  const coord = charOffsetAt(anchorCoords(text, blocks, anchors), t);
  return coord === null ? null : coordToPlace(blocks, coord);
}

// ---- scroll strip ---------------------------------------------------------------------------------
// The same blocks laid out as one long line per string: labels pinned separately, the rest of each
// row joined end to end. The music's position is then one x that only ever increases.

export interface StripLayout {
  /** One label per string row ("e|"), from the first block. */
  labels: string[];
  /** One long line per string row. */
  rows: string[];
  /** A line of bar numbers, each placed at the column where its bar starts. */
  header: string;
  /** Strip column where each block's content begins. */
  startOf: number[];
}

/** `pad` columns of empty string are added before and after, so the strings run on unbroken from the
 * labels to the first note and out past the last one. Bar numbers count up through the whole tab. */
export function stripLayout(text: string, blocks: TabBlock[], pad = 0): StripLayout {
  const lines = text.split('\n');
  const nRows = blocks.length ? Math.max(...blocks.map((b) => b.lastRow - b.firstRow + 1)) : 0;
  const labels: string[] = [];
  const rows: string[] = [];
  const startOf: number[] = [];
  let at = pad;
  for (const b of blocks) {
    startOf.push(at);
    at += b.chars - b.label;
  }
  for (let k = 0; k < nRows; k++) {
    labels.push(blocks.length ? (lines[blocks[0].firstRow + k] ?? '').padEnd(blocks[0].label).slice(0, blocks[0].label) : '');
    rows.push('-'.repeat(pad) + blocks.map((b) => (lines[b.firstRow + k] ?? '').padEnd(b.chars).slice(b.label)).join('') + '-'.repeat(pad));
  }
  const header = Array.from({ length: at + pad }, () => ' ');
  let n = 0;
  blocks.forEach((b, bi) => {
    let pending = true;
    for (let j = b.label; j < b.chars; j++) {
      if (b.barLine[j]) pending = true;
      else if (b.counts[j] && pending) {
        pending = false;
        const col = startOf[bi] + (j - b.label);
        [...String(++n)].forEach((ch, i) => {
          if (col + i < header.length) header[col + i] = ch;
        });
      }
    }
  });
  return { labels, rows, header: header.join(''), startOf };
}

/** The strip column (fractional) for a time-coordinate. Each time column carries the zero-width
 * columns that follow it (a bar line, a second fret digit), so the strip moves at a steady speed and
 * arrives at each note exactly on its time rather than lurching across a bar line. */
export function coordToStripX(blocks: TabBlock[], layout: StripLayout, coord: number): number {
  if (!blocks.length) return 0;
  const c = Math.max(0, coord);
  let idx = blocks.findIndex((k) => c < k.start + k.width);
  if (idx < 0) idx = blocks.length - 1;
  const b = blocks[idx];
  const local = Math.min(b.width, c - b.start);
  for (let j = b.label; j < b.chars; j++) {
    if (!b.counts[j] || local < b.cum[j] || local >= b.cum[j] + 1) continue;
    let z = 0;
    while (j + 1 + z < b.chars && !b.counts[j + 1 + z]) z++;
    return layout.startOf[idx] + (j - b.label) + (local - b.cum[j]) * (1 + z);
  }
  return layout.startOf[idx] + (b.chars - b.label);
}
