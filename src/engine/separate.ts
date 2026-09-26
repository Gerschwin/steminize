// Pure separation maths, mirroring demucs.apply.apply_model:
// global normalisation, random-shift averaging ("shifts"), overlapping
// segments blended with a triangular window, and bags of specialist models.
// No browser or ONNX dependencies, so it can be unit-tested in Node.

export const SR = 44100;
export const SEGMENT = Math.floor(7.8 * SR); // 343,980 samples, fixed by the ONNX export
export const MAX_SHIFT = Math.floor(0.5 * SR);

export type Stereo = [Float32Array, Float32Array];

/** Runs the network on one planar stereo segment [L(SEGMENT), R(SEGMENT)].
 *  Returns [source][channel][SEGMENT] flattened. */
export type RunChunk = (input: Float32Array) => Promise<Float32Array>;

export interface Member {
  /** Loads the network (lazily, so specialist models can be loaded one at a time). */
  load: () => Promise<{ run: RunChunk; release: () => Promise<void> | void }>;
  /** Output rows this member is responsible for. */
  rows: number[];
}

export interface SeparateOptions {
  members: Member[];
  numSources: number;
  shifts: number;
  overlap: number;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  random?: () => number;
  /** Allocates the result arrays (the worker asks for SharedArrayBuffer-backed ones so handing them back needs no copy). */
  alloc?: (length: number) => Float32Array;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

export function chunkOffsets(total: number, overlap: number): number[] {
  const stride = Math.max(1, Math.floor((1 - overlap) * SEGMENT));
  const out: number[] = [];
  for (let o = 0; o < total; o += stride) out.push(o);
  return out.length ? out : [0];
}

let cachedWindow: Float32Array | null = null;
export function triangleWindow(): Float32Array {
  if (cachedWindow) return cachedWindow;
  const half = Math.floor(SEGMENT / 2);
  const max = Math.max(half, SEGMENT - half);
  const w = new Float32Array(SEGMENT);
  for (let i = 0; i < SEGMENT; i++) w[i] = (i < half ? i + 1 : SEGMENT - i) / max;
  return (cachedWindow = w);
}

export function countRuns(length: number, opts: Pick<SeparateOptions, 'members' | 'shifts' | 'overlap'>) {
  const shifts = Math.max(1, opts.shifts);
  const padded = length + (shifts > 1 ? MAX_SHIFT : 0);
  return opts.members.length * shifts * chunkOffsets(padded, opts.overlap).length;
}

/**
 * Apply one network across a whole (already normalised) signal, overlap-adding into `out`. Only the sources
 * that have arrays in `out` are kept (a specialist owns just its own rows), and `out` is filled in place, so a
 * caller with somewhere to put the result doesn't need a second copy of it.
 */
async function applyChunked(
  x: Stereo,
  run: RunChunk,
  overlap: number,
  tick: () => void,
  out: (Float32Array[] | undefined)[],
): Promise<void> {
  const T = x[0].length;
  const w = triangleWindow();
  const numSources = out.length;
  const sumW = new Float32Array(T);
  const input = new Float32Array(2 * SEGMENT);

  for (const offset of chunkOffsets(T, overlap)) {
    const len = Math.min(SEGMENT, T - offset);
    // Short final chunk: centre it and borrow real context either side (TensorChunk.padded).
    const left = Math.floor((SEGMENT - len) / 2);
    const start = offset - left;
    for (let c = 0; c < 2; c++) {
      const src = x[c];
      const dst = c * SEGMENT;
      for (let i = 0; i < SEGMENT; i++) {
        const idx = start + i;
        input[dst + i] = idx >= 0 && idx < T ? src[idx] : 0;
      }
    }
    const y = await run(input);
    for (let s = 0; s < numSources; s++) {
      const rows = out[s];
      if (!rows) continue;
      for (let c = 0; c < 2; c++) {
        const o = rows[c];
        const base = (s * 2 + c) * SEGMENT + left;
        for (let i = 0; i < len; i++) o[offset + i] += w[i] * y[base + i];
      }
    }
    for (let i = 0; i < len; i++) sumW[offset + i] += w[i];
    tick();
  }
  for (const src of out) if (src) for (const ch of src) for (let i = 0; i < T; i++) ch[i] /= sumW[i];
}

function meanStd(mix: Stereo) {
  const n = mix[0].length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (mix[0][i] + mix[1][i]) / 2;
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = (mix[0][i] + mix[1][i]) / 2 - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / Math.max(1, n - 1));
  return { mean, std: std > 1e-8 ? std : 1 };
}

/** Separate a 44.1 kHz stereo mix. Returns [source][channel] arrays. */
export async function separate(mix: Stereo, opts: SeparateOptions): Promise<Float32Array[][]> {
  const T = mix[0].length;
  const shifts = Math.max(1, Math.round(opts.shifts));
  const random = opts.random ?? Math.random;
  const total = countRuns(T, opts);
  let done = 0;
  const tick = () => {
    done++;
    opts.onProgress?.(done, total);
    if (opts.isCancelled?.()) throw new CancelledError();
  };

  const { mean, std } = meanStd(mix);
  const norm: Stereo = [new Float32Array(T), new Float32Array(T)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < T; i++) norm[c][i] = (mix[c][i] - mean) / std;

  const alloc = opts.alloc ?? ((n: number) => new Float32Array(n));
  const result = Array.from({ length: opts.numSources }, () => [alloc(T), alloc(T)]);
  // One network covering every source, no shifts: its overlap-added output IS the result, so it is written
  // straight into it instead of into a second full set of arrays that then gets summed in (about 40% less memory).
  const direct = shifts === 1 && opts.members.length === 1 && opts.members[0].rows.length === opts.numSources && new Set(opts.members[0].rows).size === opts.numSources;

  for (const member of opts.members) {
    if (opts.isCancelled?.()) throw new CancelledError();
    const net = await member.load();
    opts.onProgress?.(done, total); // the network is loaded: the caller can stop saying "loading"
    try {
      if (direct) {
        await applyChunked(norm, net.run, opts.overlap, tick, result);
        continue;
      }
      for (let k = 0; k < shifts; k++) {
        // Shift trick: delay the input by a random amount, then undo it.
        const d = shifts > 1 ? Math.floor(random() * MAX_SHIFT) : 0;
        let x = norm;
        if (d) {
          x = [new Float32Array(T + d), new Float32Array(T + d)];
          x[0].set(norm[0], d);
          x[1].set(norm[1], d);
        }
        // Only this member's rows are kept, so a specialist doesn't allocate (or sum) the ones it doesn't own.
        const y = Array.from({ length: opts.numSources }, (_, s) => (member.rows.includes(s) ? [new Float32Array(x[0].length), new Float32Array(x[0].length)] : undefined));
        await applyChunked(x, net.run, opts.overlap, tick, y);
        for (const row of member.rows) {
          for (let c = 0; c < 2; c++) {
            const dst = result[row][c];
            const src = y[row]![c];
            for (let i = 0; i < T; i++) dst[i] += src[i + d] / shifts;
          }
        }
      }
    } finally {
      await net.release();
    }
  }

  for (const src of result) for (const ch of src) for (let i = 0; i < T; i++) ch[i] = ch[i] * std + mean;
  return result;
}

export interface NamedStem {
  name: string;
  data: Stereo;
}

/**
 * Turn raw model output into the stems the user asked for.
 * - two-stem mode: [target, no_target]. "no_target" is the sum of the other
 *   stems when they were computed (as Demucs does), otherwise mix - target.
 * - otherwise: every stem not in `skip`.
 */
export function pickStems(
  raw: Float32Array[][],
  names: readonly string[],
  mix: Stereo,
  twoStems: string,
  computedRows: number[],
  skip: string[] = [],
): NamedStem[] {
  const T = mix[0].length;
  if (twoStems) {
    const t = names.indexOf(twoStems);
    if (t < 0) throw new Error(`Unknown stem "${twoStems}"`);
    const others = names.map((_, i) => i).filter((i) => i !== t);
    const allComputed = others.every((i) => computedRows.includes(i));
    const rest: Stereo = [new Float32Array(T), new Float32Array(T)];
    for (let c = 0; c < 2; c++) {
      const r = rest[c];
      if (allComputed) for (const i of others) for (let n = 0; n < T; n++) r[n] += raw[i][c][n];
      else for (let n = 0; n < T; n++) r[n] = mix[c][n] - raw[t][c][n];
    }
    return [
      { name: twoStems, data: raw[t] as Stereo },
      { name: `no_${twoStems}`, data: rest },
    ];
  }
  return names
    .map((name, i) => ({ name, data: raw[i] as Stereo }))
    .filter((s) => !skip.includes(s.name));
}
