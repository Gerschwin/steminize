import type { ClipMode } from '../settings.ts';

export type Channels = [Float32Array, Float32Array];

/** Same clipping policies as the Demucs CLI (--clip-mode). */
export function applyClip(ch: Channels, mode: ClipMode): Channels {
  if (mode === 'none') return ch;
  if (mode === 'clamp') {
    return ch.map((c) => c.map((v) => (v > 0.99 ? 0.99 : v < -0.99 ? -0.99 : v))) as Channels;
  }
  let peak = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  const scale = 1 / Math.max(1.01 * peak, 1);
  return scale === 1 ? ch : (ch.map((c) => c.map((v) => v * scale)) as Channels);
}

/** Float [-1,1] to signed integers of the given bit depth (saturating). */
export function toInt(x: Float32Array, bits: 16 | 24): Int32Array {
  const max = bits === 16 ? 32767 : 8388607;
  const out = new Int32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(x[i] * max);
    out[i] = v > max ? max : v < -max - 1 ? -max - 1 : v;
  }
  return out;
}
