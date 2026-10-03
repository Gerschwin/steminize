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
    stave.setMeasure(bi + 1);
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

/** The reverse of staffX: the music's position under a given x across the drawing (clamped to the
 * first/last note's position), for turning a drag across the view back into a position. */
export function staffU(map: { u: number; x: number }[], x: number): number {
  if (!map.length) return 0;
  if (x <= map[0].x) return map[0].u;
  for (let i = 1; i < map.length; i++) {
    if (x < map[i].x) {
      const a = map[i - 1];
      const b = map[i];
      return b.x === a.x ? a.u : a.u + ((x - a.x) / (b.x - a.x)) * (b.u - a.u);
    }
  }
  return map[map.length - 1].u;
}

// ---- rhythm-tab: fret numbers on a tab stave, with note durations shown as stems/beams under it ----
// (based on the display in BACKLOG's tab+ roadmap screenshot, but with the rhythm row moved below the
// tab rather than above it: a compact row — no 5-line staff, no pitch, just the beaming a reader needs
// to feel the timing — sitting right under the tab it times, rather than a full notation staff some
// distance away. The full staff (drawStaff, above) stays available too: pitched here draws real
// noteheads in the rhythm row instead of the plain rhythm-slash placeholder.)

export interface TabScoreLayout {
  map: { u: number; x: number }[];
  /** One entry per drawn note/chord (rests excluded): the union of its fret number(s)' own box, in the
   * same px space as `map`, for highlighting exactly what's sounding right now. `bar`/`col` match the
   * same note's own TabNote (and the data-bar/data-col attributes on its drawn elements, below) — for
   * looking its box up again given a click rather than a playback position. */
  notes: { u: number; len: number; x: number; y: number; w: number; h: number; bar: number; col: number }[];
  width: number;
  height: number;
}

/** Size (pt) of the muted-note X glyph: the double-sharp symbol is small for its em, so it's set well above a digit's 9pt. */
const MUTED_X_PT = 24;
/** How far (in em) that glyph's ink centre sits above its baseline in Bravura — measured, not guessed. */
const MUTED_X_INK_RISE_EM = 0.0078125;

/** A tab note's fret text, or 'x' for a dead/unknown-fret note (parseTab gives fret:null for that). */
const fretText = (fret: number | null): string => (fret === null ? 'x' : String(fret));

/** The label over a bend arrow, from how many semitones (frets) it goes up: 1/2, Full, 1 1/2, 2 ... */
const bendText = (semis: number): string => {
  if (semis <= 0) return '';
  if (semis === 1) return '1/2';
  const whole = Math.floor(semis / 2);
  return semis % 2 ? `${whole} 1/2` : whole === 1 ? 'Full' : String(whole);
};

/** Draws fret numbers on a tab stave (6 lines, a "TAB" glyph instead of a clef) with a compact rhythm
 * row under it showing the same notes' exact durations as stems, beams, dots and flags — no 5-line
 * staff, just enough notation to read the timing, unless `pitched` asks for real noteheads there too.
 * `host` is expected to still be off-document when this is called (the usual caller draws into a
 * detached element first, so a stale or failed drawing is never visible even for a moment, only
 * moving it into the real page once it's finished) — which rules out anything here that needs to look
 * its own output back up via document.getElementById() (VexFlow's Element.getSVGElement() does
 * exactly that), a trap the unpitched rhythm row's blanked-out noteheads fell into once already. */
export async function drawTabScore(host: HTMLElement, notes: TabNote[], bars: TabBar[], pitched = false): Promise<TabScoreLayout> {
  vex ??= import('vexflow/bravura');
  const vf = await vex;
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready.catch(() => {});
  const { Renderer, Stave, TabStave, StaveNote, TabNote: VFTabNote, GhostNote, Voice, Formatter, Accidental, Dot, Beam, Stem, Barline, Metrics, MetricsDefaults, Bend, Vibrato, Annotation, TabTie, TabSlide } = vf;
  // A dead/muted note ('x') isn't drawn as the character "x" — VexFlow draws it as a music-font glyph
  // (the "double sharp" symbol, conventionally used for a muted string) under the plain 'TabNote'
  // category, not 'TabNote.text' (the fret digits' own category). VexFlow's own metrics table sizes
  // 'TabNote.text' at 9pt but has no entry at all for bare 'TabNote', so it silently falls through to
  // the library's global default (30pt) — more than 3x the digits' own size, dwarfing this stave's
  // deliberately compact ~13px string spacing and overlapping neighbouring lines. Pinned to match the
  // digits once, the first time this runs (a library-wide default, not scoped to one draw call, so it
  // isn't reset after — nothing else in this app uses VexFlow's TabNote category at a different size).
  // MUTED_X_PT (below) rather than the digits' own 9pt: that first fix made the glyph the right *size class*
  // but the double-sharp symbol itself is tiny drawn that small (a ~3px speck, easy to read as a stray
  // dot), so it needs to be a good deal bigger than a digit to read as an X of similar weight.
  if (MetricsDefaults.TabNote.fontSize === undefined) {
    MetricsDefaults.TabNote.fontSize = MUTED_X_PT;
    Metrics.clear('TabNote');
  }
  host.replaceChildren();

  const CLEF = 64;
  const RHYTHM_H = 90;
  // Marks written *below* the strings (fingering, picking, a palm-mute run) need a band of their own
  // between the tab and the rhythm row, which otherwise hangs its stems right up against the bottom line.
  const hasAbove = notes.some((n) => n.marks?.some((m) => m.above) || n.pm?.above === true);
  // (and room above the strings likewise, where two stacked marks would otherwise run off the top)
  const ABOVE = hasAbove ? 22 : 0;
  const hasBelow = notes.some((n) => n.marks?.some((m) => !m.above) || n.pm?.above === false);
  const GAP = 6 + (hasBelow ? 18 : 0);
  // The unpitched placeholder note's own pitch/line doesn't mean anything — the notehead is invisible
  // — but VexFlow still uses it to decide the note's vertical position, so it's pinned to the stave's
  // own bottom line ('e/4': the lowest line that still needs no ledger line, which a *forced* line
  // below the actual stave, further down still, could quietly gain). The stem is forced down explicitly
  // rather than left to VexFlow's own default (which flips to "up" for a note this low), so it still
  // hangs into the row instead of doubling back up towards the tab.
  const RHYTHM_KEY = 'e/4';
  // How far below a Stave's own y the 'e/4' line actually lands, asked rather than guessed (same
  // reasoning as TAB_H below): used to shift the row's stave up by exactly that much, so the note
  // — sitting on that line, right where VexFlow puts it — ends up hard against the tab above it
  // instead of leaving a gap the height of an unused stave underneath the two.
  const RHYTHM_KEY_OFFSET = (() => {
    const probeStave = new Stave(0, 0, 100, { numLines: 0 });
    const probeNote = new StaveNote({ keys: [RHYTHM_KEY], duration: 'q', clef: 'treble' });
    probeNote.setStave(probeStave);
    return probeStave.getYForLine(probeNote.getKeyProps()[0].line);
  })();
  // How tall a TabStave actually is, asked rather than guessed: the vertical "TAB" glyph at the start
  // (addTabGlyph()) turned out to push the six string lines down by roughly 4 lines' worth of its own
  // height, which a plain lines×spacing sum doesn't account for at all — the first version of this
  // guessed too little, and the bottom two of six lines rendered past the SVG's own height, clipped
  // off entirely (not a CSS/scrolling problem — nothing to scroll to, they were never in the picture).
  // getBottomLineY() needs no context or drawing, just the stave's own line/glyph configuration — and
  // is the actual last string line's own y, unlike its sibling getBottomY(), which measures down to
  // the bottom of the stave's whole reserved area (room for ties, annotations, ...) and overshoots the
  // real last line by a good 50-60px, enough to read as a stray gap once something (the rhythm row)
  // is meant to sit right underneath it rather than just needing to clear it.
  const TAB_H = new TabStave(0, 0, 100).addTabGlyph().getBottomLineY() + 10;
  const ROW = RHYTHM_H + GAP + TAB_H + ABOVE;
  const widthOf = (b: TabBar) => Math.max(96, b.length * 14 + 40);
  // A reminder of this view's own keyboard shortcuts — click a note, a letter sets its length, arrows
  // move the selection — reserved as blank margin before bar 1, the same way CLEF reserves room for
  // the TAB glyph right after it. Otherwise that space (visible at/near the start of playback, where
  // the auto-scroll holds the current position at 40% from the left) is just empty, and these
  // shortcuts aren't discoverable anywhere else in Follow along itself.
  const INTRO = 230;
  const total = INTRO + CLEF + bars.reduce((n, b) => n + widthOf(b), 0) + 20;
  const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(total, ROW);
  const ctx = renderer.getContext();
  ctx.setFillStyle('currentColor');
  ctx.setStrokeStyle('currentColor');

  // Drawn as plain SVG, part of the track's own content rather than a fixed overlay, so it scrolls
  // away with everything else once playback or a selection moves past it — exactly like real musical
  // content sitting before bar 1 would.
  const introSvg = host.querySelector('svg');
  if (introSvg) {
    const introLines = ['Click a note, then:', 'w h q e s — set length', '← → note   ⇧ bar'];
    const lineH = 26;
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('font-size', '17px');
    text.setAttribute('font-family', 'Academico, sans-serif');
    text.style.fill = '#333';
    text.style.pointerEvents = 'none';
    introLines.forEach((line, i) => {
      const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      tspan.setAttribute('x', '14');
      tspan.setAttribute('y', String(ROW / 2 - ((introLines.length - 1) * lineH) / 2 + i * lineH));
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    introSvg.appendChild(text);
  }

  // Where each palm-mute run begins, across the whole score — a run carried over a bar line is one
  // run, so its "P.M." label is only drawn where it actually starts, not again at the next bar.
  const pmRunStarts = new Set<number>();
  {
    const starts = [...new Set(notes.map((n) => n.start))].sort((a, b) => a - b);
    let prev = false;
    for (const st of starts) {
      const on = notes.some((n) => n.start === st && n.pm);
      if (on && !prev) pmRunStarts.add(st);
      prev = on;
    }
  }

  const map: { u: number; x: number }[] = [];
  const notesOut: TabScoreLayout['notes'] = [];
  let x = INTRO;
  bars.forEach((bar, bi) => {
    const w = widthOf(bar) + (bi === 0 ? CLEF : 0);
    const tabY = 10 + ABOVE;
    const tabStave = new TabStave(x, tabY, w);
    if (bi === 0) tabStave.addTabGlyph();
    tabStave.setMeasure(bi + 1); // bars is the whole score's list, already numbered across every system
    if (bar.repeatStart) tabStave.setBegBarType(Barline.type.REPEAT_BEGIN);
    if (bar.repeatEnd) tabStave.setEndBarType(Barline.type.REPEAT_END);
    tabStave.setContext(ctx).draw();
    // TAB_H is already the tab stave's own absolute bottom-line y (its "+10" already covers tabY) —
    // adding tabY again here would double-count it and push the rhythm row, and the SVG's declared
    // height, 10px further down than the content actually needs. Unpitched, the stave itself is
    // shifted up by RHYTHM_KEY_OFFSET so the placeholder note (always on the same line) lands right
    // at TAB_H + GAP rather than that much further down.
    const rhythmY = (pitched ? TAB_H + GAP : TAB_H + GAP - RHYTHM_KEY_OFFSET) + ABOVE;
    const rhythmStave = new Stave(x, rhythmY, w, pitched ? undefined : { numLines: 0 });
    if (bi === 0 && pitched) rhythmStave.addClef('treble', 'default', '8vb');
    // The rhythm row is its own Stave underneath the tab, and by default draws its own begin/end bar
    // lines too — a short stub that, even with numLines:0 hiding its 5 string lines, still pokes out
    // a few px below the tab's own bar line into the gap between the two rows, reading as one
    // over-long line rather than two separate staves. The tab stave's own bar line (kept) already
    // marks the bar boundary; this second one directly underneath it added nothing but the overhang.
    rhythmStave.setBegBarType(Barline.type.NONE).setEndBarType(Barline.type.NONE);
    rhythmStave.setContext(ctx).draw();

    const inBar = notes.filter((n) => n.bar === bi);
    const groups = new Map<number, TabNote[]>();
    for (const n of inBar) groups.set(n.start, [...(groups.get(n.start) ?? []), n]);
    const starts = [...groups.keys()].sort((a, b) => a - b);

    const rhythmTickables: InstanceType<typeof StaveNote>[] = [];
    const tabTickables: (InstanceType<typeof VFTabNote> | InstanceType<typeof GhostNote>)[] = [];
    const startsOf: number[] = []; // parallel to rhythmTickables/tabTickables: tab time (rests: NaN)
    const realTabs: { tNote: InstanceType<typeof VFTabNote>; group: TabNote[] }[] = []; // the actual (non-rest) tab notes, in order, for joining h/p/slides below
    const groupFirst: { u: number; len: number; idx: number; col: number }[] = [];
    const add = (code: string, rest: boolean, group: TabNote[], u: number) => {
      const dots = code.endsWith('d') ? 1 : 0;
      const base = dots ? code.slice(0, -1) : code;
      const midis = pitched ? [...new Set(group.filter((n) => n.midi !== null).map((n) => n.midi!))].sort((a, b) => a - b) : [];
      const keys = !pitched ? [RHYTHM_KEY] : rest || !midis.length ? ['b/4'] : midis.map(vexKey);
      const rNote = new StaveNote({ keys, duration: base + (rest ? 'r' : ''), dots, clef: 'treble' });
      // RHYTHM_KEY sits low enough that VexFlow's own default would point the stem back up, towards
      // the tab — forced down instead, so it hangs into the row the way it visually needs to here.
      if (!rest && !pitched) rNote.setStemDirection(Stem.DOWN);
      if (dots) Dot.buildAndAttach([rNote], { all: true });
      // Unpitched: the notehead is a stand-in with no real meaning, so it's made invisible right here
      // — via the note's own per-key style, baked into its drawing, rather than trying to find and
      // hide its rendered SVG element afterwards. That needs a live, attached document to search
      // (Element.getSVGElement() is a plain document.getElementById()), which this drawing isn't yet:
      // it's drawn into a detached element first, on purpose (see drawTabScore's own doc comment), so
      // a stale or failed drawing is never visible even for a moment — only moved into the real page,
      // by the caller, once it's finished.
      // A whole note never gets a stem at all (VexFlow never draws one for 'w', by standard notation
      // convention) — with the notehead also hidden, as every other duration's is, there'd be nothing
      // left on the page to show it has any length at all. Left visible for 'w' specifically so it's
      // still the one duration that reads by its notehead rather than its stem.
      if (!rest && !pitched && base !== 'w') rNote.setKeyStyle(0, { fillStyle: 'transparent', strokeStyle: 'transparent' });
      rhythmTickables.push(rNote);
      // A rest in the tab row: a GhostNote occupies the right amount of time (for the rhythm/tab
      // columns to still line up) without drawing anything — VFTabNote's own .setGhost(true) is a
      // different, notational thing (an implied note shown in parens), not what's wanted here.
      const tNote = rest
        ? new GhostNote(base + (dots ? 'd' : ''))
        : new VFTabNote({ positions: group.map((n) => ({ str: n.string + 1, fret: n.harmonic ? `<${fretText(n.fret)}>` : fretText(n.fret) })), duration: base, dots }, false);
      // `dots` has to go in the constructor: a TabNote has no key properties for Dot.buildAndAttach to
      // hang a Dot on (it silently attaches nothing — measured), so attaching afterwards left the tab
      // note at the plain, undotted length. Its tick count then ran a sixteenth (or more) short of the
      // rhythm note's per dotted note, every later tab note landed in an earlier tick context than its
      // rhythm note, and the stems sat ~9.5px right of their fret numbers from the first dot onwards.
      if (!rest) {
        const real = tNote as InstanceType<typeof VFTabNote>;
        realTabs.push({ tNote: real, group });
        // Techniques written on a fret (bend, vibrato, tap — see tabSync's techniques()): VexFlow
        // modifiers on that note, drawn above the stave with the note itself. h/p/slides join two
        // notes, so they wait until every note of the bar exists (below, after drawing).
        group.forEach((n, k) => {
          // A pre-bend isn't one of VexFlow's (its bends all start with the curve up) — drawn by hand
          // below instead, once the note's own position is known.
          if (n.bend && !n.bend.pre) {
            const semis = n.bend.to - (n.fret ?? 0);
            const phrase = [{ type: Bend.UP, text: bendText(semis) }];
            if (n.bend.release !== undefined) phrase.push({ type: Bend.DOWN, text: '' });
            real.addModifier(new Bend(phrase), k);
          }
          if (n.harmonic) real.addModifier(new Annotation(n.harmonic === 'pinch' ? 'P.H.' : 'N.H.').setVerticalJustification(Annotation.VerticalJustify.TOP), k);
          if (n.vibrato) real.addModifier(new Vibrato(), k);
          if (n.tap) real.addModifier(new Annotation('T').setVerticalJustification(Annotation.VerticalJustify.TOP), k);
        });
      }
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
      if (pieces.length) groupFirst.push({ u: s, len, idx: rhythmTickables.length, col: group[0].col });
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
    // Tab drawn first, before the rhythm row underneath it, so the row's own notes can be measured
    // against the fret digits' *actual drawn position* right after — see the comment below, where
    // that measurement is used.
    const tabnotesBefore = host.querySelectorAll('g.vf-tabnote').length;
    // Every fret digit sits on its own small solid-white "eraser" rectangle (VexFlow's own, to blank
    // out the tab line it would otherwise cross) — always white, regardless of theme. Drawn in the
    // app's usual near-white currentColor, a digit there is nearly invisible on its own background;
    // a fixed dark fill, just for this pass, gives it the contrast the light rhythm row doesn't need
    // (nothing there sits on a forced-white patch).
    ctx.save();
    ctx.setFillStyle('#111');
    tabVoice.draw(ctx, tabStave);
    ctx.restore();
    const newTabnotes = [...host.querySelectorAll('g.vf-tabnote')].slice(tabnotesBefore);
    // Notation VexFlow has no modifier for, drawn straight into the SVG at each note's own measured
    // position (the fret's eraser rectangle — the same "ask the render" geometry used for the click
    // boxes below): pre-bends, picking / fingering marks above and below the strings, palm-mute runs.
    const drawNotation = () => {
      if (!introSvg) return;
      const NS = 'http://www.w3.org/2000/svg';
      const mk = (tag: string, attrs: Record<string, string | number>, text?: string) => {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
        if (text !== undefined) el.textContent = text;
        el.style.pointerEvents = 'none';
        introSvg.appendChild(el);
        return el;
      };
      const ink = { stroke: '#111', fill: 'none', 'stroke-width': 1 };
      const topY = tabStave.getYForLine(0);
      const botY = tabStave.getYForLine(tabStave.getNumLines() - 1);
      const rectOf = (i: number, k: number) => {
        const r = newTabnotes[i]?.querySelectorAll('rect')[k];
        return r ? { x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')), w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')) } : null;
      };
      const text = (str: string, x: number, y: number, size: number, extra: Record<string, string | number> = {}) => mk('text', { x, y, 'font-size': size, 'text-anchor': 'middle', fill: '#111', 'font-family': 'Academico, sans-serif', ...extra }, str);
      realTabs.forEach((rt, i) => {
        const r0 = rectOf(i, 0);
        if (!r0) return;
        const cx = r0.x + r0.w / 2;
        rt.group.forEach((n, k) => {
          // pre-bend: a straight arrow up from the fret (the string already bent before it's picked), the
          // curve down after it if it's released again
          if (n.bend?.pre) {
            const r = rectOf(i, k);
            if (!r) return;
            const x0 = r.x + r.w + 2;
            const y0 = r.y + r.h / 2;
            const top = y0 - 20;
            mk('path', { d: `M${x0} ${y0} L${x0} ${top + 2}`, ...ink });
            mk('polygon', { points: `${x0},${top} ${x0 - 3.5},${top + 7} ${x0 + 3.5},${top + 7}`, fill: '#111' });
            text(bendText(n.bend.to - (n.fret ?? 0)), x0, top - 3, 10);
            if (n.bend.release !== undefined) {
              mk('path', { d: `M${x0} ${top} Q${x0 + 14} ${top} ${x0 + 14} ${y0 - 7}`, ...ink });
              mk('polygon', { points: `${x0 + 14},${y0 - 1} ${x0 + 10.5},${y0 - 8} ${x0 + 17.5},${y0 - 8}`, fill: '#111' });
            }
          }
        });
        // Picking and fingering marks: stacked outwards from the strings when a note has more than one
        // on the same side (the line nearest the strings sits closest to them).
        for (const above of [true, false]) {
          const side = rt.group.flatMap((n) => n.marks ?? []).filter((m) => m.above === above);
          side.forEach((m, idx) => {
            const steps = above ? side.length - 1 - idx : idx;
            const y = above ? topY - 50 - steps * 15 : botY + 17 + steps * 15;
            if (m.kind === 'pick') text(m.text === 'D' ? '\ue610' : '\ue612', cx, y, 28, { 'font-family': 'Bravura, sans-serif' });
            else text(m.kind === 'rh' ? `[${m.text}]` : m.text, cx, y, 12);
          });
        }
      });
      // palm-mute runs, per side: "P.M." then a dashed line to the last muted note, ticked at the end
      for (const above of [true, false]) {
        let i = 0;
        while (i < realTabs.length) {
          const on = (j: number) => realTabs[j].group.some((n) => n.pm && n.pm.above === above);
          if (!on(i)) {
            i++;
            continue;
          }
          let j = i;
          while (j + 1 < realTabs.length && on(j + 1)) j++;
          const a = rectOf(i, 0);
          const b = rectOf(j, 0);
          if (a && b) {
            const lineY = above ? topY - 32 : botY + 26;
            const x0 = a.x + a.w / 2 - 6;
            const x1 = b.x + b.w + 6;
            const begins = pmRunStarts.has(realTabs[i].group[0].start);
            if (begins) text('P.M.', x0 + 13, lineY - 3, 10);
            const from = begins ? x0 + 28 : x0;
            if (x1 > from) {
              mk('path', { d: `M${from} ${lineY} L${x1} ${lineY} M${x1} ${lineY} L${x1} ${lineY + (above ? 5 : -5)}`, ...ink, 'stroke-dasharray': '3 3' });
            }
          }
          i = j + 1;
        }
      }
    };
    // Hammer-ons, pull-offs and slides: each joins a note to the previous note on the same string in
    // this bar. A join across a bar line isn't drawn (each bar is its own stave here).
    realTabs.forEach((cur, i) => {
      cur.group.forEach((n, k) => {
        if (!n.link) return;
        for (let j = i - 1; j >= 0; j--) {
          const fromIdx = realTabs[j].group.findIndex((m) => m.string === n.string);
          if (fromIdx === -1) continue;
          const notes = { firstNote: realTabs[j].tNote, lastNote: cur.tNote, firstIndexes: [fromIdx], lastIndexes: [k] };
          const tie = n.link === 'h' ? TabTie.createHammeron(notes) : n.link === 'p' ? TabTie.createPulloff(notes) : n.link === '/' ? TabSlide.createSlideUp(notes) : TabSlide.createSlideDown(notes);
          try {
            tie.setContext(ctx).draw();
          } catch {
            /* a join that can't be drawn is left out rather than losing the whole bar */
          }
          break;
        }
      });
    });
    drawNotation();
    const stavenotesBefore = host.querySelectorAll('g.vf-stavenote').length;
    // VexFlow places a stem-down note's own stem at its glyph's left edge, not its centre (the usual
    // convention: a stem attaches to one side of a real notehead, not through its middle), and every
    // placeholder note in this row is forced stem-down (see RHYTHM_KEY's own comment above). With no
    // real notehead for that convention to visually justify here, the result reads as the stem sitting
    // left of the fret number it times. The two voices share one time grid, so in principle the gap
    // should be predictable from each note's own pre-draw geometry (getStemX()) — in practice it
    // wasn't: a correction computed that way, before drawing, didn't land where it should have once
    // actually drawn. So this measures the real, drawn result instead and corrects that directly: the
    // same "ask the render, don't guess" approach already used for this file's other geometry fixes.
    //
    // Correcting *per note* (an early version of this) doesn't hold up once beaming is involved: a
    // beamed note's own stem isn't drawn as part of its note at all — StaveNote skips it entirely when
    // the note has a beam, since Beam.drawStems() draws every member note's stem itself once the whole
    // group's slope is known — so at the point each note finishes drawing, a beamed one simply has no
    // stem yet to measure. And even given that stem once the beam does draw it, nudging it on its own
    // would leave it visually detached from the beam line connecting it to its neighbours, which is
    // computed once from the *original* positions and never reshaped afterwards. Both knock out doing
    // this note-by-note for anything beamed.
    //
    // So instead: draw the whole row — every note, every beam — into one wrapping group, measure the
    // gap from a single reliable reference note once up front, and nudge that whole group by the one
    // shared amount. The gap turns out not to depend on which note it's measured from (confirmed by
    // comparing several notes of differing fret-digit width, all needing the identical correction),
    // consistent with its cause being a fixed drawing convention rather than anything note-specific —
    // so correcting the row as a single rigid block keeps every stem *and* every beam line that
    // connects them in exactly the same relative arrangement they were formatted in, just moved
    // together to where the tab digits actually are.
    const rhythmRowGroup = ctx.openGroup('tab-rhythm-row');
    rhythmVoice.draw(ctx, rhythmStave);
    beams.forEach((bm) => bm.setContext(ctx).draw());
    ctx.closeGroup();
    const newStavenotes = [...host.querySelectorAll('g.vf-stavenote')].slice(stavenotesBefore);
    // Beam.draw() opens one '.vf-beam' group per beam, in the same order as `beams`, and
    // Beam.drawStems() draws its member notes' stems inside it in the same order as the beam's own
    // `.notes` array — so a beamed note's stem can be found this way even though it's nowhere inside
    // that note's own '.vf-stavenote' group (see the big comment below for why it isn't there at all).
    const beamedStemOf = new Map<InstanceType<typeof StaveNote>, SVGGElement>();
    const newBeamGroups = [...rhythmRowGroup.querySelectorAll(':scope > g.vf-beam')] as SVGGElement[];
    beams.forEach((beam, bi) => {
      const stems = [...(newBeamGroups[bi]?.querySelectorAll(':scope > g.vf-stem') ?? [])] as SVGGElement[];
      beam.getNotes().forEach((note, ni) => {
        if (stems[ni]) beamedStemOf.set(note as InstanceType<typeof StaveNote>, stems[ni]);
      });
    });
    // newStavenotes lines up 1:1 with rhythmTickables (every StaveNote — rest or not — opens its own
    // group when drawn) but newTabnotes doesn't line up with tabTickables the same way: a rest there
    // is a GhostNote, which (deliberately — it draws nothing) never opens a group at all, so it
    // contributes no entry to newTabnotes. tabIdx tracks that separately, advancing only on an actual
    // tab note, to stay matched to the right one.
    let tabIdx = 0;
    // Only groupFirst's own idx values are a real note's *first* piece — a note too long for one
    // drawable length splits into more than one tickable (see splitLength), and only the first of
    // those represents the note itself for data-col/data-bar's purposes (clicking it to edit).
    const colByIdx = new Map(groupFirst.map((g) => [g.idx, g.col]));
    // TabNote doesn't override Element's generic getBoundingBox(), which reports Element's own
    // x/y fields — left at their class default of 0 here, since a TabNote positions itself via the
    // stave/string line it's drawn on, not those fields. Using it for notesOut (below) silently gave
    // every note the same y:0, off-stave position. The fret digit's own eraser rect is drawn exactly
    // where the digit actually ends up, so it's recorded here, per real note, as the one honest source
    // for notesOut's geometry too — the same "ask the render, don't guess" rect already used just below
    // to correct the rhythm row's horizontal alignment.
    const rectByIdx = new Map<number, { x: number; y: number; w: number; h: number }>();
    let rowDeltaFound = false;
    rhythmTickables.forEach((rt, i) => {
      // rest/not-rest always matches between the two at the same index — add() uses the same flag
      // for both pushes at once — so this also tells us whether tabTickables[i] had a group to count.
      const rest = rt.isRest();
      const tabGroup = rest ? undefined : (newTabnotes[tabIdx++] as SVGGElement | undefined);
      if (rest) return; // a rest centres on its own glyph already, nothing to correct, nothing to click
      const col = colByIdx.get(i);
      const rhythmGroup = newStavenotes[i] as SVGGElement | undefined;
      // Tagged on both the fret number and the stem, so a click lands the same note either way — read
      // back by deck.ts's click handler (event.target.closest('[data-col]')) to edit this note's own
      // rhythm letter without any coordinate math or scroll-offset accounting. VexFlow's SVGContext
      // sets pointer-events: none on the root SVG it creates (svgcontext.js), making the whole engraved
      // view click-through by default — overridden back to auto here, on just these two tagged
      // elements, so the rest of the notation stays inert and only real notes are clickable.
      if (col !== undefined) {
        tabGroup?.setAttribute('data-bar', String(bi));
        tabGroup?.setAttribute('data-col', String(col));
        if (tabGroup) tabGroup.style.pointerEvents = 'auto';
        rhythmGroup?.setAttribute('data-bar', String(bi));
        rhythmGroup?.setAttribute('data-col', String(col));
        if (rhythmGroup) rhythmGroup.style.pointerEvents = 'auto';
      }
      const tabRect = tabGroup?.querySelector('rect');
      if (tabRect) {
        rectByIdx.set(i, {
          x: Number(tabRect.getAttribute('x')),
          y: Number(tabRect.getAttribute('y')),
          w: Number(tabRect.getAttribute('width')),
          h: Number(tabRect.getAttribute('height')),
        });
      }
      // The reference note for the whole row's correction: the first real note, beamed or not — stop
      // at the first one found, since every note needs the same correction anyway. A row that's
      // entirely beamed (no unbeamed note anywhere to fall back on, e.g. all eighth-note pairs) needs
      // this to work for a beamed note too, not just skip it: its stem lives in its beam's own group
      // (beamedStemOf, built above), not in its own note group, so it's looked up there instead.
      if (rowDeltaFound) return;
      const stemGroup = rt.getBeam() ? beamedStemOf.get(rt) : rhythmGroup;
      const stemPath = stemGroup?.querySelector<SVGPathElement>(rt.getBeam() ? 'path' : '.vf-stem path');
      const stemD = stemPath?.getAttribute('d')?.match(/^M([\d.-]+)/);
      if (!tabRect || !stemD) return;
      const tabCentreX = Number(tabRect.getAttribute('x')) + Number(tabRect.getAttribute('width')) / 2;
      rhythmRowGroup.style.transform = `translateX(${tabCentreX - Number(stemD[1])}px)`;
      rowDeltaFound = true;
    });

    tabTickables.forEach((t, i) => {
      if (!Number.isNaN(startsOf[i])) map.push({ u: startsOf[i], x: t.getAbsoluteX() });
    });
    for (const g of groupFirst) {
      const rect = rectByIdx.get(g.idx);
      let bb: { getX(): number; getY(): number; getW(): number; getH(): number };
      if (rect) {
        bb = { getX: () => rect.x, getY: () => rect.y, getW: () => rect.w, getH: () => rect.h };
      } else {
        const boxes = tabTickables[g.idx].getModifierStartXY(0, 0); // fallback if getBoundingBox is unhelpful for a ghost-free tab note
        try {
          bb = tabTickables[g.idx].getBoundingBox();
        } catch {
          bb = { getX: () => boxes.x - 8, getY: () => boxes.y - 8, getW: () => 16, getH: () => 16 };
        }
      }
      notesOut.push({ u: g.u, len: g.len, x: bb.getX(), y: bb.getY(), w: bb.getW(), h: bb.getH(), bar: bi, col: g.col });
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
    // Belt and suspenders on the fret digits' own dark fill (see the #111 comment above): that relies
    // on the digits' own <text> inheriting fill from their enclosing <g> (VexFlow skips writing a
    // redundant attribute when a child's colour already matches its group's, leaning on ordinary SVG
    // inheritance to fill in the rest) — reported not to reach the page in one real-world dark-theme
    // run (Linux/WebKitGTK; never reproduced here in Chromium testing), fret digits invisible against
    // their white eraser rectangle exactly as if this whole mechanism had been skipped. Setting fill
    // directly, as an inline style, on every digit's own element removes any dependency on inheritance
    // or on exactly when a context's fill state was read, at the cost of doing it twice when it isn't
    // needed — cheap insurance against a real gap this app has no way to reproduce and confirm fixed.
    // The forced fill alone didn't fix that report, though, which points further upstream: Bravura is
    // a pure music-symbol font with no digit glyphs of its own — a fret number only appears at all by
    // falling through to Academico, VexFlow's bundled companion *text* font. Bravura-only glyphs (the
    // "TAB" label, the muted-note 'x' symbol) were confirmed fine in that same session, so the likely
    // gap is Academico specifically failing to load or render there — nothing left to fall through to,
    // so nothing draws. A plain, always-available generic family appended after both closes that gap
    // outright regardless of why Academico didn't come through.
    for (const el of svg.querySelectorAll<SVGTextElement>('.vf-tabnote text')) {
      el.style.fill = '#111';
      el.style.fontFamily = 'Bravura, Academico, sans-serif';
      // Centre the muted-note X on its string line. VexFlow puts its baseline on the whole pixel above
      // the line's true centre (a 1px line spans y..y+1, so its centre is y+0.5), and the glyph's own ink
      // sits a hair above its baseline (measured in Bravura: about 0.0078em, 0.25px at this size) —
      // together a visible ~0.75px high at this size. Nudged down by exactly that.
      if (el.textContent?.codePointAt(0) === 0xe263) el.setAttribute('y', String(Number(el.getAttribute('y')) + 0.5 + MUTED_X_INK_RISE_EM * ((MUTED_X_PT * 4) / 3)));
    }
  }
  return { map, notes: notesOut, width: total, height: ROW };
}
