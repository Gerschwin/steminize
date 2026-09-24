// Per-stem EQ: optional low-cut and high-cut (4th-order Butterworth,
// 24 dB/octave, steep enough to pull a kick or hi-hats out of a drum stem)
// plus one peaking "focus" band. Standard RBJ biquads.

export interface EqParams {
  lowCut: number; // Hz, 0 = off
  highCut: number; // Hz, 0 = off
  freq: number; // focus centre, Hz
  gain: number; // focus boost/cut, dB (0 = off)
  q: number; // focus width (higher = narrower)
}

export const FLAT: EqParams = { lowCut: 0, highCut: 0, freq: 1000, gain: 0, q: 1 };

export const PRESETS: { name: string; hint: string; eq: EqParams }[] = [
  { name: 'Kick', hint: 'Only the lows of the drum stem', eq: { lowCut: 0, highCut: 130, freq: 60, gain: 4, q: 1 } },
  { name: 'Snare', hint: 'Body and crack, lows and cymbals trimmed', eq: { lowCut: 160, highCut: 5000, freq: 2500, gain: 4, q: 0.8 } },
  { name: 'Hi-hats', hint: 'Only the highs: hats and cymbals', eq: { lowCut: 6000, highCut: 0, freq: 1000, gain: 0, q: 1 } },
  { name: 'Bass on small speakers', hint: 'Lifts the upper harmonics so a bass line is audible on a laptop', eq: { lowCut: 40, highCut: 0, freq: 900, gain: 9, q: 0.7 } },
  { name: 'Vocal clarity', hint: 'Trims rumble, lifts presence', eq: { lowCut: 120, highCut: 0, freq: 3000, gain: 4, q: 1 } },
];

export const isFlat = (e?: EqParams) => !e || (!e.lowCut && !e.highCut && !e.gain);
export const sameEq = (a: EqParams, b: EqParams) =>
  a.lowCut === b.lowCut && a.highCut === b.highCut && a.gain === b.gain && (a.gain === 0 || (a.freq === b.freq && a.q === b.q));

type Coef = [number, number, number, number, number]; // b0 b1 b2 a1 a2 (a0 = 1)

function biquad(type: 'lp' | 'hp' | 'peak', f: number, q: number, sr: number, dB = 0): Coef {
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === 'peak') {
    const A = 10 ** (dB / 40);
    [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  } else {
    const k = type === 'lp' ? (1 - cos) / 2 : (1 + cos) / 2;
    [b0, b1, b2, a0, a1, a2] = [k, type === 'lp' ? 1 - cos : -(1 + cos), k, 1 + alpha, -2 * cos, 1 - alpha];
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

// Two cascaded sections with these Qs make a 4th-order Butterworth.
const BUTTER4 = [0.5412, 1.3066];

export function sections(e: EqParams, sr = 44100): Coef[] {
  const out: Coef[] = [];
  if (e.lowCut) for (const q of BUTTER4) out.push(biquad('hp', e.lowCut, q, sr));
  if (e.gain) out.push(biquad('peak', e.freq, e.q, sr, e.gain));
  if (e.highCut) for (const q of BUTTER4) out.push(biquad('lp', e.highCut, q, sr));
  return out;
}

/** Magnitude response in dB at the given frequencies (for drawing the curve). */
export function responseDb(e: EqParams, freqs: number[], sr = 44100): number[] {
  const secs = sections(e, sr);
  return freqs.map((f) => {
    const w = (2 * Math.PI * f) / sr;
    let mag = 1;
    for (const [b0, b1, b2, a1, a2] of secs) {
      const re = (c0: number, c1: number, c2: number) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
      const im = (c1: number, c2: number) => -(c1 * Math.sin(w) + c2 * Math.sin(2 * w));
      const num = Math.hypot(re(b0, b1, b2), im(b1, b2));
      const den = Math.hypot(re(1, a1, a2), im(a1, a2));
      mag *= num / den;
    }
    return 20 * Math.log10(Math.max(mag, 1e-6));
  });
}

/** Stateful stereo filter chain for one stem. */
export class StemEq {
  private coefs: Coef[] = [];
  private state = new Float64Array(0); // per section: L z1 z2, R z1 z2
  private params: EqParams = FLAT;

  set(e: EqParams | undefined) {
    const p = e ?? FLAT;
    if (sameEq(p, this.params)) return;
    this.params = { ...p };
    const next = sections(p);
    // Keep filter memory when the chain shape is unchanged (smooth slider moves).
    if (next.length !== this.coefs.length) this.state = new Float64Array(next.length * 4);
    this.coefs = next;
  }

  get active() {
    return this.coefs.length > 0;
  }

  reset() {
    this.state.fill(0);
  }

  /** Filter n samples of l and r in place. */
  process(l: Float32Array, r: Float32Array, n: number) {
    const st = this.state;
    for (let s = 0; s < this.coefs.length; s++) {
      const [b0, b1, b2, a1, a2] = this.coefs[s];
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? l : r;
        const o = s * 4 + c * 2;
        let z1 = st[o];
        let z2 = st[o + 1];
        for (let i = 0; i < n; i++) {
          const inp = x[i];
          const y = b0 * inp + z1;
          z1 = b1 * inp - a1 * y + z2;
          z2 = b2 * inp - a2 * y;
          x[i] = y;
        }
        st[o] = z1;
        st[o + 1] = z2;
      }
    }
  }
}
