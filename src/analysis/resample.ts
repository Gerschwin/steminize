// Halve the sample rate with a windowed-sinc low-pass filter. Used to get
// audio down to the rates the note view (11 kHz and below) and the
// audio-to-MIDI model (22.05 kHz) work at.

const kernels = new Map<number, Float32Array>();

/** Low-pass at a quarter of the input rate (Blackman-windowed sinc, `taps` odd). */
function halfband(taps: number) {
  let k = kernels.get(taps);
  if (k) return k;
  k = new Float32Array(taps);
  const m = (taps - 1) / 2;
  const fc = 0.23; // cycles/sample: pass up to 0.23 × input rate, stop by 0.27
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - m;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    k[i] = sinc * w;
    sum += k[i];
  }
  for (let i = 0; i < taps; i++) k[i] /= sum;
  kernels.set(taps, k);
  return k;
}

/** Filter and keep every second sample (output length ⌈n/2⌉, time-aligned with the input). */
export function decimate2(x: Float32Array, taps = 63): Float32Array {
  const k = halfband(taps);
  const m = (taps - 1) / 2;
  const n = x.length;
  const out = new Float32Array(Math.ceil(n / 2));
  for (let o = 0; o < out.length; o++) {
    const s = 2 * o - m;
    let acc = 0;
    if (s >= 0 && s + taps <= n) {
      for (let j = 0; j < taps; j++) acc += k[j] * x[s + j];
    } else {
      for (let j = Math.max(0, -s); j < Math.min(taps, n - s); j++) acc += k[j] * x[s + j];
    }
    out[o] = acc;
  }
  return out;
}

/** Halve the rate `times` times. */
export function decimate(x: Float32Array, times: number, taps = 63) {
  for (let i = 0; i < times; i++) x = decimate2(x, taps);
  return x;
}

/** Mono sum of stereo stems, each scaled by a gain. */
export function monoOf(stems: { data: Float32Array[] }[], gains?: number[]) {
  const n = stems[0]?.data[0].length ?? 0;
  const out = new Float32Array(n);
  stems.forEach((s, j) => {
    const g = (gains?.[j] ?? 1) / 2;
    if (!g) return;
    const [l, r] = s.data;
    for (let i = 0; i < n; i++) out[i] += (l[i] + r[i]) * g;
  });
  return out;
}
