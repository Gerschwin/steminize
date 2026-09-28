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
// Not every column is time, though: the row label ("e|"), bar lines, the second digit of a
// two-digit fret and the b/r/target of a bend take space on the page but no time in the music.
// (Slides, hammer-ons and vibrato keep their columns: authors usually space those out in time.) Those columns are zero-width in
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
  /** Set when the block has a rhythm line under its strings: the notes and rests with their exact lengths. */
  events?: RhythmEvent[];
  /** Index (into the text's lines) of the rhythm line, if any. */
  rhythmRow?: number;
}

/** A note or rest in a block with a rhythm line. Times are in sixteenth notes from the start of the block. */
export interface RhythmEvent {
  col: number;
  u: number;
  d: number;
  rest: boolean;
}

/** Length in sixteenth notes of each rhythm letter (upper case is a rest of that length). */
const RHYTHM_UNITS: Record<string, number> = { w: 16, h: 8, q: 4, e: 2, s: 1, t: 0.5 };
export const isRhythmRow = (line: string) => /^[ whqestWHQEST.]*$/.test(line) && /[whqestWHQEST]/.test(line);

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** Length of a row's label, i.e. up to and including the first '|' when only a short string name precedes it. */
function labelLength(line: string): number {
  const p = line.indexOf('|');
  return p >= 0 && p <= 3 && /^[A-Za-z#0-9 ]*$/.test(line.slice(0, p)) ? p + 1 : 0;
}

/** Builds the notes and rests of a block from its rhythm line. A note column with no letter of its own
 * repeats the last length used (so `e` once at the start of a bar makes every note in it an eighth); an
 * upper-case letter on its own is a rest. Times count up through the block, each bar as long as its
 * events add up to (an empty bar repeats the previous bar's length). */
function rhythmEvents(line: string, noteCol: boolean[], barLine: boolean[], label: number, chars: number): RhythmEvent[] {
  const events: RhythmEvent[] = [];
  let u = 0;
  let lastLen = 2; // eighths, until told otherwise
  let prevBar = 16;
  let col = label;
  while (col < chars) {
    // one bar: from here to the next bar line
    let end = col;
    while (end < chars && !barLine[end]) end++;
    const cols: number[] = [];
    for (let c = col; c < end; c++) if (noteCol[c] || RHYTHM_UNITS[(line[c] ?? '').toLowerCase()] !== undefined) cols.push(c);
    let bar = 0;
    for (const c of cols) {
      const ch = line[c] ?? '';
      const base = RHYTHM_UNITS[ch.toLowerCase()];
      let d = lastLen;
      if (base !== undefined) {
        d = base * (line[c + 1] === '.' ? 1.5 : 1);
        lastLen = d;
      }
      const rest = base !== undefined && ch !== ch.toLowerCase() && !noteCol[c];
      events.push({ col: c, u: u + bar, d, rest });
      bar += d;
    }
    if (!cols.length) {
      // a bar of nothing but dashes: one bar of silence, as long as the last one
      if (end > col) {
        events.push({ col, u, d: prevBar, rest: true });
        bar = prevBar;
      }
    } else prevBar = bar;
    u += bar;
    col = end + 1;
  }
  return events;
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
    const allRows = lines.slice(i, j);
    // A rhythm line is the last line of the block, under the strings: only rhythm letters and spaces.
    const rhythmLine = allRows.length >= 2 && isRhythmRow(allRows[allRows.length - 1]) ? allRows[allRows.length - 1] : undefined;
    const rows = rhythmLine === undefined ? allRows : allRows.slice(0, -1);
    const chars = Math.max(...allRows.map((r) => r.length));
    const label = Math.max(...rows.map(labelLength));
    const counts: boolean[] = [];
    const barLine: boolean[] = [];
    const noteCol: boolean[] = [];
    for (let c = 0; c < chars; c++) {
      const bar = rows.some((r) => r[c] === '|');
      // A column takes no time when it only carries the extra characters of a single note: the second
      // digit of a two-digit fret, or a bend/release ("7b9r7" is one note, bent and let down): the b/r,
      // the target number, brackets. But if any string starts a real note in the same column, it does.
      let extra = false;
      let note = false;
      for (const r of rows) {
        const ch = r[c];
        if (ch === undefined) continue;
        const prev = r[c - 1];
        if (ch === 'b' || ch === 'r' || ch === '(' || ch === ')' || ch === '^' || (isDigit(ch) && (isDigit(prev) || prev === 'b' || prev === 'r'))) extra = true;
        else if (isDigit(ch) || ch === 'x' || ch === 'X') note = true;
      }
      counts.push(c >= label && !bar && !(extra && !note));
      barLine.push(c >= label && bar);
      noteCol.push(c >= label && !bar && note);
    }
    const cum = [0];
    for (let c = 0; c < chars; c++) cum.push(cum[c] + (counts[c] ? 1 : 0));
    let width = cum[chars];
    const block: TabBlock = { firstRow: i, lastRow: j - 1, start, width, chars, label, cum, counts, barLine };
    if (rhythmLine !== undefined) {
      block.events = rhythmEvents(rhythmLine, noteCol, barLine, label, chars);
      block.rhythmRow = j - 1;
      const last = block.events[block.events.length - 1];
      width = last ? last.u + last.d : 0;
      block.width = width;
    }
    blocks.push(block);
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
  if (b.events) return b.start + colToUnits(b, col);
  const j = Math.min(b.chars, Math.floor(col));
  return b.start + b.cum[j] + (j < b.chars && b.counts[j] ? col - j : 0);
}

/** For a block with a rhythm line: how far into it (in sixteenths) a visual column is. */
function colToUnits(b: TabBlock, col: number): number {
  const ev = b.events!;
  if (!ev.length || col <= ev[0].col) return 0;
  for (let i = 0; i < ev.length; i++) {
    const next = i + 1 < ev.length ? ev[i + 1].col : b.chars;
    if (col < next) return ev[i].u + ev[i].d * ((col - ev[i].col) / (next - ev[i].col));
  }
  return b.width;
}

/** The reverse: the visual column (fractional) a time within a rhythm block sits at. */
function unitsToCol(b: TabBlock, local: number): number {
  const ev = b.events!;
  if (!ev.length) return b.label;
  for (let i = 0; i < ev.length; i++) {
    if (local < ev[i].u + ev[i].d) {
      const next = i + 1 < ev.length ? ev[i + 1].col : b.chars;
      return ev[i].col + ((local - ev[i].u) / ev[i].d) * (next - ev[i].col);
    }
  }
  return b.chars;
}

/** Where a time-coordinate sits: which block (as its first/last rows) and how far across it, in
 * visual columns (so it can be drawn where it belongs on the page, skipping bar lines and labels). */
export function coordToPlace(blocks: TabBlock[], coord: number): { firstRow: number; lastRow: number; col: number } | null {
  if (!blocks.length) return null;
  const c = Math.max(0, coord);
  const b = blocks.find((k) => c < k.start + k.width) ?? blocks[blocks.length - 1];
  const local = Math.min(b.width, c - b.start);
  if (b.events) return { firstRow: b.firstRow, lastRow: b.lastRow, col: unitsToCol(b, local) };
  for (let j = 0; j < b.chars; j++) {
    if (b.counts[j] && local >= b.cum[j] && local < b.cum[j] + 1) return { firstRow: b.firstRow, lastRow: b.lastRow, col: j + (local - b.cum[j]) };
  }
  // At (or past) the very end of the block: just after its last time column.
  let last = b.chars - 1;
  while (last > 0 && !b.counts[last]) last--;
  return { firstRow: b.firstRow, lastRow: b.lastRow, col: last + 1 };
}

// ---- notes ----------------------------------------------------------------------------------------

export interface TabNote {
  block: number;
  /** 0 = the top string row. */
  string: number;
  /** The fret, or null for a dead note (x). */
  fret: number | null;
  /** MIDI pitch in standard tuning (or standard bass tuning for four strings); null when not known. */
  midi: number | null;
  /** The visual column it sits in. */
  col: number;
  /** Start, in sixteenth notes from the start of the tab. */
  start: number;
  /** Length in sixteenth notes: exact with a rhythm line, otherwise the gap to the next note. */
  length: number;
}

const OPEN_STRINGS: Record<number, number[]> = { 6: [64, 59, 55, 50, 45, 40], 4: [43, 38, 33, 28] };

/** The tab as a list of notes with pitch and timing, for the staff view and the playing trainer. */
export function parseTab(text: string): TabNote[] {
  const lines = text.split('\n');
  const blocks = tabBlocks(text);
  const notes: TabNote[] = [];
  blocks.forEach((b, bi) => {
    const nStrings = (b.rhythmRow ?? b.lastRow + 1) - b.firstRow;
    const open = OPEN_STRINGS[nStrings];
    const found: TabNote[] = [];
    for (let k = 0; k < nStrings; k++) {
      const line = lines[b.firstRow + k];
      for (let c = b.label; c < line.length; c++) {
        const ch = line[c];
        const prev = line[c - 1];
        const startsNote = (isDigit(ch) && !isDigit(prev) && prev !== 'b' && prev !== 'r') || ch === 'x' || ch === 'X';
        if (!startsNote || b.barLine[c]) continue;
        let fret: number | null = null;
        if (isDigit(ch)) {
          let e = c;
          while (isDigit(line[e + 1])) e++;
          fret = Number(line.slice(c, e + 1));
        }
        const start = b.start + (b.events ? colToUnits(b, c) : b.cum[c]);
        found.push({ block: bi, string: k, fret, midi: open && fret !== null ? open[k] + fret : null, col: c, start, length: 0 });
      }
    }
    // length: from the rhythm line's event when there is one, else up to the next note in the block
    const starts = [...new Set(found.map((n) => n.start))].sort((x, y) => x - y);
    for (const n of found) {
      const ev = b.events?.find((e) => e.col === n.col);
      if (ev) n.length = ev.d;
      else {
        const next = starts.find((x) => x > n.start);
        n.length = next !== undefined ? next - n.start : b.start + b.width - n.start;
      }
    }
    notes.push(...found);
  });
  return notes.sort((x, y) => x.start - y.start || x.string - y.string);
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
  if (b.events) return layout.startOf[idx] + Math.max(0, unitsToCol(b, local) - b.label);
  for (let j = b.label; j < b.chars; j++) {
    if (!b.counts[j] || local < b.cum[j] || local >= b.cum[j] + 1) continue;
    let z = 0;
    while (j + 1 + z < b.chars && !b.counts[j + 1 + z]) z++;
    return layout.startOf[idx] + (j - b.label) + (local - b.cum[j]) * (1 + z);
  }
  return layout.startOf[idx] + (b.chars - b.label);
}
