import { MixSource, Renderer, type Stereo } from './mixcore.ts';

export type PlayerMsg =
  | { type: 'load'; stems: Stereo[]; gains: number[] }
  | { type: 'gains'; gains: number[]; pans?: number[] }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; pos: number }
  | { type: 'loop'; on: boolean; start: number; end: number }
  | { type: 'tempo'; tempo: number; pitch: number };

class StemPlayer extends AudioWorkletProcessor {
  private r: Renderer | null = null;
  private playing = false;
  private ticks = 0;
  private loop = { on: false, start: 0, end: 0 };
  private tp = { tempo: 1, pitch: 0 };

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<PlayerMsg>) => this.handle(e.data);
  }

  private handle(m: PlayerMsg) {
    if (m.type === 'load') {
      const src = new MixSource(m.stems, m.gains, m.stems[0]?.[0].length ?? 0);
      src.padEnd = 32768;
      this.r = new Renderer(src);
      this.playing = false;
      this.applyLoop();
      this.r.setTempoPitch(this.tp.tempo, this.tp.pitch);
      this.report();
      return;
    }
    if (m.type === 'loop') {
      this.loop = m;
      this.applyLoop();
      return;
    }
    if (m.type === 'tempo') {
      this.tp = m;
      this.r?.setTempoPitch(m.tempo, m.pitch);
      return;
    }
    if (!this.r) return;
    if (m.type === 'gains') {
      this.r.src.gains = m.gains;
      if (m.pans) this.r.src.pans = m.pans;
    }
    else if (m.type === 'play') {
      if (this.r.heard >= this.r.src.end - 128) this.r.seek(this.loop.on ? this.loop.start : 0);
      this.playing = true;
    } else if (m.type === 'pause') this.playing = false;
    else if (m.type === 'seek') this.r.seek(m.pos);
    this.report();
  }

  private applyLoop() {
    if (!this.r) return;
    const s = this.r.src;
    s.loopOn = this.loop.on;
    s.loopStart = Math.round(this.loop.start);
    s.loopEnd = Math.round(this.loop.end);
    if (s.looping && (this.r.heard < s.loopStart || this.r.heard >= s.loopEnd)) this.r.seek(s.loopStart);
  }

  private report(ended = false) {
    this.port.postMessage({ pos: this.r?.heard ?? 0, playing: this.playing, ended });
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    if (!this.r || !this.playing || !out?.length) return true;
    const L = out[0];
    const R = out[1] ?? out[0];
    const n = this.r.render(L, R, L.length);
    if (n < L.length) {
      this.playing = false;
      this.r.seek(0);
      this.report(true);
      return true;
    }
    if (++this.ticks % 8 === 0) this.report();
    return true;
  }
}

registerProcessor('stem-player', StemPlayer);
