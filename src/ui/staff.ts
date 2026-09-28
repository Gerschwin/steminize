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

/** Draws the score into `host` (replacing what was there) and returns where things landed. Draws twice:
 * once at a deliberately roomy guess just to measure the actual ink (a low open string and a note
 * twenty frets up the top string sit many ledger lines apart, and how many ledger lines any given tab
 * needs isn't known ahead of time), then again at a height and baseline fitted to that — instead of a
 * fixed guess that either clips a wide-ranging tab or leaves a narrow-ranging one swimming in space.
 * The measuring pass needs the real rendered geometry (a note's own bounding box, from VexFlow's glyph
 * metrics, turned out not to include its stem/flag/beam — under-measuring exactly the parts most likely
 * to reach furthest from the staff), which in turn needs `host` attached to the document: `host` is
 * normally kept off-document until the caller is ready for it (so a stale drawing is never visible even
 * for a moment), so it's attached off-screen just for the measuring pass, then returned to how it was. */
export async function drawStaff(host: HTMLElement, notes: TabNote[], bars: TabBar[]): Promise<StaffLayout> {
  vex ??= import('vexflow/bravura');
  const vf = await vex;
  const wasConnected = host.isConnected;
  const prevStyle = host.getAttribute('style');
  if (!wasConnected) {
    host.style.cssText = 'position:fixed; visibility:hidden; left:-99999px; top:0; pointer-events:none;';
    document.body.appendChild(host);
  }
  await render(vf, host, notes, bars, 260, 130);
  const svg = host.querySelector('svg');
  const bbox = svg?.getBBox();
  if (!wasConnected) {
    host.remove();
    if (prevStyle === null) host.removeAttribute('style');
    else host.setAttribute('style', prevStyle);
  }
  if (!bbox || !bbox.height) return render(vf, host, notes, bars, 260, 130); // nothing drawn: keep the roomy guess
  const PAD = 6;
  const staveY = 130 - bbox.y + PAD; // shift so the ink's own top lands PAD below the new row's top
  const rowHeight = Math.ceil(bbox.height) + PAD * 2;
  return render(vf, host, notes, bars, rowHeight, staveY);
}

/** Draws one pass. */
async function render(
  vf: Awaited<NonNullable<typeof vex>>,
  host: HTMLElement,
  notes: TabNote[],
  bars: TabBar[],
  ROW: number,
  staveY: number,
): Promise<StaffLayout> {
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
