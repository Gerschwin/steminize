// Mixing, looping and time-stretch/pitch-shift, shared by the real-time
// AudioWorklet player and the offline "export mix" renderer.

import { Stretch } from './stretch.ts';
import type { StretchConfig } from './stretchConfig.ts';
import { StemEq, type EqParams } from './eq.ts';

export type Stereo = [Float32Array, Float32Array];

/** A short click: 1.5 kHz on bar starts, 1 kHz on other beats. */
export const CLICK_LEN = Math.round(0.04 * 44100);
function makeClick(freq: number) {
  const c = new Float32Array(CLICK_LEN);
  for (let i = 0; i < CLICK_LEN; i++) c[i] = Math.sin((2 * Math.PI * freq * i) / 44100) * Math.exp(-i / 330) * 0.6;
  return c;
}
export const CLICK_HI = makeClick(1500);
export const CLICK_LO = makeClick(1000);

export interface ClickTrack {
  beats: number[]; // source frames
  downbeat: number; // index of a bar start in beats
  perBar: number;
  vol: number;
}

/**
 * Pan law: 0 keeps the stem's original stereo image; moving towards ±1
 * crossfades to the stem summed to mono and placed with a constant-power pan,
 * so ±1 puts the whole stem in one ear at the same loudness.
 * Returns [LfromL, LfromR, RfromL, RfromR].
 */
export function panMatrix(pan: number): [number, number, number, number] {
  const p = Math.max(-1, Math.min(1, pan || 0));
  const w = Math.abs(p);
  const theta = ((p + 1) * Math.PI) / 4;
  const gl = Math.SQRT2 * Math.cos(theta) * 0.5 * w;
  const gr = Math.SQRT2 * Math.sin(theta) * 0.5 * w;
  return [1 - w + gl, gl, gr, 1 - w + gr];
}

/** Sums the stems with per-stem gains and pans into interleaved stereo, honouring the loop. */
export class MixSource {
  pos = 0;
  loopOn = false;
  loopStart = 0;
  loopEnd = 0;
  /** Silent frames emitted after the end (lets the stretcher flush its tail). */
  padEnd = 0;
  private padded = 0;
  resetPad() {
    this.padded = 0;
  }

  pans: number[] = [];
  /** Metronome mixed into the source, so it is stretched in step with the music. */
  click: ClickTrack | null = null;
  private eqs: StemEq[] = [];
  private tmpL = new Float32Array(0);
  private tmpR = new Float32Array(0);

  setEqs(params: (EqParams | undefined)[]) {
    params.forEach((p, i) => (this.eqs[i] ??= new StemEq()).set(p));
  }

  /** Clear filter memory (after a seek, so old audio doesn't ring on). */
  resetEqs() {
    for (const e of this.eqs) e?.reset();
  }

  constructor(
    public stems: Stereo[],
    public gains: number[],
    public end: number,
  ) {}

  get looping() {
    return this.loopOn && this.loopEnd - this.loopStart > 1024;
  }

  extract(target: Float32Array, numFrames: number): number {
    let written = 0;
    while (written < numFrames) {
      const stop = this.looping ? this.loopEnd : this.end;
      if (this.pos >= stop) {
        if (this.looping) {
          this.pos = this.loopStart;
          continue;
        }
        const n = Math.min(numFrames - written, this.padEnd - this.padded);
        if (n <= 0) break;
        target.fill(0, written * 2, (written + n) * 2);
        this.padded += n;
        written += n;
        continue;
      }
      const n = Math.min(numFrames - written, stop - this.pos);
      target.fill(0, written * 2, (written + n) * 2);
      for (let s = 0; s < this.stems.length; s++) {
        const g = this.gains[s] ?? 0;
        if (!g) continue;
        let [l, r] = this.stems[s];
        let p0 = this.pos;
        const eq = this.eqs[s];
        if (eq?.active) {
          if (this.tmpL.length < n) [this.tmpL, this.tmpR] = [new Float32Array(n), new Float32Array(n)];
          this.tmpL.set(l.subarray(p0, p0 + n));
          this.tmpR.set(r.subarray(p0, p0 + n));
          eq.process(this.tmpL, this.tmpR, n);
          [l, r, p0] = [this.tmpL, this.tmpR, 0];
        }
        const pan = this.pans[s] ?? 0;
        if (!pan) {
          for (let i = 0, j = written * 2, p = p0; i < n; i++, j += 2, p++) {
            target[j] += g * l[p];
            target[j + 1] += g * r[p];
          }
        } else {
          const [a, b, c, d] = panMatrix(pan).map((k) => k * g);
          for (let i = 0, j = written * 2, p = p0; i < n; i++, j += 2, p++) {
            target[j] += a * l[p] + b * r[p];
            target[j + 1] += c * l[p] + d * r[p];
          }
        }
      }
      if (this.click?.vol) this.addClicks(target, written, this.pos, n);
      written += n;
      this.pos += n;
    }
    return written;
  }

  private addClicks(target: Float32Array, offset: number, pos: number, n: number) {
    const { beats, downbeat, perBar, vol } = this.click!;
    // First beat whose click could still be sounding at `pos`.
    let lo = 0;
    let hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] + CLICK_LEN <= pos) lo = mid + 1;
      else hi = mid;
    }
    for (let b = lo; b < beats.length && beats[b] < pos + n; b++) {
      const wave = (((b - downbeat) % perBar) + perBar) % perBar === 0 ? CLICK_HI : CLICK_LO;
      const start = Math.max(pos, beats[b]);
      const end = Math.min(pos + n, beats[b] + CLICK_LEN);
      for (let p = start; p < end; p++) {
        const v = vol * wave[p - beats[b]];
        const j = (offset + p - pos) * 2;
        target[j] += v;
        target[j + 1] += v;
      }
    }
  }
}

export class Renderer {
  private tmp = new Float32Array(0);
  private feed = new Float32Array(0);
  private output = new Float32Array(0);
  private carry = 0;
  private seekPos = 0;
  /** Input wraps since the last seek, used to place the delayed output within the loop. */
  private loopTurns = 0;
  tempo = 1;
  pitch = 0;
  forceStretch = false;
  /** Source position (frames) of the audio most recently output. */
  heard = 0;

  constructor(public src: MixSource, private st: Stretch | null) {
    this.st?.reset();
  }

  get bypass() {
    return !this.forceStretch && this.tempo === 1 && this.pitch === 0;
  }

  /** Source frame currently audible after the stretcher's input latency. */
  audible() {
    if (!this.src.looping) return this.bypass ? this.heard : Math.max(this.seekPos, Math.min(this.heard, this.heard - this.st!.inputLatency));
    const length = this.src.loopEnd - this.src.loopStart;
    const played = this.playedInLoop(length);
    return this.src.loopStart + ((played - this.src.loopStart) % length);
  }

  private playedInLoop(length: number) {
    return Math.max(this.seekPos, this.heard + this.loopTurns * length - (this.bypass ? 0 : this.st!.inputLatency));
  }

  /** Passes whose boundary has reached the output, rather than just the input. */
  audiblePasses() {
    if (!this.src.looping) return 0;
    const length = this.src.loopEnd - this.src.loopStart;
    return Math.floor((this.playedInLoop(length) - this.src.loopStart) / length);
  }

  seek(pos: number) {
    // Positions must be whole frames: they index the sample arrays.
    this.src.pos = Math.max(0, Math.min(Math.round(pos), this.src.end));
    this.heard = this.src.pos;
    this.seekPos = this.heard;
    this.loopTurns = 0;
    this.src.resetPad();
    this.src.resetEqs();
    this.st?.reset();
    this.carry = 0;
  }

  setTempoPitch(tempo: number, pitch: number) {
    const wasBypass = this.bypass;
    this.tempo = tempo;
    this.pitch = pitch;
    this.st?.setPitch(pitch);
    if (wasBypass !== this.bypass) this.seek(this.heard);
  }

  /** Fill planar output; returns frames produced (fewer at the end of the track). */
  render(outL: Float32Array, outR: Float32Array, frames: number): number {
    if (this.tmp.length < frames * 2) this.tmp = new Float32Array(frames * 2);
    const t = this.tmp;
    let n: number;
    if (this.bypass) {
      n = this.src.extract(t, frames);
      this.heard = this.src.looping ? this.heard + n : this.src.pos;
    } else {
      if (!this.st) throw new Error('Signalsmith Stretch is not loaded');
      const want = frames * this.tempo + this.carry;
      const take = Math.floor(want);
      this.carry = want - take;
      if (this.feed.length < take * 2) this.feed = new Float32Array(take * 2);
      if (this.output.length < frames * 2) this.output = new Float32Array(frames * 2);
      const got = this.src.extract(this.feed, take);
      this.feed.fill(0, got * 2, take * 2);
      this.st.process(this.feed, take, this.output, frames);
      n = got === take ? frames : Math.min(frames, Math.round(got / this.tempo));
      for (let i = 0; i < n * 2; i++) t[i] = this.output[i];
      this.heard += got;
    }
    const s = this.src;
    if (s.looping && this.heard >= s.loopEnd) {
      const length = s.loopEnd - s.loopStart;
      this.loopTurns += Math.floor((this.heard - s.loopStart) / length);
      this.heard = s.loopStart + ((this.heard - s.loopStart) % length);
    }
    this.heard = Math.min(this.heard, s.end);
    for (let i = 0; i < n; i++) {
      outL[i] = t[2 * i];
      outR[i] = t[2 * i + 1];
    }
    return n;
  }
}

/** Offline render of [start, end) with the current gains, tempo and pitch. */
export async function renderMix(
  stems: Stereo[],
  gains: number[],
  start: number,
  end: number,
  tempo: number,
  pitch: number,
  pans: number[] = [],
  eqs: (EqParams | undefined)[] = [],
  stretch?: StretchConfig,
): Promise<Stereo> {
  start = Math.round(start);
  end = Math.round(end);
  const src = new MixSource(stems, gains, end);
  src.pans = pans;
  src.setEqs(eqs);
  src.padEnd = 32768;
  const r = new Renderer(src, tempo === 1 && pitch === 0 ? null : await Stretch.create(stretch));
  r.setTempoPitch(tempo, pitch);
  r.seek(start);
  const expected = Math.round((end - start) / tempo);
  const out: Stereo = [new Float32Array(expected), new Float32Array(expected)];
  const block = 8192;
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  let o = 0;
  while (o < expected) {
    const n = r.render(bl, br, Math.min(block, expected - o));
    if (!n) break;
    out[0].set(bl.subarray(0, n), o);
    out[1].set(br.subarray(0, n), o);
    o += n;
  }
  return out;
}
