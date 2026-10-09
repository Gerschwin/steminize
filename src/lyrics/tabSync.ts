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

/** Position at time `t`, computed directly from one anchor and the song's own tempo (BPM) — no
 * interpolation, so nothing can drift the way it might between two taps whose spacing doesn't
 * exactly match the beat. A quarter note is `60 / bpm` seconds, so a sixteenth (the unit `anchor`'s
 * own coordinate and TabNote.start/length are both in) is a quarter of that. `anchor` is expected in
 * the same coordinate space charOffsetAt's own anchors are (i.e. already run through anchorCoords —
 * its own `charOffset` field is actually a coordinate by that point, not a literal text offset). */
export function coordAtBpm(anchor: TabAnchor, bpm: number, t: number): number {
  return anchor.charOffset + (t - anchor.time) * (bpm / 60) * 4;
}

/** The reverse of coordAtBpm / charOffsetAt: the time (seconds) at which the tab reaches position `u`.
 * Null with nothing to go on (no taps, or just one with no tempo known). With one tap and a tempo it's
 * exact; with two or more it's interpolated between the taps either side, the same way charOffsetAt
 * goes the other way. For turning a bar of the tab into a stretch of the song (looping it). */
export function timeAtCoord(anchors: TabAnchor[], bpm: number | undefined, u: number): number | null {
  if (anchors.length === 1 && bpm) return anchors[0].time + ((u - anchors[0].charOffset) * 60) / (bpm * 4);
  if (anchors.length < MIN_ANCHORS) return null;
  const byTime = [...anchors].sort((a, b) => a.time - b.time);
  if (u <= byTime[0].charOffset) return byTime[0].time;
  for (let i = 1; i < byTime.length; i++) {
    const a = byTime[i - 1];
    const b = byTime[i];
    if (u <= b.charOffset) {
      const span = b.charOffset - a.charOffset;
      return span > 0 ? a.time + ((u - a.charOffset) / span) * (b.time - a.time) : a.time;
    }
  }
  return byTime[byTime.length - 1].time;
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
  /** First and last line of the block, annotation lines included. */
  firstRow: number;
  lastRow: number;
  /** First and last line that are actual strings (what `firstRow..lastRow` was before annotation lines existed). */
  stringFirst: number;
  stringLast: number;
  /** Lines of picking/fingering/palm-mute marks written above and below the strings — see annotationTokens. */
  annAbove: number[];
  annBelow: number[];
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
  /** Set by a "4/4"-style line of its own right before the strings: every bar in the block is fixed to
   * exactly this many sixteenth notes, instead of however many time-columns it happens to have — see
   * parseScore. Ignored where there's a rhythm line too: exact event lengths already win over it. */
  timeSig?: number;
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

/** A "4/4"-style time signature on a line of its own (see tabBlocks). */
export const isTimeSigRow = (line: string) => /^\s*\d+\s*\/\s*\d+\s*$/.test(line);

/** A line of picking (D U), fingering (1-4, [1]-[4]) or palm-mute (PM---) marks above or below a block's strings. */
export const isAnnotationRow = (line: string) => /^[ DU123456789x[\]PM-]*$/.test(line) && /[DU1-4]|PM|x[2-9]/.test(line);

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
    let allRows = lines.slice(i, j);
    let firstRow = i;
    // An optional time signature ("4/4"), on its own line right before the strings: fixes every bar in
    // this block to a real musical length instead of however many time-columns it happens to have (see
    // parseScore) — an easier way to get a decent timing estimate than writing out a full rhythm line.
    // Matched only as the block's *entire* first line, so it can't collide with "7/9" (a slide) inside
    // an actual string row, which is never a whole line on its own.
    const sigMatch = allRows.length > 1 && isTimeSigRow(allRows[0]) ? allRows[0].trim().match(/^(\d+)\s*\/\s*(\d+)$/) : null;
    const timeSig = sigMatch ? (Number(sigMatch[1]) * 16) / Number(sigMatch[2]) : undefined;
    if (sigMatch) {
      allRows = allRows.slice(1);
      firstRow += 1;
    }
    // A rhythm line is the last line of the block, under the strings: only rhythm letters and spaces.
    const rhythmLine = allRows.length >= 2 && isRhythmRow(allRows[allRows.length - 1]) ? allRows[allRows.length - 1] : undefined;
    const rowsAll = rhythmLine === undefined ? allRows : allRows.slice(0, -1);
    // Lines of marks (picking, fingering, palm mute) above the first and below the last row that has a
    // bar line in it are annotations, not strings — only ever recognised outside the strings, so a
    // barless row of frets in the middle of a block is still a string. Anything above or below that
    // isn't wholly marks leaves the block exactly as it was read before these existed.
    const hasBar = rowsAll.map((r) => r.includes('|'));
    const firstBar = hasBar.indexOf(true);
    const lastBar = hasBar.lastIndexOf(true);
    let sFirst = 0;
    let sLast = rowsAll.length - 1;
    if (firstBar !== -1) {
      if (firstBar > 0 && rowsAll.slice(0, firstBar).every(isAnnotationRow)) sFirst = firstBar;
      if (lastBar < rowsAll.length - 1 && rowsAll.slice(lastBar + 1).every(isAnnotationRow)) sLast = lastBar;
    }
    const rows = rowsAll.slice(sFirst, sLast + 1);
    const annAbove = rowsAll.slice(0, sFirst).map((_, k) => firstRow + k);
    const annBelow = rowsAll.slice(sLast + 1).map((_, k) => firstRow + sLast + 1 + k);
    // Columns taken by a harmonic marker written right after a fret: "12(h)" natural, "12(ph)" pinch.
    // The marker is part of the note, not time.
    const markerCols = new Set<number>();
    for (const r of rows) for (const m of r.matchAll(/\((?:ph|h)\)/g)) for (let k = 0; k < m[0].length; k++) markerCols.add(m.index! + k);
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
        // (and a repeat sign's asterisk, a "pb" pre-bend's p, a tap's T, harmonic markers — none of them time)
        if (ch === 'b' || ch === 'r' || ch === '(' || ch === ')' || ch === '^' || ch === '*' || markerCols.has(c) || (ch === 'p' && r[c + 1] === 'b') || ((ch === 't' || ch === 'T') && isDigit(r[c + 1])) || (isDigit(ch) && (isDigit(prev) || prev === 'b' || prev === 'r'))) extra = true;
        else if (isDigit(ch) || ch === 'x' || ch === 'X') note = true;
      }
      counts.push(c >= label && !bar && !(extra && !note));
      barLine.push(c >= label && bar);
      noteCol.push(c >= label && !bar && note);
    }
    const cum = [0];
    for (let c = 0; c < chars; c++) cum.push(cum[c] + (counts[c] ? 1 : 0));
    let width = cum[chars];
    const block: TabBlock = { firstRow, lastRow: j - 1, stringFirst: firstRow + sFirst, stringLast: firstRow + sLast, annAbove, annBelow, start, width, chars, label, cum, counts, barLine, timeSig };
    if (rhythmLine !== undefined) {
      block.events = rhythmEvents(rhythmLine, noteCol, barLine, label, chars);
      block.rhythmRow = j - 1;
      const last = block.events[block.events.length - 1];
      width = last ? last.u + last.d : 0;
      block.width = width;
    } else if (timeSig !== undefined) {
      width = barSegments(block).length * timeSig;
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
  /** Which bar it is in, counting through the whole tab from 0 (an index into the bars from parseScore). */
  bar: number;
  /** A bend written `7b9` (fret bent up to `to`), with `release` set when it's let back down (`7b9r7`).
   * `pre` for a pre-bend, written `7pb9` (bent silently to 9 *before* picking), `7pb9r7` released after. */
  bend?: { to: number; release?: number; pre?: boolean };
  /** A harmonic, written straight after the fret: `12(h)` natural, `12(ph)` pinch. */
  harmonic?: 'natural' | 'pinch';
  /** Picking / fingering marks written on a line above or below the strings, lined up with this note:
   * D down-pick, U up-pick, 1-4 left-hand finger, [1]-[4] right-hand finger. */
  marks?: { kind: 'pick' | 'lh' | 'rh'; text: string; above: boolean }[];
  /** Under a palm-mute run (`PM----` on a line above and/or below the strings, over this note): the
   * run's number, one per `PM` written, so two runs side by side stay two runs, and a note can be under
   * a run above and another below at once. */
  pm?: { above?: number; below?: number };
  /** The note is joined to the previous note on the same string by what's written between them: `h`
   * hammer-on, `p` pull-off, `/` slide up, `\` slide down — the previous note can be across a bar line
   * (`5h|7`), in which case this is the first note of its bar. */
  link?: 'h' | 'p' | '/' | '\\';
  /** Vibrato, written `~` (or `v`) straight after the note. */
  vibrato?: boolean;
  /** Tapped with the picking hand, written `t` or `T` straight before the fret. */
  tap?: boolean;
}

/** A bar of the tab: where it starts and how long it is, in sixteenth notes. */
export interface TabBar {
  start: number;
  length: number;
  /** Repeat signs, written as an asterisk right after the opening bar line (`|*`) / right before the closing one (`*|`). */
  repeatStart?: boolean;
  repeatEnd?: boolean;
  /** How many times the section plays in all (`x3` on a line above/below the strings, over the bar that ends it); two when not written. */
  repeatCount?: number;
}

const OPEN_STRINGS: Record<number, number[]> = { 6: [64, 59, 55, 50, 45, 40], 4: [43, 38, 33, 28] };

/** The column ranges [from, to) of each bar in a block: what lies between its bar lines. */
export function barSegments(b: TabBlock): [number, number][] {
  const segs: [number, number][] = [];
  let from = b.label;
  for (let c = b.label; c <= b.chars; c++) {
    if (c === b.chars || b.barLine[c]) {
      if (c > from && (b.counts.slice(from, c).some(Boolean) || b.events?.some((e) => e.col >= from && e.col < c))) segs.push([from, c]);
      from = c + 1;
    }
  }
  return segs;
}

/** The playing techniques written around the fret that starts at `c` in one string's row: what's
 * between it and the previous note (`h` `p` `/` `\`), a bend (`7b9`, released `7b9r7`; pre-bend `7pb9`,
 * released `7pb9r7`), a harmonic marker (`12(h)`, `12(ph)`), `~`/`v` vibrato straight after, `t`/`T`
 * straight before for a tap. Read only — they change how the note is drawn, not when it sounds. */
function techniques(line: string, c: number): Partial<Pick<TabNote, 'bend' | 'link' | 'vibrato' | 'tap' | 'harmonic'>> {
  const out: Partial<Pick<TabNote, 'bend' | 'link' | 'vibrato' | 'tap' | 'harmonic'>> = {};
  const before = line[c - 1];
  // A join written straight across a bar line ("5h|7") is the same join — the bar line sits between.
  const joiner = before === '|' ? line[c - 2] : before;
  const fromDigit = isDigit(before === '|' ? line[c - 3] : line[c - 2]);
  if ((joiner === 'h' || joiner === 'p' || joiner === '/' || joiner === '\\') && fromDigit) out.link = joiner;
  if (before === 't' || before === 'T') out.tap = true;
  let e = c;
  while (isDigit(line[e + 1])) e++;
  const num = (from: number) => {
    let to = from;
    while (isDigit(line[to + 1])) to++;
    return to >= from && isDigit(line[from]) ? { value: Number(line.slice(from, to + 1)), end: to } : null;
  };
  const harmonic = () => {
    const m = /^\((ph|h)\)/.exec(line.slice(e + 1));
    if (m) {
      out.harmonic = m[1] === 'ph' ? 'pinch' : 'natural';
      e += m[0].length;
    }
  };
  harmonic();
  const pre = line[e + 1] === 'p' && line[e + 2] === 'b';
  if (pre || line[e + 1] === 'b') {
    const target = num(e + (pre ? 3 : 2));
    if (target) {
      out.bend = pre ? { to: target.value, pre: true } : { to: target.value };
      e = target.end;
      if (line[e + 1] === 'r') {
        const back = num(e + 2);
        if (back) {
          out.bend.release = back.value;
          e = back.end;
        }
      }
    }
  }
  harmonic();
  if (line[e + 1] === '~' || line[e + 1] === 'v') out.vibrato = true;
  return out;
}

/** Marks on a line above or below a block's strings, with the columns they cover: D/U picking, 1-4 and
 * [1]-[4] fingering (left/right hand), and PM followed by dashes for a palm-mute run (the dashes' extent). */
function annotationTokens(line: string): { kind: 'pick' | 'lh' | 'rh' | 'pm' | 'repeat'; text: string; col: number; end: number }[] {
  const out: { kind: 'pick' | 'lh' | 'rh' | 'pm' | 'repeat'; text: string; col: number; end: number }[] = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === 'P' && line[i + 1] === 'M') {
      let end = i + 1;
      while (line[end + 1] === '-') end++;
      out.push({ kind: 'pm', text: 'PM', col: i, end });
      i = end;
    } else if (ch === '[' && /[1-4]/.test(line[i + 1] ?? '') && line[i + 2] === ']') {
      out.push({ kind: 'rh', text: line[i + 1], col: i, end: i + 2 });
      i += 2;
    } else if (ch === 'x' && /[2-9]/.test(line[i + 1] ?? '')) {
      out.push({ kind: 'repeat', text: line[i + 1], col: i, end: i + 1 });
      i += 1;
    } else if (ch === 'D' || ch === 'U') out.push({ kind: 'pick', text: ch, col: i, end: i });
    else if (/[1-4]/.test(ch)) out.push({ kind: 'lh', text: ch, col: i, end: i });
  }
  return out;
}

/** The tab as bars and a list of notes with pitch and timing, for the staff view and the playing trainer. */
export function parseScore(text: string): { notes: TabNote[]; bars: TabBar[] } {
  const lines = text.split('\n');
  let pmRuns = 0; // palm-mute runs numbered across the whole tab
  const blocks = tabBlocks(text);
  const notes: TabNote[] = [];
  const bars: TabBar[] = [];
  blocks.forEach((b, bi) => {
    const nStrings = b.stringLast - b.stringFirst + 1;
    const open = OPEN_STRINGS[nStrings];
    const segs = barSegments(b);
    const barBase = bars.length;
    // A fixed time signature (b.timeSig, no rhythm line) rescales each bar's raw *column* span to its
    // real musical length instead of taking it literally, and later bars shift to stay contiguous —
    // worked out per bar as a simple affine remap (rawStart, rawLength) -> (fixedStart, fixedLength),
    // then applied identically to every note's own column position within that bar, below. A rhythm
    // line (b.events) already gives exact lengths, so it's left out of this entirely — scale 1,
    // fixedStart == rawStart — and colToUnits (unaffected) is used for its notes' positions as before.
    let fixedStart = 0;
    const segFixed = segs.map(([from, to]) => {
      const rawStart = b.cum[from];
      const rawLen = b.cum[to] - rawStart;
      const fixedLen = b.events ? rawLen : (b.timeSig ?? rawLen);
      const seg = { from, to, rawStart, fixedStart, scale: rawLen > 0 ? fixedLen / rawLen : 1, fixedLen };
      fixedStart += fixedLen;
      return seg;
    });
    // A repeat sign is an asterisk right inside a bar's opening/closing bar line, on any string.
    const stringLines = Array.from({ length: nStrings }, (_, k) => lines[b.stringFirst + k] ?? '');
    const repeats = (from: number, to: number) => ({
      ...(stringLines.some((l) => l[from] === '*') ? { repeatStart: true } : {}),
      ...(stringLines.some((l) => l[to - 1] === '*' && to - 1 > from) ? { repeatEnd: true } : {}),
    });
    segFixed.forEach((seg, i) => {
      const [from, to] = segs[i];
      if (b.events) {
        const ev = b.events.filter((e) => e.col >= from && e.col < to);
        bars.push({ start: b.start + (ev[0]?.u ?? 0), length: ev.reduce((n, e) => n + e.d, 0), ...repeats(from, to) });
      } else bars.push({ start: b.start + seg.fixedStart, length: seg.fixedLen, ...repeats(from, to) });
    });
    const remapCol = (c: number, segIdx: number) => (segIdx === -1 ? b.cum[c] : segFixed[segIdx].fixedStart + (b.cum[c] - segFixed[segIdx].rawStart) * segFixed[segIdx].scale);
    const found: TabNote[] = [];
    for (let k = 0; k < nStrings; k++) {
      const line = lines[b.stringFirst + k];
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
        const segIdx = segs.findIndex(([from, to]) => c >= from && c < to);
        const start = b.start + (b.events ? colToUnits(b, c) : remapCol(c, segIdx));
        const bar = barBase + Math.max(0, segIdx);
        const note: TabNote = { block: bi, string: k, fret, midi: open && fret !== null ? open[k] + fret : null, col: c, start, length: 0, bar };
        if (fret !== null) Object.assign(note, techniques(line, c));
        found.push(note);
      }
    }
    // Marks on the lines above/below the strings attach to the note they line up over (any column its
    // fret covers); a palm-mute run covers every note in it.
    const span = (n: TabNote) => [n.col, n.col + String(n.fret ?? 'x').length - 1] as const;
    for (const [rows, above] of [[b.annAbove, true], [b.annBelow, false]] as const) {
      for (const row of rows) {
        // One mark per note per line, handed out left to right: a mark typed a column off lands on the
        // nearest note within a column that hasn't already been given one, so a whole line sitting one
        // column to the left (or right) of its notes still lines up, rather than two marks fighting
        // over the same note.
        const taken = new Set<TabNote>();
        for (const tok of annotationTokens(lines[row] ?? '')) {
          // "x3": how many times the repeat that ends in the bar it sits over plays (see repeatPlan)
          if (tok.kind === 'repeat') {
            const si = segs.findIndex(([from, to]) => tok.col >= from - 1 && tok.col <= to);
            if (si !== -1) bars[barBase + si].repeatCount = Number(tok.text);
            continue;
          }
          const gap = (n: TabNote) => Math.max(0, span(n)[0] - tok.end, tok.col - span(n)[1]);
          const free = found.filter((n) => !taken.has(n));
          const near = Math.min(...free.map(gap));
          const over = tok.kind === 'pm' ? found.filter((n) => gap(n) === 0) : near <= 1 ? free.filter((n) => gap(n) === near) : [];
          if (tok.kind !== 'pm' && over.length) taken.add(over.reduce((a, c2) => (c2.start < a.start || (c2.start === a.start && c2.string < a.string) ? c2 : a)));
          if (tok.kind === 'pm') {
            const id = ++pmRuns;
            for (const n of over) n.pm = { ...n.pm, [above ? 'above' : 'below']: id };
          } else if (over.length) {
            const first = over.reduce((a, c2) => (c2.start < a.start || (c2.start === a.start && c2.string < a.string) ? c2 : a));
            (first.marks ??= []).push({ kind: tok.kind, text: tok.text, above });
          }
        }
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
  return { notes: notes.sort((x, y) => x.start - y.start || x.string - y.string), bars };
}

/** The note(s) sounding at time `u` (in the same sixteenth-note units as TabNote.start/length) — more
 * than one for a chord, none for a rest/gap. For the playing trainer: what's expected right now. */
export function noteGroupAt(notes: TabNote[], u: number): TabNote[] {
  return notes.filter((n) => u >= n.start && u < n.start + n.length);
}

/** The pitches (MIDI) a note can be played at and still be right: a bend starts at its fret and ends at
 * the bent-to fret (and, released, comes back down to the release fret); a pre-bend is already at the
 * bent-to pitch when picked. A plain note is just its own. For the playing trainer, which listens to
 * whatever pitch it hears at the moment and so can catch a bend anywhere along it. */
export function acceptedMidis(n: TabNote): number[] {
  if (n.midi === null) return [];
  if (!n.bend || n.fret === null) return [n.midi];
  const out = n.bend.pre ? [n.midi + (n.bend.to - n.fret)] : [n.midi, n.midi + (n.bend.to - n.fret)];
  if (n.bend.release !== undefined) out.push(n.midi + (n.bend.release - n.fret));
  return out;
}

// ---- repeats ------------------------------------------------------------------------------------------
// A repeat sign (`|*` ... `*|`) means the section plays again. The tab itself is written once, but the
// music is longer than that, so playback position (which keeps counting up through the repeat) has to be
// mapped back onto the written tab, jumping from the end of the section to its start for each extra pass.
// "Unrolled" position = how far along the played music is; "score" position = where that is on the page.

export interface RepeatPlan {
  /** The bars in the order they're played: where each starts in unrolled position, and where it is on the page. */
  segs: { u0: number; u1: number; from: number }[];
  /** Total length played, in the same sixteenth-note units, and where the written tab ends. */
  total: number;
  end: number;
}

/** Null when there are no repeats (position is just position). A closing sign repeats back to the
 * nearest opening one before it, or to just after the previous repeat (or the start); `x3` on its bar
 * plays the section three times in all, otherwise twice. */
export function repeatPlan(bars: TabBar[]): RepeatPlan | null {
  if (!bars.some((b) => b.repeatEnd)) return null;
  const order: number[] = [];
  let sectionStart = 0;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].repeatStart) sectionStart = i;
    order.push(i);
    if (bars[i].repeatEnd) {
      for (let pass = 1; pass < Math.max(2, bars[i].repeatCount ?? 2); pass++) for (let k = sectionStart; k <= i; k++) order.push(k);
      sectionStart = i + 1;
    }
  }
  const segs: RepeatPlan['segs'] = [];
  let u = 0;
  for (const i of order) {
    if (bars[i].length <= 0) continue;
    segs.push({ u0: u, u1: u + bars[i].length, from: bars[i].start });
    u += bars[i].length;
  }
  const last = bars[bars.length - 1];
  return { segs, total: u, end: last.start + last.length };
}

/** Score position -> unrolled position, for the *first* time through (where a tap was made). */
export function toUnrolled(plan: RepeatPlan, u: number): number {
  const seg = plan.segs.find((g) => u >= g.from && u < g.from + (g.u1 - g.u0));
  if (seg) return seg.u0 + (u - seg.from);
  return u >= plan.end ? plan.total + (u - plan.end) : u;
}

/** Unrolled position -> where that is on the written tab. */
export function fromUnrolled(plan: RepeatPlan, uu: number): number {
  const seg = plan.segs.find((g) => uu >= g.u0 && uu < g.u1);
  if (seg) return seg.from + (uu - seg.u0);
  return uu >= plan.total ? plan.end + (uu - plan.total) : uu;
}

/** The note at a specific bar + column — turns a click on the engraved tab's own data-bar/data-col
 * attributes (see drawTabScore in staff.ts) back into the TabNote it represents, to edit its rhythm. */
export function findNoteAt(notes: TabNote[], bar: number, col: number): TabNote | undefined {
  return notes.find((n) => n.bar === bar && n.col === col);
}

/** Every distinct clickable instant in the tab (one entry per chord, not per string), in playing
 * order — for arrow-key navigation between notes in Follow along. A chord's several TabNotes share
 * one start and one column (they're written at the same character position, stacked across string
 * rows), so de-duping by start already de-dupes by column too; the first note found for a given
 * start just supplies that shared column. */
export function noteCols(notes: TabNote[]): { bar: number; col: number; start: number }[] {
  const seen = new Map<number, { bar: number; col: number; start: number }>();
  for (const n of notes) if (!seen.has(n.start)) seen.set(n.start, { bar: n.bar, col: n.col, start: n.start });
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

/** Sets (or replaces) one note's rhythm letter at its own column, inserting a rhythm line for the
 * block first if it doesn't have one yet — the same shape "Add rhythm line" itself inserts (see
 * tabRhythmBtn in deck.ts), just with this specific note's own column set instead of only the
 * block's first note. A trailing dot is cleared if there was one, since setting a plain length this
 * way always means "exactly this," not whatever dotted status happened to be there before. Returns
 * the full new text, plus where the change starts and how much the text grew there, for shifting any
 * tap anchors past that point the same way "Add rhythm line"'s own insertion already does. */
export function setRhythmLetter(text: string, block: TabBlock, col: number, letter: string): { text: string; insertAt: number; grew: number } {
  const lines = text.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  if (block.rhythmRow !== undefined) {
    const row = block.rhythmRow;
    const old = lines[row];
    const padded = col < old.length ? old : old.padEnd(col + 1, ' ');
    const hadDot = padded[col + 1] === '.';
    const newLine = padded.slice(0, col) + letter + padded.slice(col + 1 + (hadDot ? 1 : 0));
    lines[row] = newLine;
    return { text: lines.join('\n'), insertAt: starts[row] + Math.min(col, old.length), grew: newLine.length - old.length };
  }
  const line = ' '.repeat(col) + letter;
  lines.splice(block.lastRow + 1, 0, line);
  const insertAt = block.lastRow + 1 < starts.length ? starts[block.lastRow + 1] : text.length + 1;
  return { text: lines.join('\n'), insertAt, grew: line.length + 1 };
}

export function parseTab(text: string): TabNote[] {
  return parseScore(text).notes;
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
  // A block's rhythm line (if it has one) is annotation, not a string, so it doesn't get a row here —
  // the strip only ever shows the strings, same as it would with no rhythm line at all.
  const stringRows = (b: TabBlock) => b.stringLast - b.stringFirst + 1;
  const nRows = blocks.length ? Math.max(...blocks.map(stringRows)) : 0;
  const labels: string[] = [];
  const rows: string[] = [];
  const startOf: number[] = [];
  let at = pad;
  for (const b of blocks) {
    startOf.push(at);
    at += b.chars - b.label;
  }
  for (let k = 0; k < nRows; k++) {
    labels.push(blocks.length ? (lines[blocks[0].stringFirst + k] ?? '').padEnd(blocks[0].label).slice(0, blocks[0].label) : '');
    rows.push(
      '-'.repeat(pad) +
        blocks.map((b) => (k < stringRows(b) ? (lines[b.stringFirst + k] ?? '').padEnd(b.chars).slice(b.label) : ' '.repeat(b.chars - b.label))).join('') +
        '-'.repeat(pad),
    );
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
