// Chord diagrams: where to put your fingers for a chord on a guitar or ukulele, and which keys to press on a piano. No drawing
// here (see src/ui/chordDiagram.ts), so it can be tested. Common open chords come from a small table; every other chord is found
// by a search that keeps to a hand-sized stretch, always has the root as the lowest note, and sounds every note the chord needs.

import type { Quality } from './chords.ts';

export type Instrument = 'guitar' | 'ukulele' | 'piano';

/** The notes each chord is built from, as semitones above the root. */
export const CHORD_TONES: Record<Quality, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '9': [0, 4, 7, 10, 2],
  add9: [0, 4, 7, 2],
};

/** A fretted-instrument fingering: one fret per string, lowest string first (-1 = not played, 0 = open). */
export interface Shape {
  frets: number[];
  /** The fret the diagram starts at: 1 shows the nut, higher shows a position marker. */
  base: number;
  /** A finger laid across several strings, if the shape has one. */
  barre?: { fret: number; from: number; to: number };
}

/** Open string notes as MIDI numbers, lowest string first. The ukulele is the usual re-entrant G C E A (the G is the high one). */
const TUNING: Record<'guitar' | 'ukulele', number[]> = {
  guitar: [40, 45, 50, 55, 59, 64],
  ukulele: [67, 60, 64, 69],
};

/** The pitch classes (0-11) a chord needs: all its notes, except that a chord of four or more notes may leave out the fifth. */
export function neededTones(root: number, q: Quality): { all: number[]; need: number[] } {
  const iv = CHORD_TONES[q] ?? CHORD_TONES[''];
  const all = iv.map((i) => (root + i) % 12);
  const need = iv.length >= 4 ? iv.filter((i) => i !== 7).map((i) => (root + i) % 12) : all;
  return { all, need };
}

/** Works out the barre (if any) of a set of frets: the lowest fretted fret held by two or more strings with nothing open between them. */
function barreOf(frets: number[]): Shape['barre'] {
  const fretted = frets.filter((f) => f > 0);
  if (!fretted.length) return undefined;
  const lo = Math.min(...fretted);
  const on = frets.map((f, i) => (f === lo ? i : -1)).filter((i) => i >= 0);
  if (on.length < 2) return undefined;
  const from = on[0];
  const to = on[on.length - 1];
  for (let i = from; i <= to; i++) if (frets[i] === 0) return undefined; // an open string inside the span would be damped
  return { fret: lo, from, to };
}

/** How many fingers a fingering takes: a barre counts as one. */
function fingersFor(frets: number[]): number {
  const fretted = frets.filter((f) => f > 0).length;
  const b = barreOf(frets);
  return b ? fretted - frets.filter((f) => f === b.fret).length + 1 : fretted;
}

/** Turns a list of frets into a diagram: which fret it starts at, and any barre. */
export function shapeOf(frets: number[]): Shape {
  const fretted = frets.filter((f) => f > 0);
  const hi = fretted.length ? Math.max(...fretted) : 0;
  const lo = fretted.length ? Math.min(...fretted) : 1;
  return { frets, base: hi <= 5 ? 1 : lo, barre: barreOf(frets) };
}

// Common open guitar chords, written the usual way: lowest string first, x = not played.
const OPEN_GUITAR: Record<string, string> = {
  'C:': 'x32010', 'A:': 'x02220', 'G:': '320003', 'E:': '022100', 'D:': 'xx0232',
  'A:m': 'x02210', 'E:m': '022000', 'D:m': 'xx0231',
  'E:7': '020100', 'A:7': 'x02020', 'D:7': 'xx0212', 'G:7': '320001', 'C:7': 'x32310', 'B:7': 'x21202',
  'C:maj7': 'x32000', 'A:maj7': 'x02120', 'D:maj7': 'xx0222', 'F:maj7': 'xx3210', 'G:maj7': '320002',
  'A:m7': 'x02010', 'E:m7': '022030', 'D:m7': 'xx0211',
  'A:sus2': 'x02200', 'A:sus4': 'x02230', 'D:sus2': 'xx0230', 'D:sus4': 'xx0233', 'E:sus4': '022200',
  'C:add9': 'x32030', 'G:6': '320000', 'E:5': '022xxx', 'A:5': 'x022xx', 'D:5': 'xx023x',
};

// Common open ukulele chords, G string first.
const OPEN_UKULELE: Record<string, string> = {
  'C:': '0003', 'A:': '2100', 'F:': '2010', 'G:': '0232', 'D:': '2220', 'E:': '4442',
  'A:m': '2000', 'E:m': '0432', 'D:m': '2210', 'B:m': '4222',
  'C:7': '0001', 'G:7': '0212', 'A:7': '0100', 'D:7': '2223', 'E:7': '1202', 'F:7': '2313',
  'A:m7': '0000', 'D:m7': '2213', 'E:m7': '0202', 'C:maj7': '0002', 'F:maj7': '2410', 'G:maj7': '0222',
  'C:sus4': '0013', 'G:sus4': '0233',
};

// Movable barre shapes for the guitar, as offsets from the barre fret (-1 = not played): the root is on the low E string (E form) or the
// A string (A form), so the shape slides up the neck to any key.
const E_FORM: Partial<Record<Quality, number[]>> = {
  '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], '7': [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0], maj7: [0, 2, 1, 1, 0, 0],
  sus4: [0, 2, 2, 2, 0, 0], '5': [0, 2, 2, -1, -1, -1], '6': [0, 2, 2, 1, 2, 0], m6: [0, 2, 2, 0, 2, 0], '9': [0, 2, 0, 1, 0, 2], aug: [0, 3, 2, 1, 1, 0],
};
const A_FORM: Partial<Record<Quality, number[]>> = {
  '': [-1, 0, 2, 2, 2, 0], m: [-1, 0, 2, 2, 1, 0], '7': [-1, 0, 2, 0, 2, 0], m7: [-1, 0, 2, 0, 1, 0], maj7: [-1, 0, 2, 1, 2, 0],
  sus2: [-1, 0, 2, 2, 0, 0], sus4: [-1, 0, 2, 2, 3, 0], '5': [-1, 0, 2, 2, -1, -1], '6': [-1, 0, 2, 2, 2, 2], m6: [-1, 0, 2, 2, 1, 2],
  dim: [-1, 0, 1, 2, 1, -1], aug: [-1, 0, 3, 2, 2, 1],
};

/** The barre-chord fingering for a guitar chord: the E or A form, whichever sits nearer the nut. */
function barreChord(root: number, q: Quality): number[] | null {
  const tries: { f: number; form: number[] }[] = [];
  const e = E_FORM[q];
  const a = A_FORM[q];
  const fe = (root - 4 + 12) % 12;
  const fa = (root - 9 + 12) % 12;
  if (e && fe > 0) tries.push({ f: fe, form: e });
  if (a && fa > 0) tries.push({ f: fa, form: a });
  tries.sort((x, y) => x.f - y.f);
  const t = tries[0];
  return t && t.f <= 9 ? t.form.map((o) => (o < 0 ? -1 : t.f + o)) : null;
}

function parseFrets(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch === 'x' ? -1 : Number(ch));
  return out;
}

/** True if `frets` sound the chord: every needed note, nothing foreign, the bass note lowest (guitar). */
export function shapeIsRight(instrument: 'guitar' | 'ukulele', frets: number[], root: number, q: Quality, bass?: number): boolean {
  const tuning = TUNING[instrument];
  if (frets.length !== tuning.length) return false;
  const { all, need } = neededTones(root, q);
  const heard: number[] = [];
  let lowest = -1;
  frets.forEach((f, i) => {
    if (f < 0) return;
    const midi = tuning[i] + f;
    heard.push(midi % 12);
    if (lowest < 0) lowest = midi;
    else if (instrument === 'guitar' && midi < lowest) lowest = midi;
  });
  if (heard.some((p) => !all.includes(p))) return false;
  if (need.some((p) => !heard.includes(p))) return false;
  if (instrument === 'guitar' && lowest % 12 !== (bass ?? root)) return false;
  return true;
}

/** Every fingering for a chord within a hand's reach, best first. The best is the one nearest the nut with the fewest fingers and strings left out. */
function search(instrument: 'guitar' | 'ukulele', root: number, q: Quality, bass: number | undefined): number[] | null {
  const tuning = TUNING[instrument];
  const n = tuning.length;
  const { all } = neededTones(root, q);
  const isG = instrument === 'guitar';
  let best: { frets: number[]; score: number } | null = null;
  for (let base = 1; base <= 9; base++) {
    const options: number[][] = tuning.map((open) => {
      const o: number[] = [];
      if (isG || q === '5') o.push(-1);
      if (base <= 2 && all.includes(open % 12)) o.push(0);
      for (let f = base; f <= base + 3; f++) if (all.includes((open + f) % 12)) o.push(f);
      return o;
    });
    const cur: number[] = new Array(n).fill(-1);
    const go = (i: number) => {
      if (i === n) {
        const sounded = cur.filter((f) => f >= 0).length;
        if (sounded < (q === '5' ? 2 : isG ? 4 : 3)) return;
        if (isG) {
          const first = cur.findIndex((f) => f >= 0);
          const lastIdx = cur.length - 1 - [...cur].reverse().findIndex((f) => f >= 0);
          for (let k = first; k <= lastIdx; k++) if (cur[k] < 0) return; // no gaps between played strings
        }
        if (!shapeIsRight(instrument, cur, root, q, bass)) return;
        const fingers = fingersFor(cur);
        if (fingers > 4) return;
        const fretted = cur.filter((f) => f > 0);
        const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
        const opens = cur.filter((f) => f === 0).length;
        const muted = cur.filter((f) => f < 0).length;
        const hasFifth = cur.some((f, k) => f >= 0 && (tuning[k] + f) % 12 === (root + 7) % 12);
        const score = base * 2 + fingers * 1.5 + muted * 1.5 + span * 0.6 - opens * 0.5 + (barreOf(cur) ? 1.5 : 0) + (hasFifth || q === '5' ? 0 : 1.2);
        if (!best || score < best.score) best = { frets: [...cur], score };
        return;
      }
      for (const f of options[i]) {
        cur[i] = f;
        go(i + 1);
      }
      cur[i] = -1;
    };
    go(0);
    if (best && base >= 3) break; // a shape this far up the neck is only used if nothing nearer works
  }
  return best ? (best as { frets: number[] }).frets : null;
}

const cache = new Map<string, Shape | null>();

/** A fingering for a chord on a guitar or ukulele, or null if none could be found. `root` and `bass` are note numbers (0 = C). */
export function fretShape(instrument: 'guitar' | 'ukulele', root: number, q: Quality, bass?: number): Shape | null {
  const key = `${instrument}|${root}|${q}|${bass ?? ''}`;
  if (cache.has(key)) return cache.get(key)!;
  const letter = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][root];
  const table = instrument === 'guitar' ? OPEN_GUITAR : OPEN_UKULELE;
  let frets: number[] | null = null;
  const known = table[`${letter}:${q}`];
  if (known && (bass == null || bass === root || instrument === 'ukulele')) frets = parseFrets(known);
  if ((!frets || !shapeIsRight(instrument, frets, root, q, bass)) && instrument === 'guitar' && (bass == null || bass === root)) frets = barreChord(root, q);
  if (!frets || !shapeIsRight(instrument, frets, root, q, bass)) frets = search(instrument, root, q, bass) ?? (bass != null ? search(instrument, root, q, undefined) : null);
  const out = frets ? shapeOf(frets) : null;
  cache.set(key, out);
  return out;
}

/** The keys to press on a piano: semitones above the C at the left of a two-octave keyboard (0 to 22), lowest first. */
export function pianoKeys(root: number, q: Quality): number[] {
  const iv = CHORD_TONES[q] ?? CHORD_TONES[''];
  return iv.map((i) => root + (i % 12)).sort((a, b) => a - b); // kept within an octave of the root, so a ninth sits close in
}

const LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** How awkward a chord is on the guitar or ukulele: 0 for a common open chord, 1 for anything that needs a barre or a search. */
export function chordCost(instrument: 'guitar' | 'ukulele', root: number, q: Quality): number {
  const table = instrument === 'guitar' ? OPEN_GUITAR : OPEN_UKULELE;
  return `${LETTERS[((root % 12) + 12) % 12]}:${q}` in table ? 0 : 1;
}

/**
 * The capo position (0 to 7) that makes a song's chords easiest: the one where the most chord time is spent on common open shapes.
 * `chords` are the sounding chords with how long each lasts; a tie goes to the lower capo. Returns the cost of each position too.
 */
export function suggestCapo(instrument: 'guitar' | 'ukulele', chords: { root: number; q: Quality; dur: number }[]): { capo: number; costs: number[] } {
  const costs: number[] = [];
  for (let capo = 0; capo <= 7; capo++) {
    let c = 0;
    for (const ch of chords) if (ch.root >= 0) c += ch.dur * chordCost(instrument, ch.root - capo, ch.q);
    costs.push(c + capo * 0.02); // a small push towards no capo when it makes no difference
  }
  let best = 0;
  costs.forEach((c, i) => { if (c < costs[best] - 1e-9) best = i; });
  return { capo: best, costs };
}
