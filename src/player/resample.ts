// Streaming sample-rate conversion for the player's output, so the audio context can run at the sound
// card's own rate (no second conversion in the system) while the songs stay at 44.1 kHz.
//
// Cubic (Catmull-Rom) interpolation, one block at a time with the fractional position carried between
// blocks, so any block size gives the same output.

export class StreamResampler {
  /** Source frames consumed per output frame. */
  private readonly ratio: number;
  private bufL = new Float32Array(256);
  private bufR = new Float32Array(256);
  /** Valid source frames in buf; index 0 is a history sample, so the cubic can look one back. */
  private have = 1;
  /** Read position in buf, in source frames. */
  private phase = 1;
  private ended = false;

  constructor(srcRate: number, dstRate: number) {
    this.ratio = srcRate / dstRate;
  }

  /** Forget everything buffered (after a seek, a new song or a restart). */
  reset() {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.have = 1;
    this.phase = 1;
    this.ended = false;
  }

  /**
   * Fills `frames` output frames. `pull(L, R, n)` writes `n` source frames and returns false once the
   * source has run out (what it wrote is still used). Returns false after the source ended.
   */
  render(pull: (L: Float32Array, R: Float32Array, n: number) => boolean, outL: Float32Array, outR: Float32Array, frames: number): boolean {
    const need = Math.ceil(this.phase + frames * this.ratio) + 3;
    if (need > this.have) {
      if (need > this.bufL.length) {
        const grow = (a: Float32Array) => {
          const b = new Float32Array(need * 2);
          b.set(a.subarray(0, this.have));
          return b;
        };
        this.bufL = grow(this.bufL);
        this.bufR = grow(this.bufR);
      }
      const n = need - this.have;
      if (!pull(this.bufL.subarray(this.have, need), this.bufR.subarray(this.have, need), n)) this.ended = true;
      this.have = need;
    }
    const l = this.bufL;
    const r = this.bufR;
    for (let i = 0; i < frames; i++) {
      const p = this.phase + i * this.ratio;
      const k = Math.floor(p);
      const t = p - k;
      outL[i] = cubic(l[k - 1], l[k], l[k + 1], l[k + 2], t);
      outR[i] = cubic(r[k - 1], r[k], r[k + 1], r[k + 2], t);
    }
    this.phase += frames * this.ratio;
    const drop = Math.floor(this.phase) - 1;
    if (drop > 0) {
      l.copyWithin(0, drop, this.have);
      r.copyWithin(0, drop, this.have);
      this.have -= drop;
      this.phase -= drop;
    }
    return !this.ended;
  }
}

function cubic(ym1: number, y0: number, y1: number, y2: number, t: number): number {
  const c1 = 0.5 * (y1 - ym1);
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
  return ((c3 * t + c2) * t + c1) * t + y0;
}
