// Note energy over time: one bin per semitone (a constant-Q transform).
// Worked out an octave at a time, halving the sample rate for each lower
// octave, so the long windows the bass notes need stay cheap.

import { decimate } from './resample.ts';

export const NOTE_LO = 28; // E1, the bottom string of a bass
export const NOTE_HI = 96; // C7
export const BINS = NOTE_HI - NOTE_LO + 1;
const BASE_SR = 11025; // 44.1 kHz ÷ 4
const HOP = 512; // at BASE_SR: ~21.5 frames a second
export const CQT_FPS = BASE_SR / HOP;
/** Window length in cycles of the note: 25 separates neighbouring semitones cleanly. */
const Q = 25;

export interface Cqt {
  frames: number;
  /** Power per frame per semitone, frame-major: data[t * BINS + (note - NOTE_LO)]. */
  data: Float32Array;
}

const midiHz = (n: number) => 440 * 2 ** ((n - 69) / 12);

/** `mono` at 44.1 kHz. */
export function cqt(mono: Float32Array, sr = 44100): Cqt {
  // Only notes below ~0.1 × each stage's rate matter, so short filters do.
  const down = Math.round(Math.log2(sr / BASE_SR));
  let x = down > 0 ? decimate(decimate(mono, 1, 15), down - 1, 23) : mono;
  const frames = Math.max(1, Math.ceil(x.length / HOP));
  const data = new Float32Array(frames * BINS);
  for (let o = 0; ; o++) {
    const top = NOTE_HI - 12 * o;
    if (top < NOTE_LO) break;
    if (o > 0) x = decimate(x, 1, 23);
    const rate = BASE_SR / 2 ** o;
    const hop = HOP / 2 ** o;
    for (let n = Math.max(NOTE_LO, top - 11); n <= top; n++) {
      const f = midiHz(n);
      const N = Math.ceil((Q * rate) / f) | 1;
      const half = (N - 1) / 2;
      const re = new Float32Array(N);
      const im = new Float32Array(N);
      let wsum = 0;
      for (let j = 0; j < N; j++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (j + 0.5)) / N);
        wsum += w;
        re[j] = w * Math.cos((2 * Math.PI * f * (j - half)) / rate);
        im[j] = -w * Math.sin((2 * Math.PI * f * (j - half)) / rate);
      }
      // Normalise so a sine of amplitude a reads a² / 4 whatever the window.
      const norm = 1 / (wsum * wsum);
      const b = n - NOTE_LO;
      for (let t = 0; t < frames; t++) {
        const c = Math.round(t * hop - half);
        const lo = Math.max(0, -c);
        const hi = Math.min(N, x.length - c);
        let sr_ = 0;
        let si = 0;
        for (let j = lo; j < hi; j++) {
          const v = x[c + j];
          sr_ += v * re[j];
          si += v * im[j];
        }
        data[t * BINS + b] = (sr_ * sr_ + si * si) * norm;
      }
    }
  }
  return { frames, data };
}

/** Pitch-class profile (12 bins, C = 0) of frames [t0, t1), optionally limited to notes [lo, hi]. */
export function chromaOf(c: Cqt, t0: number, t1: number, lo = NOTE_LO, hi = NOTE_HI): Float64Array {
  const out = new Float64Array(12);
  t0 = Math.max(0, Math.floor(t0));
  t1 = Math.min(c.frames, Math.ceil(t1));
  for (let t = t0; t < t1; t++) for (let n = Math.max(lo, NOTE_LO); n <= Math.min(hi, NOTE_HI); n++) out[n % 12] += Math.sqrt(c.data[t * BINS + n - NOTE_LO]);
  return out;
}

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const noteName = (n: number) => `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
