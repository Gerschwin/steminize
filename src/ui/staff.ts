// Standard notation for the Scratchpad's Tab pane: draws the parsed tab (see lyrics/tabSync.ts
// parseScore) as one long line of bars, and says where each note landed on the page so the deck can
// slide it past a fixed cursor in step with the music. VexFlow is big, so it is only loaded the first
// time a staff is asked for.

import type { TabBar, TabNote } from '../lyrics/tabSync.ts';

export interface StaffLayout {
  /** Where the music at each moment (sixteenth notes from the tab's start) sits across the drawing, in px. */
  map: { u: number; x: number }[];
  /** One entry per drawn note/chord (rests excluded): its notehead's own box, in the same px space as
   * `map`, for highlighting exactly what's sounding right now rather than just a position along the line. */
  notes: { u: number; len: number; x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
}

/** Note lengths VexFlow can draw, longest first: [sixteenths, duration code]. */
const LENGTHS: [number, string][] = [
  [16, 'w'],
  [12, 'hd'],
  [8, 'h'],
  [6, 'qd'],
  [4, 'q'],
  [3, '8d'],
  [2, '8'],
  [1.5, '16d'],
  [1, '16'],
  [0.5, '32'],
];

/** Splits a length into note lengths that can be drawn (a bar longer than a whole note, or an odd
 * length, becomes a few notes or rests in a row). */
export function splitLength(units: number): string[] {
  const out: string[] = [];
  let left = units;
  while (left >= 0.5 - 1e-9) {
    const fit = LENGTHS.find(([n]) => n <= left + 1e-9);
    if (!fit) break;
    out.push(fit[1]);
    left -= fit[0];
  }
  return out;
}

const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** VexFlow key for a sounding MIDI pitch. Guitar is written an octave above where it sounds. */
export function vexKey(midi: number): string {
  const written = midi + 12;
  return `${NAMES[written % 12]}/${Math.floor(written / 12) - 1}`;
}

let vex: Promise<typeof import('vexflow/bravura')> | null = null;

/** Middle line of a treble stave, written pitch (MIDI). Guitar is written an octave up (see vexKey),
 * so this is B4 — a note plotted here sits dead centre, needing no ledger lines either way. */
const MIDDLE_LINE = 71;
/** A generous (not exact) pixel-per-semitone step for sizing the row: real engraving spacing is
 * roughly 3px/semitone on a default-size treble stave, padded up so this reliably clears the note
 * itself, its stem, and (at the extremes) its beam or flag, without ever needing to measure the
 * actual rendered SVG — a browser-measurement pass turned out to be the likelier source of a
 * WebKitGTK-only rendering bug than a fix, so this trades a little tightness for reliability. */
const PX_PER_SEMITONE = 4.3;
const MARGIN = 105; // clef, a stem's own length, room for a beam/flag on the outermost note — a beamed
// group can reach further than its outermost note alone would (the beam follows the group's slope)

/** Draws the score into `host` (replacing what was there) and returns where things landed. The row's
 * height and the stave's vertical position are sized from the tab's own pitch range (not a single fixed
 * guess, which either clipped a wide-ranging tab or left a narrow one swimming in empty space) — but
 * from the notes' pitches alone, not by rendering once to measure and again to fit: an earlier version
 * did exactly that, and needed to briefly attach `host` to the document to get real geometry from the
 * browser, which is suspected to be why a real note's stem and beam stopped lining up with its own
 * notehead on WebKitGTK (never reproduced in Chromium) — this avoids that risk entirely. */
export async function drawStaff(host: HTMLElement, notes: TabNote[], bars: TabBar[]): Promise<StaffLayout> {
  vex ??= import('vexflow/bravura');
  const vf = await vex;
  // Defensive: make sure the embedded engraving font has actually finished loading before drawing
  // anything with it. Unconfirmed as a cause of the WebKitGTK issue above, but cheap and safe either way.
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready.catch(() => {});
  const written = notes.filter((n) => n.midi !== null).map((n) => n.midi! + 12);
  const hi = written.length ? Math.max(...written) : MIDDLE_LINE;
  const lo = written.length ? Math.min(...written) : MIDDLE_LINE;
  const above = Math.max(0, hi - MIDDLE_LINE) * PX_PER_SEMITONE + MARGIN;
  const below = Math.max(0, MIDDLE_LINE - lo) * PX_PER_SEMITONE + MARGIN;
  const ROW = Math.round(above + below);
  const staveY = Math.round(above - 20); // the stave's own 5 lines span ~40px, centred on the middle line
  const { Renderer, Stave, StaveNote, Voice, Formatter, Accidental, Dot, Beam } = vf;
  host.replaceChildren();
  const CLEF = 64;
  const widthOf = (b: TabBar) => Math.max(96, b.length * 14 + 40);
  const total = CLEF + bars.reduce((n, b) => n + widthOf(b), 0) + 20;
  const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(total, ROW);
  const ctx = renderer.getContext();
  ctx.setFillStyle('currentColor');
  ctx.setStrokeStyle('currentColor');

  const map: { u: number; x: number }[] = [];
  const notesOut: StaffLayout['notes'] = [];
  let x = 0;
  bars.forEach((bar, bi) => {
    const w = widthOf(bar) + (bi === 0 ? CLEF : 0);
    const stave = new Stave(x, staveY, w);
    if (bi === 0) stave.addClef('treble', 'default', '8vb');
    stave.setContext(ctx).draw();

    // the notes that start in this bar, grouped into chords by start time
    const inBar = notes.filter((n) => n.bar === bi && n.midi !== null);
    const groups = new Map<number, TabNote[]>();
    for (const n of inBar) groups.set(n.start, [...(groups.get(n.start) ?? []), n]);
    const starts = [...groups.keys()].sort((a, b) => a - b);

    const tickables: InstanceType<typeof StaveNote>[] = [];
    const startsOf: number[] = []; // parallel to tickables: the tab time of each drawn note (rests: NaN)
    // The first (only real, not-a-tie-continuation-rest — see note in BACKLOG) piece of each group, for
    // the notehead-highlight overlay: which tickable to measure, over how long a stretch of time.
    const groupFirst: { u: number; len: number; idx: number }[] = [];
    const add = (code: string, rest: boolean, midis: number[], u: number) => {
      const dots = code.endsWith('d') ? 1 : 0;
      const base = dots ? code.slice(0, -1) : code;
      const note = new StaveNote({
        keys: rest ? ['b/4'] : midis.map(vexKey),
        duration: base + (rest ? 'r' : ''),
        dots,
        clef: 'treble',
      });
      if (dots) Dot.buildAndAttach([note], { all: true });
      tickables.push(note);
      startsOf.push(rest ? NaN : u);
    };
    let at = bar.start;
    for (const s of starts) {
      if (s > at + 1e-6) for (const code of splitLength(s - at)) add(code, true, [], NaN);
      const group = groups.get(s)!;
      const room = bar.start + bar.length - s;
      const len = Math.min(Math.min(...group.map((n) => n.length)), room);
      const pieces = splitLength(len);
      const midis = [...new Set(group.map((n) => n.midi!))].sort((a, b) => a - b);
      if (pieces.length) groupFirst.push({ u: s, len, idx: tickables.length });
      pieces.forEach((code, i) => add(code, i > 0, midis, s));
      at = s + (pieces.length ? len : 0);
    }
    if (bar.start + bar.length > at + 1e-6) for (const code of splitLength(bar.start + bar.length - at)) add(code, true, [], NaN);
    if (!tickables.length) for (const code of splitLength(bar.length || 16)) add(code, true, [], NaN);

    const voice = new Voice({ numBeats: Math.max(1, Math.round(bar.length)) || 16, beatValue: 16 });
    voice.setStrict(false);
    voice.addTickables(tickables);
    Accidental.applyAccidentals([voice], 'C');
    const beams = Beam.generateBeams(tickables.filter((t) => !t.isRest()));
    new Formatter().joinVoices([voice]).format([voice], Math.max(40, w - (bi === 0 ? CLEF : 0) - 30));
    voice.draw(ctx, stave);
    beams.forEach((bm) => bm.setContext(ctx).draw());
    tickables.forEach((t, i) => {
      if (!Number.isNaN(startsOf[i])) map.push({ u: startsOf[i], x: t.getAbsoluteX() });
    });
    for (const g of groupFirst) {
      const bb = tickables[g.idx].getBoundingBox();
      notesOut.push({ u: g.u, len: g.len, x: bb.getX(), y: bb.getY(), w: bb.getW(), h: bb.getH() });
    }
    x += w;
  });
  // (the end of the music: one more point so the cursor has somewhere to finish)
  const last = bars[bars.length - 1];
  if (last) map.push({ u: last.start + last.length, x: total - 20 });
  map.sort((a, b) => a.u - b.u);
  notesOut.sort((a, b) => a.u - b.u);
  const svg = host.querySelector('svg');
  if (svg) {
    svg.style.overflow = 'visible';
    svg.style.display = 'block';
  }
  return { map, notes: notesOut, width: total, height: ROW };
}

/** The note (if any) sounding at `u`, for highlighting its actual notehead rather than just a position. */
export function noteAt(notes: StaffLayout['notes'], u: number): StaffLayout['notes'][number] | null {
  let cur: StaffLayout['notes'][number] | null = null;
  for (const n of notes) {
    if (n.u > u) break;
    if (u < n.u + n.len) cur = n;
  }
  return cur;
}

/** How far across the drawing the music at `u` is, by joining the note positions in between with straight lines. */
export function staffX(map: { u: number; x: number }[], u: number): number {
  if (!map.length) return 0;
  if (u <= map[0].u) return map[0].x;
  for (let i = 1; i < map.length; i++) {
    if (u < map[i].u) {
      const a = map[i - 1];
      const b = map[i];
      return a.x + ((u - a.u) / (b.u - a.u)) * (b.x - a.x);
    }
  }
  return map[map.length - 1].x;
}

// ---- rhythm-tab: fret numbers on a tab stave, with note durations shown as stems/beams above it ----
// (the display in BACKLOG's tab+ roadmap screenshot: a compact rhythm row — no 5-line staff, no pitch,
// just the beaming a reader needs to feel the timing — sitting right above the tab it times, rather than
// a full notation staff some distance below it. The full staff (drawStaff, above) stays available too:
// pitched here draws real noteheads in the rhythm row instead of the plain rhythm-slash placeholder.)

export interface TabScoreLayout {
  map: { u: number; x: number }[];
  /** One entry per drawn note/chord (rests excluded): the union of its fret number(s)' own box, in the
   * same px space as `map`, for highlighting exactly what's sounding right now. */
  notes: { u: number; len: number; x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
}

/** A tab note's fret text, or 'x' for a dead/unknown-fret note (parseTab gives fret:null for that). */
const fretText = (fret: number | null): string => (fret === null ? 'x' : String(fret));

/** Draws fret numbers on a tab stave (6 lines, a "TAB" glyph instead of a clef) with a compact rhythm
 * row above it showing the same notes' exact durations as stems, beams, dots and flags — no 5-line
 * staff, just enough notation to read the timing, unless `pitched` asks for real noteheads there too. */
export async function drawTabScore(host: HTMLElement, notes: TabNote[], bars: TabBar[], pitched = false): Promise<TabScoreLayout> {
  vex ??= import('vexflow/bravura');
  const vf = await vex;
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready.catch(() => {});
  const { Renderer, Stave, TabStave, StaveNote, TabNote: VFTabNote, GhostNote, Voice, Formatter, Accidental, Dot, Beam } = vf;
  host.replaceChildren();

  const CLEF = 64;
  const RHYTHM_H = pitched ? 90 : 46; // just stems+beams needs much less room than real noteheads/ledger lines
  const GAP = 6;
  const TAB_H = 6 * 13 + 24; // matches TabStave's own default line spacing, plus room for the "TAB" glyph and fret digits
  const ROW = RHYTHM_H + GAP + TAB_H;
  const widthOf = (b: TabBar) => Math.max(96, b.length * 14 + 40);
  const total = CLEF + bars.reduce((n, b) => n + widthOf(b), 0) + 20;
  const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(total, ROW);
  const ctx = renderer.getContext();
  ctx.setFillStyle('currentColor');
  ctx.setStrokeStyle('currentColor');

  const map: { u: number; x: number }[] = [];
  const notesOut: TabScoreLayout['notes'] = [];
  let x = 0;
  bars.forEach((bar, bi) => {
    const w = widthOf(bar) + (bi === 0 ? CLEF : 0);
    const rhythmY = pitched ? 46 : 10;
    const rhythmStave = new Stave(x, rhythmY, w, pitched ? undefined : { numLines: 0 });
    if (bi === 0 && pitched) rhythmStave.addClef('treble', 'default', '8vb');
    rhythmStave.setContext(ctx).draw();
    const tabStave = new TabStave(x, rhythmY + RHYTHM_H + GAP, w);
    if (bi === 0) tabStave.addTabGlyph();
    tabStave.setContext(ctx).draw();

    const inBar = notes.filter((n) => n.bar === bi);
    const groups = new Map<number, TabNote[]>();
    for (const n of inBar) groups.set(n.start, [...(groups.get(n.start) ?? []), n]);
    const starts = [...groups.keys()].sort((a, b) => a - b);

    const rhythmTickables: InstanceType<typeof StaveNote>[] = [];
    const tabTickables: (InstanceType<typeof VFTabNote> | InstanceType<typeof GhostNote>)[] = [];
    const startsOf: number[] = []; // parallel to rhythmTickables/tabTickables: tab time (rests: NaN)
    const groupFirst: { u: number; len: number; idx: number }[] = [];
    const add = (code: string, rest: boolean, group: TabNote[], u: number) => {
      const dots = code.endsWith('d') ? 1 : 0;
      const base = dots ? code.slice(0, -1) : code;
      const midis = pitched ? [...new Set(group.filter((n) => n.midi !== null).map((n) => n.midi!))].sort((a, b) => a - b) : [];
      const rNote = new StaveNote({ keys: rest || !midis.length ? ['b/4'] : midis.map(vexKey), duration: base + (rest ? 'r' : ''), dots, clef: 'treble' });
      if (dots) Dot.buildAndAttach([rNote], { all: true });
      rhythmTickables.push(rNote);
      // A rest in the tab row: a GhostNote occupies the right amount of time (for the rhythm/tab
      // columns to still line up) without drawing anything — VFTabNote's own .setGhost(true) is a
      // different, notational thing (an implied note shown in parens), not what's wanted here.
      const tNote = rest
        ? new GhostNote(base + (dots ? 'd' : ''))
        : new VFTabNote({ positions: group.map((n) => ({ str: n.string + 1, fret: fretText(n.fret) })), duration: base }, false);
      if (dots && !rest) Dot.buildAndAttach([tNote], { all: true });
      tabTickables.push(tNote);
      startsOf.push(rest ? NaN : u);
    };
    let at = bar.start;
    for (const s of starts) {
      if (s > at + 1e-6) for (const code of splitLength(s - at)) add(code, true, [], NaN);
      const group = groups.get(s)!;
      const room = bar.start + bar.length - s;
      const len = Math.min(Math.min(...group.map((n) => n.length)), room);
      const pieces = splitLength(len);
      if (pieces.length) groupFirst.push({ u: s, len, idx: rhythmTickables.length });
      pieces.forEach((code, i) => add(code, i > 0, group, s));
      at = s + (pieces.length ? len : 0);
    }
    if (bar.start + bar.length > at + 1e-6) for (const code of splitLength(bar.start + bar.length - at)) add(code, true, [], NaN);
    if (!rhythmTickables.length) for (const code of splitLength(bar.length || 16)) add(code, true, [], NaN);

    const numBeats = Math.max(1, Math.round(bar.length)) || 16;
    const rhythmVoice = new Voice({ numBeats, beatValue: 16 });
    rhythmVoice.setStrict(false);
    rhythmVoice.addTickables(rhythmTickables);
    const tabVoice = new Voice({ numBeats, beatValue: 16 });
    tabVoice.setStrict(false);
    tabVoice.addTickables(tabTickables);
    if (pitched) Accidental.applyAccidentals([rhythmVoice], 'C');
    const beams = Beam.generateBeams(rhythmTickables.filter((t) => !t.isRest()));
    new Formatter().joinVoices([rhythmVoice, tabVoice]).format([rhythmVoice, tabVoice], Math.max(40, w - (bi === 0 ? CLEF : 0) - 30));
    rhythmVoice.draw(ctx, rhythmStave);
    // Every fret digit sits on its own small solid-white "eraser" rectangle (VexFlow's own, to blank
    // out the tab line it would otherwise cross) — always white, regardless of theme. Drawn in the
    // app's usual near-white currentColor, a digit there is nearly invisible on its own background;
    // a fixed dark fill, just for this pass, gives it the contrast the light rhythm row above doesn't
    // need (nothing else there sits on a forced-white patch).
    ctx.save();
    ctx.setFillStyle('#111');
    tabVoice.draw(ctx, tabStave);
    ctx.restore();
    beams.forEach((bm) => bm.setContext(ctx).draw());

    tabTickables.forEach((t, i) => {
      if (!Number.isNaN(startsOf[i])) map.push({ u: startsOf[i], x: t.getAbsoluteX() });
    });
    for (const g of groupFirst) {
      const boxes = tabTickables[g.idx].getModifierStartXY(0, 0); // fallback if getBoundingBox is unhelpful for a ghost-free tab note
      let bb: { getX(): number; getY(): number; getW(): number; getH(): number };
      try {
        bb = tabTickables[g.idx].getBoundingBox();
      } catch {
        bb = { getX: () => boxes.x - 8, getY: () => boxes.y - 8, getW: () => 16, getH: () => 16 };
      }
      notesOut.push({ u: g.u, len: g.len, x: bb.getX(), y: bb.getY(), w: bb.getW(), h: bb.getH() });
    }
    x += w;
  });
  const last = bars[bars.length - 1];
  if (last) map.push({ u: last.start + last.length, x: total - 20 });
  map.sort((a, b) => a.u - b.u);
  notesOut.sort((a, b) => a.u - b.u);
  const svg = host.querySelector('svg');
  if (svg) {
    svg.style.overflow = 'visible';
    svg.style.display = 'block';
  }
  return { map, notes: notesOut, width: total, height: ROW };
}
