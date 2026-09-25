import { MixSource, Renderer, type Stereo } from './mixcore.ts';
import { DEFAULT_PRACTICE, Transport, type Practice } from './transport.ts';
import type { EqParams } from './eq.ts';

export type PlayerMsg =
  | { type: 'load'; stems: Stereo[]; gains: number[] }
  | { type: 'addTrack'; stem: Stereo }
  | { type: 'replaceTrack'; index: number; stem: Stereo }
  | { type: 'gains'; gains: number[]; pans?: number[]; eqs?: (EqParams | undefined)[] }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; pos: number }
  | { type: 'loop'; on: boolean; start: number; end: number }
  | { type: 'tempo'; tempo: number; pitch: number }
  | { type: 'practice'; practice: Practice };

export interface PlayerReport {
  pos: number;
  playing: boolean;
  ended: boolean;
  passes: number;
  tempo: number;
  countingIn: boolean;
}

class StemPlayer extends AudioWorkletProcessor {
  private t: Transport | null = null;
  private playing = false;
  private ticks = 0;
  private loop = { on: false, start: 0, end: 0 };
  private tp = { tempo: 1, pitch: 0 };
  private practice: Practice = DEFAULT_PRACTICE;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<PlayerMsg>) => this.handle(e.data);
  }

  private handle(m: PlayerMsg) {
    if (m.type === 'load') {
      const src = new MixSource(m.stems, m.gains, m.stems[0]?.[0].length ?? 0);
      src.padEnd = 32768;
      const r = new Renderer(src);
      r.setTempoPitch(this.tp.tempo, this.tp.pitch);
      this.t = new Transport(r);
      this.t.setLoop(this.loop.on, this.loop.start, this.loop.end);
      this.t.setPractice(this.practice);
      this.playing = false;
      this.report();
      return;
    }
    if (m.type === 'addTrack' && this.t) {
      // gains/pans/eqs are read with a `?? 0`/`?? undefined` fallback for any index past their
      // own length (see MixSource.extract), so this is safe even before the gains message that
      // always follows it from the main thread catches the arrays up to the new stem count.
      this.t.r.src.stems.push(m.stem);
      this.report();
      return;
    }
    if (m.type === 'replaceTrack' && this.t) {
      // Swapping in a different take at the same mixer slot, rather than adding a new one.
      if (this.t.r.src.stems[m.index]) this.t.r.src.stems[m.index] = m.stem;
      this.report();
      return;
    }
    if (m.type === 'loop') this.loop = m;
    if (m.type === 'tempo') this.tp = m;
    if (m.type === 'practice') this.practice = m.practice;
    const t = this.t;
    if (!t) return;
    switch (m.type) {
      case 'loop':
        t.setLoop(m.on, m.start, m.end);
        break;
      case 'tempo':
        t.r.setTempoPitch(m.tempo, m.pitch);
        break;
      case 'practice':
        t.setPractice(m.practice);
        break;
      case 'gains':
        t.r.src.gains = m.gains;
        if (m.pans) t.r.src.pans = m.pans;
        if (m.eqs) t.r.src.setEqs(m.eqs);
        break;
      case 'play':
        if (!this.playing) t.onPlay();
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seek':
        t.seek(m.pos);
        break;
    }
    this.report();
  }

  private report(ended = false) {
    const t = this.t;
    const msg: PlayerReport = {
      pos: t?.r.heard ?? 0,
      playing: this.playing,
      ended,
      passes: t?.passes ?? 0,
      tempo: t?.r.tempo ?? this.tp.tempo,
      countingIn: !!t?.pausing,
    };
    if (t) this.tp.tempo = t.r.tempo;
    this.port.postMessage(msg);
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    if (!this.t || !this.playing || !out?.length) return true;
    const L = out[0];
    const R = out[1] ?? out[0];
    if (!this.t.render(L, R, L.length)) {
      this.playing = false;
      this.t.seek(0);
      this.report(true);
      return true;
    }
    if (++this.ticks % 8 === 0) this.report();
    return true;
  }
}

registerProcessor('stem-player', StemPlayer);
