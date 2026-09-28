// Standard notation for the Scratchpad's Tab pane: draws the parsed tab (see lyrics/tabSync.ts
// parseScore) as one long line of bars, and says where each note landed on the page so the deck can
// slide it past a fixed cursor in step with the music. VexFlow is big, so it is only loaded the first
// time a staff is asked for.

import type { TabBar, TabNote } from '../lyrics/tabSync.ts';

export interface StaffLayout {
  /** Where the music at each moment (sixteenth notes from the tab's start) sits across the drawing, in px. */
  map: { u: number; x: number }[];
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

/** Draws the score into `host` (replacing what was there) and returns where things landed. */
export async function drawStaff(host: HTMLElement, notes: TabNote[], bars: TabBar[]): Promise<StaffLayout> {
  vex ??= import('vexflow/bravura');
  const { Renderer, Stave, StaveNote, Voice, Formatter, Accidental, Dot, Beam } = await vex;
  host.replaceChildren();
  const ROW = 170; // room for the ledger lines guitar notes need above and below the staff
  const CLEF = 64;
  const widthOf = (b: TabBar) => Math.max(96, b.length * 14 + 40);
  const total = CLEF + bars.reduce((n, b) => n + widthOf(b), 0) + 20;
  const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(total, ROW);
  const ctx = renderer.getContext();
  ctx.setFillStyle('currentColor');
  ctx.setStrokeStyle('currentColor');

  const map: { u: number; x: number }[] = [];
  let x = 0;
  bars.forEach((bar, bi) => {
    const w = widthOf(bar) + (bi === 0 ? CLEF : 0);
    const stave = new Stave(x, 30, w);
    if (bi === 0) stave.addClef('treble', 'default', '8vb');
    stave.setContext(ctx).draw();

    // the notes that start in this bar, grouped into chords by start time
    const inBar = notes.filter((n) => n.bar === bi && n.midi !== null);
    const groups = new Map<number, TabNote[]>();
    for (const n of inBar) groups.set(n.start, [...(groups.get(n.start) ?? []), n]);
    const starts = [...groups.keys()].sort((a, b) => a - b);

    const tickables: InstanceType<typeof StaveNote>[] = [];
    const startsOf: number[] = []; // parallel to tickables: the tab time of each drawn note (rests: NaN)
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
    x += w;
  });
  // (the end of the music: one more point so the cursor has somewhere to finish)
  const last = bars[bars.length - 1];
  if (last) map.push({ u: last.start + last.length, x: total - 20 });
  map.sort((a, b) => a.u - b.u);
  const svg = host.querySelector('svg');
  if (svg) {
    svg.style.overflow = 'visible';
    svg.style.display = 'block';
  }
  return { map, width: total, height: ROW };
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
