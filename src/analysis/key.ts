// Key detection: average chroma (energy per pitch class) of the harmonic
// stems, correlated against the Krumhansl-Kessler major/minor key profiles.
// Drums are left out: they add noise to every pitch class.

import { fft } from './beats.ts';

export interface KeyResult {
  tonic: number; // 0 = C ... 11 = B
  mode: 'major' | 'minor';
  /** Correlation margin over the runner-up (0-1). Below ~0.05 is a guess. */
  confidence: number;
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

export function keyName(k: { tonic: number; mode: string }, shift = 0) {
  const t = (((k.tonic + shift) % 12) + 12) % 12;
  return `${(k.mode === 'major' ? MAJOR_NAMES : MINOR_NAMES)[t]} ${k.mode}`;
}

/** 12-bin chroma averaged over the song (each frame normalised so loud parts don't dominate). */
export function chroma(mono: Float32Array, sr = 44100): Float64Array {
  const D = 4; // work at 11 kHz: plenty for pitches below 2 kHz
  const srd = sr / D;
  const x = new Float32Array(Math.floor(mono.length / D));
  for (let i = 0; i < x.length; i++) x[i] = (mono[i * D] + mono[i * D + 1] + mono[i * D + 2] + mono[i * D + 3]) / 4;
  const N = 8192;
  const hop = 4096;
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * srd) / N;
    if (f < 55 || f > 2000) continue;
    binPc[k] = (((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12);
  }
  const total = new Float64Array(12);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const frame = new Float64Array(12);
  for (let s = 0; s + N <= x.length; s += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = x[s + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    frame.fill(0);
    for (let k = 1; k < N / 2; k++) if (binPc[k] >= 0) frame[binPc[k]] += Math.sqrt(Math.hypot(re[k], im[k]));
    const norm = Math.hypot(...frame);
    if (norm > 1e-6) for (let p = 0; p < 12; p++) total[p] += frame[p] / norm;
  }
  return total;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i] / 12;
    mb += b[i] / 12;
  }
  let n = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db || 1);
}

export function detectKey(mono: Float32Array): KeyResult | undefined {
  const c = chroma(mono);
  if (c.every((v) => v === 0)) return undefined;
  const scores: { tonic: number; mode: 'major' | 'minor'; r: number }[] = [];
  for (let t = 0; t < 12; t++) {
    const rot = (p: number[]) => Array.from({ length: 12 }, (_, i) => p[(i - t + 12) % 12]);
    scores.push({ tonic: t, mode: 'major', r: pearson(c, rot(MAJOR)) });
    scores.push({ tonic: t, mode: 'minor', r: pearson(c, rot(MINOR)) });
  }
  scores.sort((a, b) => b.r - a.r);
  return { tonic: scores[0].tonic, mode: scores[0].mode, confidence: Math.round((scores[0].r - scores[1].r) * 1000) / 1000 };
}
