// Playback sequencing on top of the Renderer: loop passes, a pause between
// passes (gap + count-in), and the speed trainer. Used by the AudioWorklet
// player; kept free of Web Audio so it can be tested in Node.

import { CLICK_HI, CLICK_LEN, CLICK_LO, type Renderer } from './mixcore.ts';

const SR = 44100;

export interface Trainer {
  on: boolean;
  from: number; // tempo ratio, e.g. 0.7
  to: number; // e.g. 1
  step: number; // e.g. 0.05
  every: number; // passes per step
}

export interface Practice {
  gap: number; // seconds of silence between loop passes
  countIn: boolean; // one bar of clicks before each pass / before play
  perBar: number;
  beats: number[]; // source frames (empty = tempo unknown)
  downbeat: number;
  click: boolean;
  clickVol: number;
  trainer: Trainer;
}

export const DEFAULT_PRACTICE: Practice = {
  gap: 0,
  countIn: false,
  perBar: 4,
  beats: [],
  downbeat: 0,
  click: false,
  clickVol: 0.5,
  trainer: { on: false, from: 0.7, to: 1, step: 0.05, every: 1 },
};

export class Transport {
  loop = { on: false, start: 0, end: 0 };
  p: Practice = { ...DEFAULT_PRACTICE };
  /** Completed loop passes (reported so the UI can show trainer progress). */
  passes = 0;
  private pauseLeft = 0;
  private pauseLen = 0;
  private pauseClicks: { at: number; accent: boolean }[] = [];
  private length: number;

  constructor(public r: Renderer) {
    this.length = r.src.end;
  }

  get looping() {
    return this.loop.on && this.loop.end - this.loop.start > 1024;
  }
  get pausing() {
    return this.pauseLeft > 0;
  }

  setLoop(on: boolean, start: number, end: number) {
    this.loop = { on, start: Math.round(start), end: Math.round(end) };
    const src = this.r.src;
    src.loopOn = false; // passes are sequenced here instead
    src.end = this.looping ? this.loop.end : this.length;
    if (!this.looping) this.pauseLeft = 0;
    if (this.looping && (this.r.heard < this.loop.start || this.r.heard >= this.loop.end)) this.r.seek(this.loop.start);
    this.passes = 0;
  }

  setPractice(p: Practice) {
    const trainerStarted = p.trainer.on && !this.p.trainer.on;
    this.p = p;
    this.r.src.click = p.click && p.beats.length ? { beats: p.beats, downbeat: p.downbeat, perBar: p.perBar, vol: p.clickVol } : null;
    if (trainerStarted) {
      this.passes = 0;
      this.r.setTempoPitch(p.trainer.from, this.r.pitch);
      if (this.looping) this.r.seek(this.loop.start);
    }
    if (!p.countIn && !p.gap) this.pauseLeft = 0;
  }

  seek(pos: number) {
    this.pauseLeft = 0;
    this.r.seek(this.looping ? Math.min(Math.max(pos, this.loop.start), this.loop.end - 1) : pos);
  }

  /** Called when playback starts: count in if asked to. */
  onPlay() {
    if (this.r.heard >= this.length - 128) this.r.seek(this.looping ? this.loop.start : 0);
    if (this.looping && (this.r.heard < this.loop.start || this.r.heard >= this.loop.end)) this.r.seek(this.loop.start);
    if (this.p.countIn) this.beginPause(0);
  }

  /** Beat length (source frames) around a position, from the detected beats. */
  private localPeriod(pos: number): number {
    const b = this.p.beats;
    if (b.length < 3) return 0;
    let i = b.findIndex((x) => x >= pos);
    if (i < 0) i = b.length - 1;
    const lo = Math.max(1, i - 4);
    const hi = Math.min(b.length - 1, i + 4);
    const d: number[] = [];
    for (let k = lo; k <= hi; k++) d.push(b[k] - b[k - 1]);
    d.sort((x, y) => x - y);
    return d[d.length >> 1];
  }

  private beginPause(gapSeconds: number) {
    const gap = Math.round(gapSeconds * SR);
    const clicks: { at: number; accent: boolean }[] = [];
    let len = gap;
    const period = this.p.countIn ? this.localPeriod(this.r.heard) / this.r.tempo : 0;
    if (period > 0) {
      for (let k = 0; k < this.p.perBar; k++) clicks.push({ at: gap + Math.round(k * period), accent: k === 0 });
      len = gap + Math.round(this.p.perBar * period);
    }
    this.pauseLen = len;
    this.pauseLeft = len;
    this.pauseClicks = clicks;
  }

  private endPass() {
    this.passes++;
    const t = this.p.trainer;
    if (t.on && this.passes % Math.max(1, t.every) === 0) {
      const next = Math.min(t.to, Math.round((this.r.tempo + t.step) * 100) / 100);
      if (next !== this.r.tempo) this.r.setTempoPitch(next, this.r.pitch);
    }
    this.r.seek(this.loop.start);
    this.beginPause(this.p.gap);
  }

  /** Fill n output frames. Returns false when the track has ended. */
  render(L: Float32Array, R: Float32Array, n: number): boolean {
    let i = 0;
    while (i < n) {
      if (this.pauseLeft > 0) {
        const k = Math.min(n - i, this.pauseLeft);
        L.fill(0, i, i + k);
        R.fill(0, i, i + k);
        const t0 = this.pauseLen - this.pauseLeft; // frames into the pause
        for (const c of this.pauseClicks) {
          const wave = c.accent ? CLICK_HI : CLICK_LO;
          const from = Math.max(t0, c.at);
          const to = Math.min(t0 + k, c.at + CLICK_LEN);
          for (let t = from; t < to; t++) {
            const v = wave[t - c.at] * Math.max(0.3, this.p.clickVol);
            L[i + t - t0] += v;
            R[i + t - t0] += v;
          }
        }
        this.pauseLeft -= k;
        i += k;
        continue;
      }
      if (this.looping) {
        const remain = this.loop.end - this.r.heard;
        if (remain <= 0.5) {
          this.endPass();
          continue;
        }
        const want = Math.min(n - i, Math.max(1, Math.ceil(remain / this.r.tempo)));
        const got = this.r.render(L.subarray(i), R.subarray(i), want);
        i += got;
        if (!got) this.endPass();
        continue;
      }
      const got = this.r.render(L.subarray(i), R.subarray(i), n - i);
      if (got < n - i) {
        L.fill(0, i + got, n);
        R.fill(0, i + got, n);
        return false;
      }
      i += got;
    }
    return true;
  }
}
