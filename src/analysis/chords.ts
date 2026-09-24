// Chord detection: a pitch-class profile per beat, matched against major
// and minor triads (helped by the bass note), then smoothed with a Viterbi
// pass so chords don't flicker. Expect roughly 60–75% right on real songs:
// it's a draft to correct by ear, which is why every chord is editable.

import { BINS, chromaOf, type Cqt, CQT_FPS } from './cqt.ts';

/**
 * Take out the overtones lower notes are likely to produce (octave, 12th,
 * two octaves, the 17th…), so a loud bass note doesn't read as a chord of its own.
 */
function removeOvertones(c: Cqt): Cqt {
  const H: [number, number][] = [
    [12, 0.5],
    [19, 0.33],
    [24, 0.25],
    [28, 0.2],
    [31, 0.17],
  ];
  const out = new Float32Array(c.data.length);
  const mag = new Float32Array(BINS);
  for (let t = 0; t < c.frames; t++) {
    const o = t * BINS;
    for (let b = 0; b < BINS; b++) mag[b] = Math.sqrt(c.data[o + b]);
    for (let b = 0; b < BINS; b++) {
      let m = mag[b];
      for (const [off, w] of H) if (b >= off) m -= w * mag[b - off];
      out[o + b] = m > 0 ? m * m : 0;
    }
  }
  return { frames: c.frames, data: out };
}

export const QUALITIES = ['', 'm', '7', 'm7', 'maj7', 'sus2', 'sus4', 'dim', 'aug', '5', '6', 'm6', '9', 'add9'] as const;
export type Quality = (typeof QUALITIES)[number];

export interface Chord {
  start: number; // seconds
  end: number;
  /** 0 = C … 11 = B; -1 = no chord. */
  root: number;
  q: Quality;
  /** Bass note for slash chords (e.g. C/E), if set by hand. */
  bass?: number;
  /** Next-best guesses, for quick correction. */
  alts?: [number, Quality][];
  manual?: boolean;
}

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Keys written with sharps (major tonics; minor tonics are shifted up a minor third first). */
export function prefersSharps(key?: { tonic: number; mode: string }) {
  if (!key) return false;
  const major = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12;
  return [7, 2, 9, 4, 11, 6].includes(major); // G D A E B F♯
}

export function noteLetter(pc: number, sharps = false) {
  return (sharps ? SHARP : FLAT)[((pc % 12) + 12) % 12];
}

export function chordName(c: Pick<Chord, 'root' | 'q' | 'bass'>, shift = 0, sharps = false) {
  if (c.root < 0) return 'N.C.';
  const name = noteLetter(c.root + shift, sharps) + c.q;
  return c.bass != null && c.bass !== c.root ? `${name}/${noteLetter(c.bass + shift, sharps)}` : name;
}

// Detection vocabulary: major and minor triads (sevenths etc. are left to the ear).
const TEMPLATES: { root: number; q: Quality; v: Float64Array }[] = [];
for (let r = 0; r < 12; r++)
  for (const [q, iv] of [
    ['', [0, 4, 7]],
    ['m', [0, 3, 7]],
  ] as const) {
    const v = new Float64Array(12);
    v[r] = 1;
    v[(r + iv[1]) % 12] = 0.9;
    v[(r + iv[2]) % 12] = 0.8;
    const n = Math.hypot(...v);
    TEMPLATES.push({ root: r, q, v: v.map((x) => x / n) });
  }

const unit = (v: Float64Array) => {
  const n = Math.hypot(...v);
  return n > 1e-9 ? v.map((x) => x / n) : v;
};

/**
 * @param harm note energy of the harmonic parts (no drums; ideally no vocals)
 * @param beats beat times in seconds (an even half-second grid is used if empty)
 * @param bass note energy of a separate bass part, if there is one
 * @param bar which beat starts a bar, and beats per bar: chords usually change on the bar
 */
export function detectChords(harm: Cqt, beats: number[], bass?: Cqt, bar?: { downbeat: number; perBar: number }): Chord[] {
  const dur = harm.frames / CQT_FPS;
  let grid = beats.filter((b) => b >= 0 && b < dur);
  const onBeats = grid.length >= 4;
  if (!onBeats) grid = Array.from({ length: Math.ceil(dur / 0.5) }, (_, i) => i * 0.5);
  let shift = 0; // beat index offset after adding a start at 0
  if (grid[0] > 0.05) {
    grid.unshift(0);
    shift = 1;
  }
  // Changing chord costs least on a bar line, more mid-bar, most off the beat grid.
  const changeCost = (i: number) => {
    if (!bar || bar.perBar < 2 || !onBeats) return 2.2;
    const pos = (((i - shift - bar.downbeat) % bar.perBar) + bar.perBar) % bar.perBar;
    return pos === 0 ? 1.6 : bar.perBar % 2 === 0 && pos === bar.perBar / 2 ? 2.6 : 4;
  };
  const bounds = [...grid, dur];
  const segs = bounds.slice(0, -1).map((s, i) => [s, bounds[i + 1]] as const);

  // Features per beat, from the notes with likely overtones taken out.
  const clean = removeOvertones(harm);
  const energy: number[] = [];
  const treble: Float64Array[] = [];
  const low: Float64Array[] = [];
  for (const [s, e] of segs) {
    const t0 = s * CQT_FPS;
    const t1 = Math.max(t0 + 1, e * CQT_FPS);
    const tr = chromaOf(clean, t0, t1, 40, 84); // E2–C6: where chord tones sit
    const bs = chromaOf(bass ?? harm, t0, t1, 28, 52); // E1–E3: the bass note
    energy.push(tr.reduce((a, b) => a + b, 0) / (t1 - t0));
    // Compress so one loud note doesn't swamp the chord.
    treble.push(unit(tr.map((x) => Math.sqrt(x))));
    low.push(unit(bs.map((x) => x * x)));
  }
  const loud = [...energy].sort((a, b) => a - b)[Math.floor(energy.length * 0.9)] || 1;

  // Scores per beat per chord (+ "no chord" last).
  const S = TEMPLATES.length + 1;
  const score = segs.map((_, i) => {
    const out = new Float64Array(S);
    TEMPLATES.forEach((t, k) => {
      let d = 0;
      for (let p = 0; p < 12; p++) d += treble[i][p] * t.v[p];
      out[k] = d + 0.25 * low[i][t.root];
    });
    out[S - 1] = energy[i] < 0.04 * loud ? 2 : 0.45;
    return out;
  });

  // Viterbi: chords tend to last; changing costs a little.
  const K = 10;
  const n = segs.length;
  const back = new Int16Array(n * S);
  let prev = score[0].map((v) => v * K);
  for (let i = 1; i < n; i++) {
    let bestPrev = 0;
    for (let k = 1; k < S; k++) if (prev[k] > prev[bestPrev]) bestPrev = k;
    const cur = new Float64Array(S);
    for (let k = 0; k < S; k++) {
      const stay = prev[k];
      const move = prev[bestPrev] - changeCost(i);
      const from = stay >= move ? k : bestPrev;
      back[i * S + k] = from;
      cur[k] = Math.max(stay, move) + score[i][k] * K;
    }
    prev = cur;
  }
  const path = new Int16Array(n);
  let k = 0;
  for (let j = 1; j < S; j++) if (prev[j] > prev[k]) k = j;
  for (let i = n - 1; i >= 0; i--) {
    path[i] = k;
    k = back[i * S + k];
  }

  // Merge into chords, with alternatives ranked over each chord's span.
  const chords: Chord[] = [];
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && path[j + 1] === path[i]) j++;
    const st = path[i];
    const avg = new Float64Array(S);
    for (let b = i; b <= j; b++) for (let s = 0; s < S; s++) avg[s] += score[b][s];
    const ranked = [...avg.keys()].filter((s) => s < S - 1 && s !== st).sort((a, b) => avg[b] - avg[a]);
    const t = TEMPLATES[st];
    chords.push({
      start: +segs[i][0].toFixed(3),
      end: +segs[j][1].toFixed(3),
      root: st === S - 1 ? -1 : t.root,
      q: st === S - 1 ? '' : t.q,
      alts: ranked.slice(0, 4).map((s) => [TEMPLATES[s].root, TEMPLATES[s].q]),
    });
    i = j + 1;
  }
  return chords;
}

/** Join neighbours that are now the same chord (after an edit). */
export function mergeSame(chords: Chord[]): Chord[] {
  const out: Chord[] = [];
  for (const c of chords) {
    const p = out[out.length - 1];
    if (p && p.root === c.root && p.q === c.q && p.bass === c.bass) p.end = c.end;
    else out.push({ ...c });
  }
  return out;
}

/**
 * A plain-text chord chart: one line per section (from the markers), bars
 * separated by "|". Chords that change mid-bar share the bar.
 */
export function chordSheet(o: {
  title: string;
  chords: Chord[];
  beats: number[];
  downbeat: number;
  perBar: number;
  markers: { name: string; time: number }[];
  shift?: number;
  sharps?: boolean;
  keyName?: string;
  bpm?: number;
}): string {
  const { chords, beats, perBar } = o;
  const name = (c: Chord) => chordName(c, o.shift ?? 0, o.sharps);
  // Bar start times.
  const bars: number[] = [];
  if (beats.length > perBar) {
    for (let i = o.downbeat % perBar; i < beats.length; i += perBar) bars.push(beats[i]);
    if (bars[0] > 0.5) bars.unshift(Math.max(0, bars[0] - (beats[perBar] - beats[0])));
  } else {
    for (let t = 0; t < (chords.at(-1)?.end ?? 0); t += 2) bars.push(t);
  }
  const end = chords.at(-1)?.end ?? 0;
  const barText = (s: number, e: number) => {
    const inBar = chords.filter((c) => c.end > s + 0.05 && c.start < e - 0.05).map(name);
    const uniq = inBar.filter((x, i) => i === 0 || x !== inBar[i - 1]);
    return uniq.length ? uniq.join(' ') : '%';
  };
  const lines: string[] = [];
  const head = [
    o.title,
    [o.keyName ? `Key: ${o.keyName}` : '', o.bpm ? `${Math.round(o.bpm)} BPM` : '', o.shift ? `(transposed ${o.shift > 0 ? '+' : ''}${o.shift} st)` : '']
      .filter(Boolean)
      .join('   '),
  ];
  lines.push(...head.filter(Boolean), '');
  const sections = o.markers.length ? o.markers : [{ name: '', time: 0 }];
  if (sections[0].time > 0.5) sections.unshift({ name: '', time: 0 });
  sections.forEach((sec, si) => {
    const secEnd = sections[si + 1]?.time ?? end;
    const inSec = bars.map((b, i) => [b, bars[i + 1] ?? end] as const).filter(([b]) => b >= sec.time - 0.25 && b < secEnd - 0.25);
    if (!inSec.length) return;
    if (sec.name) lines.push(`[${sec.name}]`);
    let prevText = '';
    const cells = inSec.map(([s, e]) => {
      let t = barText(s, e);
      if (t === prevText && !t.includes(' '))
        t = '%'; // same as the last bar
      else prevText = t;
      return t;
    });
    for (let i = 0; i < cells.length; i += 4)
      lines.push(
        '| ' +
          cells
            .slice(i, i + 4)
            .map((c) => c.padEnd(8))
            .join('| ') +
          '|',
      );
    lines.push('');
  });
  return lines.join('\n');
}
