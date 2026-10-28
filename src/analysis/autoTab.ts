// Turns the notes found in a bass or guitar stem (Basic Pitch, see basicPitch.ts) into a draft tab for the Scratchpad: the notes are put
// on the song's own bar grid (the beats the app tracked), worked out as strings and frets, and written by the same code that writes an
// imported Guitar Pro file, so the result is the ordinary typed tab and everything that works on one works on it.
//
// It is a draft, not a transcription to trust: the notes are only as good as the audio-to-MIDI pass, the grid only as good as the beat
// tracking, and the fingering is the likeliest one, not the one the player used. Pure functions, no browser needed.

import { singleLine, type NoteEvent } from './basicPitch.ts';
import { scoreToTab, type Imported, type TBar, type TBeat, type TMasterBar, type TNote, type TScore } from '../import/tabImport.ts';
import { barSegments, tabBlocks, type TabAnchor } from '../lyrics/tabSync.ts';

export type TabInstrument = 'bass' | 'guitar';

/** How much of what the detector found to write: everything, or without the faint and the very short notes (mostly ringing strings and overtones). */
export type Detail = 'all' | 'balanced' | 'clean';
export const DETAILS: Detail[] = ['all', 'balanced', 'clean'];
/** Per level: notes quieter than this share of the typical note are dropped, and notes shorter than `short` of a beat that are also quieter than `softShare`. */
const FILTER: Record<Detail, { quiet: number; short: number; softShare: number } | null> = {
  all: null,
  balanced: { quiet: 0.55, short: 0.4, softShare: 0.8 },
  clean: { quiet: 0.75, short: 0.5, softShare: 1.5 },
};

/** Open-string pitches (MIDI), top row of the tab first. */
export const TUNINGS: Record<TabInstrument, number[]> = { bass: [43, 38, 33, 28], guitar: [64, 59, 55, 50, 45, 40] };
const MAX_FRET: Record<TabInstrument, number> = { bass: 21, guitar: 22 };
/** The most frets a hand is taken to cover at once (guitar chords). */
const SPAN = 4;
/** The most notes written at one moment. */
const MAX_CHORD = 5;
/** The pitch range to listen in, for the audio-to-MIDI pass. A little below the lowest string: those notes are moved up an octave. */
export const LISTEN: Record<TabInstrument, { minPitch: number; maxPitch: number; minNoteMs: number }> = {
  bass: { minPitch: 24, maxPitch: 67, minNoteMs: 70 },
  guitar: { minPitch: 38, maxPitch: 88, minNoteMs: 70 },
};

export interface BeatGrid {
  /** Beat times in seconds. */
  beats: number[];
  /** Index into `beats` of the first beat of a bar. */
  downbeat: number;
  perBar: number;
}

/** The beat number (fractional, 0 = the first tracked beat) at a time; the grid carries on at its first / last spacing outside the tracked beats. */
export function beatPos(beats: number[], t: number): number {
  const n = beats.length;
  if (n < 2) return 0;
  if (t <= beats[0]) return (t - beats[0]) / (beats[1] - beats[0]);
  if (t >= beats[n - 1]) return n - 1 + (t - beats[n - 1]) / (beats[n - 1] - beats[n - 2]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - beats[lo]) / (beats[hi] - beats[lo]);
}

/** The reverse of beatPos. */
export function beatTime(beats: number[], x: number): number {
  const n = beats.length;
  if (n < 2) return 0;
  if (x <= 0) return beats[0] + x * (beats[1] - beats[0]);
  if (x >= n - 1) return beats[n - 1] + (x - (n - 1)) * (beats[n - 1] - beats[n - 2]);
  const i = Math.floor(x);
  return beats[i] + (x - i) * (beats[i + 1] - beats[i]);
}

// ---------------------------------------------------------------- timing

/**
 * How far (seconds) to move the notes so they sit best on the sixteenth grid: the detector's onsets run a little early or late, and a
 * grid that is a few hundredths off turns half the notes into the wrong sixteenth. Only taken when it clearly helps.
 */
export function fitOffset(xs: number[], periods: number[], weights: number[]): number {
  if (!xs.length) return 0;
  const cost = (off: number) => {
    let c = 0;
    for (let i = 0; i < xs.length; i++) {
      const v = (xs[i] + off / periods[i]) * 4;
      c += weights[i] * Math.min(Math.abs(v - Math.round(v)), 0.5);
    }
    return c;
  };
  const base = cost(0);
  let best = 0;
  let bestCost = base;
  for (let ms = -70; ms <= 70; ms += 5) {
    const c = cost(ms / 1000);
    if (c < bestCost - 1e-9) {
      bestCost = c;
      best = ms / 1000;
    }
  }
  return bestCost < base * 0.9 ? best : 0;
}

/**
 * The detector sometimes splits one long note in two, the tail picking up again as a faint repeat of the same pitch. A note that is much
 * quieter than the typical one, on the pitch that has just stopped, is taken to be that: joined to the note before it, not written.
 */
export function mergeRetriggers(notes: NoteEvent[]): NoteEvent[] {
  if (notes.length < 3) return notes;
  const amps = notes.map((n) => n.amp).sort((a, b) => a - b);
  const quiet = 0.6 * amps[amps.length >> 1];
  const out: NoteEvent[] = [];
  const last = new Map<number, NoteEvent>();
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    const before = last.get(n.pitch);
    if (before && n.amp < quiet && n.start - before.end <= 0.06) {
      before.end = Math.max(before.end, n.end);
      continue;
    }
    const copy = { ...n };
    out.push(copy);
    last.set(n.pitch, copy);
  }
  return out;
}

// ---------------------------------------------------------------- fingering

interface Fingering {
  /** For each note (in the order given), the tab row (0 = top) and fret. */
  rows: number[];
  frets: number[];
  /** Where the hand is: the mean of the fretted notes, null when all are open strings. */
  pos: number | null;
  own: number;
}

/** Every way to play these pitches together on distinct strings within a hand's reach, lowest frets first. */
export function fingerings(pitches: number[], inst: TabInstrument): Fingering[] {
  const tuning = TUNINGS[inst];
  const max = MAX_FRET[inst];
  const out: Fingering[] = [];
  const used = tuning.map(() => false);
  const rows: number[] = [];
  const frets: number[] = [];
  const rec = (j: number, lo: number, hi: number) => {
    if (out.length >= 300) return;
    if (j === pitches.length) {
      const fretted = frets.filter((f) => f > 0);
      const pos = fretted.length ? fretted.reduce((a, b) => a + b, 0) / fretted.length : null;
      const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
      out.push({ rows: [...rows], frets: [...frets], pos, own: 0.04 * (pos ?? 0) + 0.3 * span });
      return;
    }
    const opts: [number, number][] = [];
    for (let r = 0; r < tuning.length; r++) {
      const f = pitches[j] - tuning[r];
      if (!used[r] && f >= 0 && f <= max) opts.push([r, f]);
    }
    opts.sort((a, b) => a[1] - b[1]);
    for (const [r, f] of opts) {
      const nlo = f > 0 ? Math.min(lo, f) : lo;
      const nhi = f > 0 ? Math.max(hi, f) : hi;
      if (nhi - nlo > SPAN) continue;
      used[r] = true;
      rows[j] = r;
      frets[j] = f;
      rec(j + 1, nlo, nhi);
      used[r] = false;
    }
  };
  rec(0, Infinity, -Infinity);
  return out;
}

/** What it costs the hand to go from one fingering to the next; less when there is time to move. */
function moveCost(a: Fingering, b: Fingering, gapBeats: number, single: boolean): number {
  const ease = 1 / (1 + gapBeats / 2);
  let c = a.pos !== null && b.pos !== null ? 0.55 * Math.min(Math.abs(a.pos - b.pos), 12) * ease : 0.1 * ease;
  if (single) c += 0.25 * Math.abs(a.rows[0] - b.rows[0]) * ease;
  return c;
}

/** The likeliest fingering of a run of chords (each a list of pitches): the cheapest path for the hand along the whole run. */
export function chooseFingerings(chords: { pitches: number[]; beat: number }[], inst: TabInstrument): (Fingering | null)[] {
  const options = chords.map((c) => {
    const all = fingerings(c.pitches, inst);
    return all.sort((a, b) => a.own - b.own).slice(0, 80);
  });
  const best: number[][] = [];
  const from: number[][] = [];
  let prev = -1; // the last event that has a fingering
  chords.forEach((c, i) => {
    if (!options[i].length) {
      best.push([]);
      from.push([]);
      return;
    }
    const costs: number[] = [];
    const back: number[] = [];
    for (let k = 0; k < options[i].length; k++) {
      if (prev < 0) {
        costs.push(options[i][k].own);
        back.push(-1);
        continue;
      }
      let bc = Infinity;
      let bj = -1;
      const gap = c.beat - chords[prev].beat;
      for (let j = 0; j < options[prev].length; j++) {
        const t = best[prev][j] + moveCost(options[prev][j], options[i][k], gap, c.pitches.length === 1 && chords[prev].pitches.length === 1);
        if (t < bc) {
          bc = t;
          bj = j;
        }
      }
      costs.push(bc + options[i][k].own);
      back.push(bj);
    }
    best.push(costs);
    from.push(back);
    prev = i;
  });
  // walk back from the cheapest end
  const out: (Fingering | null)[] = chords.map(() => null);
  let i = prev;
  if (i < 0) return out;
  let k = best[i].indexOf(Math.min(...best[i]));
  while (i >= 0) {
    out[i] = options[i][k];
    const nextK = from[i][k];
    let j = i - 1;
    while (j >= 0 && !options[j].length) j--;
    i = j;
    k = nextK;
  }
  return out;
}

// ---------------------------------------------------------------- bar anchors

/** Keeps the points a straight line between neighbours would miss by more than `tol` (Ramer–Douglas–Peucker), always the two ends. */
export function simplifyTimes(times: number[], tol: number): number[] {
  const n = times.length;
  if (n <= 2) return times.map((_, i) => i);
  const keep = new Set<number>([0, n - 1]);
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const line = times[a] + ((times[b] - times[a]) * (i - a)) / (b - a);
      const e = Math.abs(times[i] - line);
      if (e > worst) {
        worst = e;
        at = i;
      }
    }
    if (worst > tol) {
      keep.add(at);
      stack.push([a, at], [at, b]);
    }
  }
  return [...keep].sort((x, y) => x - y);
}

/** The character offset of the first column of each bar of a tab, in order. */
export function barStartOffsets(text: string): number[] {
  const lineStart: number[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    lineStart.push(at);
    at += line.length + 1;
  }
  const out: number[] = [];
  for (const b of tabBlocks(text)) {
    for (const [from, to] of barSegments(b)) {
      const ev = b.events?.find((e) => e.col >= from && e.col < to);
      out.push(lineStart[b.stringFirst] + (ev ? ev.col : from));
    }
  }
  return out;
}

// ---------------------------------------------------------------- the draft

export interface AutoTab {
  imp: Imported;
  /** Taps that time the tab: one at each bar where the song's tempo drifts from a straight line, at least the first and the last. */
  anchors: TabAnchor[];
  /** Time (seconds) of the first written bar, where the tab starts. */
  start: number;
  stats: { detected: number; written: number; moved: number; dropped: number; filtered: number; offsetMs: number; bars: number; /** Which bar of the tab the first note is in (1 = the first). */ firstNoteBar: number };
}

interface Ev {
  slot: number;
  notes: { pitch: number; amp: number; end: number }[];
}

const TICKS_16TH = 240;
const BEAT_TICKS = 960;

function tnote(row: number, fret: number, rows: number): TNote {
  return {
    string: rows - row,
    fret,
    isDead: false,
    isTieDestination: false,
    isPalmMute: false,
    vibrato: 0,
    harmonicType: 0,
    hammerPullOrigin: null,
    slideTarget: null,
    slideOutType: 0,
    bendPoints: null,
    percussionArticulation: 0,
  };
}

/** The tab for the notes of one stem on the song's bar grid. Null when there is nothing usable (no notes, or no beat grid). */
export function autoTab(notesIn: NoteEvent[], grid: BeatGrid, inst: TabInstrument, detail: Detail = 'balanced'): AutoTab | null {
  const { beats, downbeat, perBar } = grid;
  if (beats.length < 4 || perBar < 1) return null;
  const tuning = TUNINGS[inst];
  const low = tuning[tuning.length - 1];
  const high = tuning[0] + MAX_FRET[inst];
  const per16 = perBar * 4;

  const joined = mergeRetriggers(inst === 'bass' ? singleLine(notesIn) : notesIn);
  const secPerBeat = (t: number) => {
    const x = beatPos(beats, t);
    return beatTime(beats, x + 1) - beatTime(beats, x) || 0.5;
  };
  const f = FILTER[detail];
  const typical = joined.length ? [...joined].map((n) => n.amp).sort((a, b) => a - b)[joined.length >> 1] : 0;
  const src = f ? joined.filter((n) => n.amp >= f.quiet * typical && !((n.end - n.start) / secPerBeat(n.start) < f.short && n.amp < f.softShare * typical)) : joined;
  const filtered = joined.length - src.length;
  const xs = src.map((n) => beatPos(beats, n.start));
  const periods = xs.map((x) => beatTime(beats, x + 1) - beatTime(beats, x) || 0.5);
  const off = fitOffset(xs, periods, src.map((n) => Math.max(0.1, n.amp)));
  const slotOf = (x: number, i: number) => Math.round((x + off / periods[i]) * 4);

  // notes onto sixteenth slots (counted from the first beat of the bar grid)
  const minBar = Math.ceil(-downbeat / perBar);
  const events = new Map<number, Ev>();
  let moved = 0;
  let dropped = 0;
  src.forEach((n, i) => {
    const slot = slotOf(xs[i], i) - downbeat * 4;
    if (Math.floor(slot / per16) < minBar) {
      dropped++;
      return;
    }
    let pitch = n.pitch;
    while (pitch < low) {
      pitch += 12;
      moved++;
    }
    while (pitch > high) {
      pitch -= 12;
      moved++;
    }
    const end = slotOf(beatPos(beats, n.end), i) - downbeat * 4;
    const ev = events.get(slot) ?? { slot, notes: [] };
    events.set(slot, ev);
    const same = ev.notes.find((m) => m.pitch === pitch);
    if (same) {
      same.amp = Math.max(same.amp, n.amp);
      same.end = Math.max(same.end, end);
    } else ev.notes.push({ pitch, amp: n.amp, end });
  });
  const list = [...events.values()].sort((a, b) => a.slot - b.slot);
  const limit = inst === 'bass' ? 1 : MAX_CHORD;
  for (const ev of list) {
    if (ev.notes.length > limit) {
      dropped += ev.notes.length - limit;
      ev.notes = ev.notes.sort((a, b) => b.amp - a.amp).slice(0, limit);
    }
    ev.notes.sort((a, b) => b.pitch - a.pitch);
  }
  if (!list.length) return null;

  // fingering: drop the faintest note of a chord that cannot be played, then choose along the whole run
  let picks = chooseFingerings(
    list.map((e) => ({ pitches: e.notes.map((n) => n.pitch), beat: e.slot / 4 })),
    inst,
  );
  for (let i = 0; i < list.length; i++) {
    while (!picks[i] && list[i].notes.length > 1) {
      const faint = list[i].notes.reduce((a, b) => (b.amp < a.amp ? b : a));
      list[i].notes = list[i].notes.filter((n) => n !== faint);
      dropped++;
      picks = chooseFingerings(
        list.map((e) => ({ pitches: e.notes.map((n) => n.pitch), beat: e.slot / 4 })),
        inst,
      );
    }
  }

  // lengths: what the detector heard, but a note that stops within an eighth of the next one is held to it (reads better than a rest)
  const beatsOut = new Map<number, TBeat[]>();
  let written = 0;
  list.forEach((ev, i) => {
    const pick = picks[i];
    if (!pick) {
      dropped += ev.notes.length;
      return;
    }
    const bar = Math.floor(ev.slot / per16);
    const inBar = ev.slot - bar * per16;
    let reach = Math.max(ev.slot + 1, ...ev.notes.map((n) => n.end));
    const next = list[i + 1]?.slot;
    if (next !== undefined) reach = next - reach <= 2 ? next : Math.min(reach, next);
    reach = Math.min(reach, (bar + 1) * per16);
    const beat: TBeat = {
      isRest: false,
      graceType: 0,
      playbackStart: inBar * TICKS_16TH,
      playbackDuration: (reach - ev.slot) * TICKS_16TH,
      notes: ev.notes.map((_, k) => tnote(pick.rows[k], pick.frets[k], tuning.length)),
    };
    (beatsOut.get(bar) ?? beatsOut.set(bar, []).get(bar)!).push(beat);
    written += ev.notes.length;
  });
  const used = [...beatsOut.keys()];
  if (!used.length) return null;
  // The tab starts at the song's first bar (or the bar before it, when notes come in as a pick-up), not at the first bar with a note: bars of
  // rest are written until the part comes in, so bar numbers on the tab are the song's.
  const firstBar = Math.min(0, ...used);
  const lastBar = Math.max(...used);
  const count = lastBar - firstBar + 1;

  const masterBar: TMasterBar = {
    isRepeatStart: false,
    repeatCount: 0,
    alternateEndings: 0,
    timeSignatureNumerator: perBar,
    timeSignatureDenominator: 4,
    calculateDuration: () => perBar * BEAT_TICKS,
  };
  const bars: TBar[] = [];
  for (let b = firstBar; b <= lastBar; b++) bars.push({ voices: [{ beats: beatsOut.get(b) ?? [] }] });
  const score: TScore = {
    tempo: 60 / (beatTime(beats, downbeat + 1) - beatTime(beats, downbeat)),
    masterBars: Array.from({ length: count }, () => masterBar),
    tracks: [{ name: inst, staves: [{ tuning, bars }] }],
  };
  const imp = scoreToTab(score, 0, Array.from({ length: count }, (_, i) => i));

  // timing: where each bar starts in the recording (the notes were moved by `off` to fit the grid, so the recording is `off` earlier)
  const times = Array.from({ length: count }, (_, k) => beatTime(beats, downbeat + (firstBar + k) * perBar) - off);
  const offsets = barStartOffsets(imp.text);
  const anchors: TabAnchor[] =
    offsets.length === count
      ? simplifyTimes(times, 0.03).map((k) => ({ charOffset: offsets[k], time: times[k] }))
      : [{ charOffset: imp.firstNote, time: times[0] }];

  const lines: string[] = [];
  if (filtered) lines.push(`${filtered} faint or very short note${filtered === 1 ? '' : 's'} (usually strings ringing on, or overtones) ${filtered === 1 ? 'was' : 'were'} left out: choose Everything to keep ${filtered === 1 ? 'it' : 'them'}`);
  if (moved) lines.push(`${moved} note${moved === 1 ? '' : 's'} outside the ${tuning.length} strings' range ${moved === 1 ? 'was' : 'were'} moved by an octave to fit`);
  if (dropped) lines.push(`${dropped} note${dropped === 1 ? '' : 's'} that could not be played with the others (or fell before the first bar) ${dropped === 1 ? 'was' : 'were'} left out`);
  return {
    imp: { ...imp, notes: [...lines, ...imp.notes] },
    anchors,
    start: times[0],
    stats: { detected: notesIn.length, written, moved, dropped, filtered, offsetMs: Math.round(off * 1000), bars: count, firstNoteBar: Math.min(...used) - firstBar + 1 },
  };
}
