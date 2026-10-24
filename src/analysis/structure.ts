// Song structure: where the sections are (intro, verse, chorus ...) found from the music itself. Each bar is described by what it sounds
// like (its chords and its tone), every bar is compared with every other (a "self-similarity matrix": repeated music shows as stripes),
// section boundaries are where the music changes (a checkerboard "novelty" measure, after Foote 2000), and sections that sound alike
// are given the same letter. Names are then guessed from the pattern: the opening one that does not come back is an intro, the
// loudest repeated section a chorus, and so on. It is a suggestion for the player to accept or change, like the chords.
// No browser needed, so it is tested.

import { fft } from './beats.ts';

const N = 4096;
const HOP = 2048;
const CHROMA = 12;
const BANDS = 16;
const DIM = CHROMA + BANDS;

export interface BarFeatures {
  /** One vector per bar: what it sounds like. */
  feats: number[][];
  /** The loudness of each bar. */
  energy: number[];
}

const HANN = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

/**
 * What each bar sounds like: its chroma (which of the 12 notes are sounding) and a rough picture of its tone (16 bands), averaged over
 * the bar. `bars` are the frames each bar starts at; the last bar runs to `end`. Slow (it is an FFT over the whole song), so it gives
 * the screen a moment to breathe every so often.
 */
export async function barFeatures(mono: Float32Array, sr: number, bars: number[], end: number, yieldEvery = 150): Promise<BarFeatures> {
  const binHz = sr / N;
  const pc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = k * binHz;
    if (f >= 60 && f <= 2200) pc[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
  }
  // Log-spaced bands from 40 Hz to 8 kHz (as bin ranges).
  const edge = Array.from({ length: BANDS + 1 }, (_, i) => Math.max(1, Math.round((40 * Math.pow(8000 / 40, i / BANDS)) / binHz)));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const feats: number[][] = [];
  const energy: number[] = [];
  const bounds = [...bars, end];
  let frames = 0;
  for (let b = 0; b < bars.length; b++) {
    const acc = new Float64Array(DIM);
    let count = 0;
    let rms = 0;
    const s0 = bounds[b];
    const s1 = Math.min(bounds[b + 1], mono.length);
    for (let s = s0; s + N <= s1 || (s === s0 && s + N <= mono.length); s += HOP) {
      for (let i = 0; i < N; i++) {
        re[i] = mono[s + i] * HANN[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) {
        const m = Math.hypot(re[k], im[k]);
        const c = pc[k];
        if (c >= 0) acc[c] += m;
      }
      for (let j = 0; j < BANDS; j++) {
        let e = 0;
        for (let k = edge[j]; k < Math.max(edge[j] + 1, edge[j + 1]) && k < N / 2; k++) e += re[k] * re[k] + im[k] * im[k];
        acc[CHROMA + j] += Math.log1p(e);
      }
      let sq = 0;
      for (let i = 0; i < N; i += 8) sq += mono[s + i] * mono[s + i];
      rms += Math.sqrt(sq / (N / 8));
      count++;
      if (++frames % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const v = Array.from(acc, (x) => (count ? x / count : 0));
    const cn = Math.hypot(...v.slice(0, CHROMA)) || 1;
    for (let i = 0; i < CHROMA; i++) v[i] /= cn;
    feats.push(v);
    energy.push(count ? rms / count : 0);
  }
  return { feats, energy };
}

/** Each dimension scaled to zero mean and unit spread across the song, so no one feature (loud bands, say) drowns the rest. */
export function standardise(feats: number[][]): number[][] {
  if (!feats.length) return [];
  const d = feats[0].length;
  const mean = new Array<number>(d).fill(0);
  for (const f of feats) f.forEach((x, i) => (mean[i] += x / feats.length));
  const sd = new Array<number>(d).fill(0);
  for (const f of feats) f.forEach((x, i) => (sd[i] += (x - mean[i]) ** 2 / feats.length));
  return feats.map((f) => f.map((x, i) => (x - mean[i]) / (Math.sqrt(sd[i]) || 1)));
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** How alike every pair of bars sounds, from -1 to 1 (1 on the diagonal). */
export function selfSimilarity(z: number[][]): number[][] {
  return z.map((a) => z.map((b) => cosine(a, b)));
}

/** Where the music changes: high when the bars just before are alike each other and unlike the bars just after (Foote's checkerboard). */
export function novelty(S: number[][], g = 4): number[] {
  const n = S.length;
  const out = new Array<number>(n).fill(0);
  for (let i = g; i <= n - g; i++) {
    let v = 0;
    for (let u = -g; u < g; u++) {
      for (let w = -g; w < g; w++) {
        const sign = u < 0 === w < 0 ? 1 : -1;
        v += sign * S[i + u][i + w];
      }
    }
    out[i] = v / (4 * g * g);
  }
  return out;
}

/** Bar numbers (0 = first bar) where a new section starts, from the novelty peaks. Sections are at least `minLen` bars. */
export function boundaries(nov: number[], total: number, minLen = 4): number[] {
  const n = nov.length;
  const inner = nov.slice(1, n - 1);
  const mean = inner.reduce((a, b) => a + b, 0) / Math.max(1, inner.length);
  const sd = Math.sqrt(inner.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, inner.length)) || 1;
  const thr = mean + 0.5 * sd;
  const peaks: { i: number; v: number }[] = [];
  for (let i = 1; i < n - 1; i++) if (nov[i] > thr && nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1]) peaks.push({ i, v: nov[i] });
  peaks.sort((a, b) => b.v - a.v);
  const chosen: number[] = [];
  for (const p of peaks) {
    // Music is written in phrases of 4 bars: a boundary a bar off the phrase line is moved onto it.
    const snapped = Math.round(p.i / 4) * 4;
    const at = Math.abs(snapped - p.i) <= 1 && snapped > 0 ? snapped : p.i;
    if (at < minLen || at > total - minLen) continue;
    if (chosen.every((c) => Math.abs(c - at) >= minLen)) chosen.push(at);
  }
  return chosen.sort((a, b) => a - b);
}

export interface Segment {
  /** First bar, and one past the last. */
  a: number;
  b: number;
  /** A letter shared by sections that sound alike. */
  label: string;
  /** Average loudness (relative to the loudest bar of the song). */
  loud: number;
}

/**
 * The sections between the boundaries, with a letter for each: sections whose bars sound alike one after the other get the same one.
 * `similar` is how alike two sections must be (0 to 1; the average similarity of their bars, lined up from the start) to share a letter.
 */
export function segments(S: number[][], energy: number[], cuts: number[], similar = 0.5): Segment[] {
  const edges = [0, ...cuts, S.length];
  const spans = edges.slice(0, -1).map((a, i) => ({ a, b: edges[i + 1] }));
  const sim = (x: { a: number; b: number }, y: { a: number; b: number }) => {
    const len = Math.min(x.b - x.a, y.b - y.a);
    let t = 0;
    for (let k = 0; k < len; k++) t += S[x.a + k][y.a + k];
    return len ? t / len : 0;
  };
  const labels: number[] = [];
  const reps: { a: number; b: number }[] = [];
  for (const sp of spans) {
    let best = -1;
    let bestSim = similar;
    reps.forEach((r, i) => {
      const s = sim(sp, r);
      if (s > bestSim) {
        bestSim = s;
        best = i;
      }
    });
    if (best < 0) {
      reps.push(sp);
      labels.push(reps.length - 1);
    } else labels.push(best);
  }
  const top = Math.max(...energy, 1e-9);
  return spans.map((sp, i) => ({
    a: sp.a,
    b: sp.b,
    label: String.fromCharCode(65 + (labels[i] % 26)),
    loud: energy.slice(sp.a, sp.b).reduce((a, b) => a + b, 0) / Math.max(1, sp.b - sp.a) / top,
  }));
}

/**
 * Names for the sections, guessed from the pattern: an opening section that never comes back is an intro, a closing one an outro, the
 * loudest of the sections that repeat is the chorus, the other repeated one the verse, and what is left is a bridge or a plain
 * "Section". Repeats are numbered (Verse 1, Verse 2). These are guesses; the player changes them.
 */
export function nameSegments(segs: Segment[]): string[] {
  const count = new Map<string, number>();
  for (const s of segs) count.set(s.label, (count.get(s.label) ?? 0) + 1);
  const repeated = [...count.entries()].filter(([, n]) => n > 1).map(([l]) => l);
  const loudOf = (l: string) => {
    const xs = segs.filter((s) => s.label === l);
    return xs.reduce((a, s) => a + s.loud, 0) / xs.length;
  };
  repeated.sort((x, y) => loudOf(y) - loudOf(x));
  const role = new Map<string, string>();
  if (repeated[0]) role.set(repeated[0], 'Chorus');
  if (repeated[1]) role.set(repeated[1], 'Verse');
  const last = segs.length - 1;
  segs.forEach((s, i) => {
    if (role.has(s.label)) return;
    if (i === 0 && count.get(s.label) === 1 && segs.length > 2) role.set(s.label, 'Intro');
    else if (i === last && count.get(s.label) === 1 && segs.length > 2) role.set(s.label, 'Outro');
  });
  // At most one bridge: the longest section that appears once, in the second half of the song.
  const bridge = segs
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => !role.has(s.label) && count.get(s.label) === 1 && i >= segs.length / 3 && i < last)
    .sort((x, y) => y.s.b - y.s.a - (x.s.b - x.s.a) || y.i - x.i)[0];
  if (bridge) role.set(bridge.s.label, 'Bridge');
  // A quiet opening that comes back only at the very end (an intro and an outro that sound alike) is named as both.
  const ends = new Map<number, string>();
  const bookends = segs.length > 2 && segs[0].label === segs[last].label && count.get(segs[0].label) === 2 && !role.has(segs[0].label);
  if (bookends) {
    ends.set(0, 'Intro');
    ends.set(last, 'Outro');
  }
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  const baseOf = (s: Segment, i: number) => ends.get(i) ?? role.get(s.label) ?? `Section ${s.label}`;
  segs.forEach((s, i) => total.set(baseOf(s, i), (total.get(baseOf(s, i)) ?? 0) + 1));
  return segs.map((s, i) => {
    const base = baseOf(s, i);
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    return (total.get(base) ?? 1) > 1 ? `${base} ${k}` : base;
  });
}

export interface Suggested {
  name: string;
  /** First bar (0 = the first bar), and one past the last. */
  a: number;
  b: number;
  label: string;
}

/**
 * Intros and outros are short and often in the same key as what follows, so the music itself may not change much at their edge. What they
 * usually do is play softer, so a boundary is added after a quiet first four bars (or before a quiet last four) when the novelty found
 * none there.
 */
export function addEdgeCuts(cuts: number[], energy: number[]): number[] {
  const n = energy.length;
  const mean = (a: number, b: number) => energy.slice(a, b).reduce((x, y) => x + y, 0) / Math.max(1, b - a);
  const out = [...cuts];
  if (n >= 16 && !out.some((c) => c <= 6) && mean(0, 4) < 0.75 * mean(4, Math.min(n, 12))) out.push(4);
  if (n >= 16 && !out.some((c) => c >= n - 6) && mean(n - 4, n) < 0.7 * mean(Math.max(0, n - 12), n - 4)) out.push(n - 4);
  return out.sort((a, b) => a - b);
}

/** From per-bar features to named sections. Fewer than 16 bars is not enough to find a structure, and gives none. */
export function suggestSections(f: BarFeatures, minLen = 4): Suggested[] {
  if (f.feats.length < 16) return [];
  const S = selfSimilarity(standardise(f.feats));
  const cuts = addEdgeCuts(boundaries(novelty(S), f.feats.length, minLen), f.energy);
  const segs = segments(S, f.energy, cuts);
  const names = nameSegments(segs);
  return segs.map((s, i) => ({ name: names[i], a: s.a, b: s.b, label: s.label }));
}
