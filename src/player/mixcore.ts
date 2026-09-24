// Mixing, looping and time-stretch/pitch-shift, shared by the real-time
// AudioWorklet player and the offline "export mix" renderer.

import { SoundTouch } from 'soundtouchjs';

export type Stereo = [Float32Array, Float32Array];

const FEED = 1024;

/** Sums the stems with per-stem gains into interleaved stereo, honouring the loop. */
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
        const [l, r] = this.stems[s];
        for (let i = 0, j = written * 2, p = this.pos; i < n; i++, j += 2, p++) {
          target[j] += g * l[p];
          target[j + 1] += g * r[p];
        }
      }
      written += n;
      this.pos += n;
    }
    return written;
  }
}

export class Renderer {
  private st = new SoundTouch();
  private tmp = new Float32Array(0);
  private feed = new Float32Array(FEED * 2);
  tempo = 1;
  pitch = 0;
  /** Source position (frames) of the audio most recently output. */
  heard = 0;

  constructor(public src: MixSource) {}

  get bypass() {
    return this.tempo === 1 && this.pitch === 0;
  }

  seek(pos: number) {
    // Positions must be whole frames: they index the sample arrays.
    this.src.pos = Math.max(0, Math.min(Math.round(pos), this.src.end));
    this.heard = this.src.pos;
    this.src.resetPad();
    this.st.clear();
    this.st.inputBuffer.clear();
    this.st.outputBuffer.clear();
  }

  setTempoPitch(tempo: number, pitch: number) {
    const wasBypass = this.bypass;
    this.tempo = tempo;
    this.pitch = pitch;
    this.st.tempo = tempo;
    this.st.pitchSemitones = pitch;
    if (wasBypass !== this.bypass) this.seek(this.heard);
  }

  /** Fill planar output; returns frames produced (fewer at the end of the track). */
  render(outL: Float32Array, outR: Float32Array, frames: number): number {
    if (this.tmp.length < frames * 2) this.tmp = new Float32Array(frames * 2);
    const t = this.tmp;
    let n: number;
    if (this.bypass) {
      n = this.src.extract(t, frames);
      this.heard = this.src.pos;
    } else {
      // Feed the stretcher in small slices so no single audio callback does a lot of work.
      const st = this.st;
      while (st.outputBuffer.frameCount < frames) {
        const got = this.src.extract(this.feed, FEED);
        if (!got) break;
        st.inputBuffer.putSamples(this.feed, 0, got);
        st.process();
      }
      n = Math.min(frames, st.outputBuffer.frameCount);
      st.outputBuffer.receiveSamples(t, n);
      this.heard += n * this.tempo;
      const s = this.src;
      if (s.looping && this.heard >= s.loopEnd) this.heard = s.loopStart + ((this.heard - s.loopEnd) % (s.loopEnd - s.loopStart));
      this.heard = Math.min(this.heard, s.end);
    }
    for (let i = 0; i < n; i++) {
      outL[i] = t[2 * i];
      outR[i] = t[2 * i + 1];
    }
    return n;
  }
}

/** Offline render of [start, end) with the current gains, tempo and pitch. */
export function renderMix(stems: Stereo[], gains: number[], start: number, end: number, tempo: number, pitch: number): Stereo {
  start = Math.round(start);
  end = Math.round(end);
  const src = new MixSource(stems, gains, end);
  src.padEnd = 32768;
  const r = new Renderer(src);
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
