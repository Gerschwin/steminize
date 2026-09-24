// Tempo and beat detection (after Ellis 2007 / librosa):
//   1. onset strength = positive spectral flux of the log spectrum, 100 frames/s
//   2. tempo = autocorrelation peak, weighted towards ~120 BPM
//   3. beats = dynamic programming that follows the onsets while keeping the
//      spacing close to the tempo (so it copes with gentle tempo drift)
//   4. bar start = the beat phase with the most low-frequency (kick) energy
// Run on the drum stem where there is one: it makes all of this far more reliable.

export const SR = 44100;
const N = 2048;
const HOP = 441; // 100 frames per second
export const FPS = SR / HOP;

export interface BeatAnalysis {
  bpm: number;
  beats: number[]; // seconds
  downbeat: number; // index into beats of the first bar start
  env: Float32Array; // onset strength (kept so tempo corrections can re-track quickly)
  low: Float32Array; // low-frequency onset strength (for bar detection)
}

export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/** Onset strength envelopes (full band and < 150 Hz), normalised. */
export function onsetEnvelope(mono: Float32Array): { env: Float32Array; low: Float32Array } {
  const frames = Math.floor(mono.length / HOP) + 1;
  const bins = N / 2;
  const lowBins = Math.ceil((150 * N) / SR);
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const env = new Float32Array(frames);
  const low = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    const start = t * HOP - N / 2; // frame t is centred on t * HOP
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < mono.length ? mono[idx] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    let lowFlux = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBins) lowFlux += d;
      }
    }
    env[t] = t ? flux : 0;
    low[t] = t ? lowFlux : 0;
    [prev, cur] = [cur, prev];
  }
  return { env: normalise(env), low: normalise(low) };
}

/** Subtract a 1-second running mean, rectify, scale to unit std. */
function normalise(x: Float32Array): Float32Array {
  const w = Math.round(FPS / 2);
  const out = new Float32Array(x.length);
  let sum = 0;
  const pre = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) pre[i + 1] = pre[i] + x[i];
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(x.length, i + w + 1);
    out[i] = Math.max(0, x[i] - (pre[b] - pre[a]) / (b - a));
    sum += out[i] * out[i];
  }
  const std = Math.sqrt(sum / Math.max(1, x.length)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= std;
  return out;
}

/** Most likely beat period in frames (float), from 60-200 BPM. */
export function estimatePeriod(env: Float32Array): number {
  const minLag = Math.floor((60 * FPS) / 200);
  const maxLag = Math.ceil((60 * FPS) / 60);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (env.length - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    // Reward lags whose double also correlates: favours the true beat over half-beats.
    const score = (ac[lag] + 0.5 * (ac[Math.min(2 * lag, maxLag + 1)] ?? 0)) * prior;
    if (score > bestScore) [bestScore, best] = [score, lag];
  }
  // Parabolic refinement.
  const [a, b, c] = [ac[best - 1], ac[best], ac[best + 1]];
  const d = a - 2 * b + c;
  return d < 0 ? best + (0.5 * (a - c)) / d : best;
}

/** Dynamic-programming beat tracker for a given period (frames). Returns beat frames. */
export function trackBeats(env: Float32Array, period: number, tightness = 100): number[] {
  const n = env.length;
  // Smooth the onsets with a Gaussian ~1/32 of a beat wide.
  const half = Math.round(period);
  const kernel = Array.from({ length: 2 * half + 1 }, (_, i) => Math.exp(-0.5 * (((i - half) * 32) / period) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < kernel.length; k++) {
      const j = i + k - half;
      if (j >= 0 && j < n) s += kernel[k] * env[j];
    }
    local[i] = s;
  }
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(2 * period);
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let tau = lo; tau <= hi; tau++) {
      const j = i - tau;
      if (j < 0) break;
      const v = score[j] - tightness * Math.log(tau / period) ** 2;
      if (v > best) [best, arg] = [v, j];
    }
    score[i] = local[i] + (arg >= 0 ? Math.max(0, best) : 0);
    back[i] = arg >= 0 && best > 0 ? arg : -1;
  }
  // Start from the best-scoring point in the final beat period.
  let end = n - 1;
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) if (score[i] > score[end]) end = i;
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) beats.push(i);
  beats.reverse();
  // Drop weak beats at the edges (silence before/after the music).
  const thr = 0.1 * (local.reduce((a, b) => a + b, 0) / n);
  while (beats.length && local[beats[0]] < thr) beats.shift();
  while (beats.length && local[beats[beats.length - 1]] < thr) beats.pop();
  return beats;
}

/** Which beat phase starts the bar: the one with the strongest kick energy. */
export function findDownbeat(low: Float32Array, beatFrames: number[], perBar: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let p = 0; p < perBar; p++) {
    let s = 0;
    let c = 0;
    for (let i = p; i < beatFrames.length; i += perBar) {
      const f = beatFrames[i];
      s += Math.max(low[f] ?? 0, low[f + 1] ?? 0, low[f - 1] ?? 0);
      c++;
    }
    if (c && s / c > bestScore) [bestScore, best] = [s / c, p];
  }
  return best;
}

const toSeconds = (frames: number[]) => frames.map((f) => Math.round((f / FPS) * 1000) / 1000);
/** Average tempo: least-squares slope of beat time against beat number. */
export const bpmOf = (beats: number[]) => {
  const n = beats.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = beats.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  beats.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  return Math.round((60 / (num / den)) * 10) / 10;
};

export function analyse(mono: Float32Array, perBar = 4): BeatAnalysis {
  const { env, low } = onsetEnvelope(mono);
  const period = estimatePeriod(env);
  return retrack({ env, low }, period, perBar);
}

/** Re-run tracking with a forced period (tap tempo, ½×, 2×). */
export function retrack(a: { env: Float32Array; low: Float32Array }, period: number, perBar = 4): BeatAnalysis {
  const frames = trackBeats(a.env, period);
  const beats = toSeconds(frames);
  return { bpm: bpmOf(beats), beats, downbeat: findDownbeat(a.low, frames, perBar), env: a.env, low: a.low };
}

export const periodForBpm = (bpm: number) => (60 * FPS) / bpm;
