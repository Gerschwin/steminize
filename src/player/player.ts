import workletUrl from './worklet.ts?worker&url';
import type { PlayerMsg, PlayerReport } from './worklet.ts';
import type { Practice } from './transport.ts';
import type { Stereo } from './mixcore.ts';
import type { EqParams } from './eq.ts';

export type PlayerState = PlayerReport;

/** Main-thread handle on the AudioWorklet stem player. */
export class Player {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private ready: Promise<void> | null = null;
  private queued: PlayerMsg[] = [];
  state: PlayerState = { pos: 0, playing: false, ended: false, passes: 0, tempo: 1, countingIn: false };
  onState: (s: PlayerState) => void = () => {};

  private init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'playback' });
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'stem-player', { numberOfInputs: 0, outputChannelCount: [2] });
      const master = ctx.createGain();
      node.connect(master).connect(ctx.destination);
      node.port.onmessage = (e) => {
        this.state = e.data;
        this.onState(e.data);
      };
      this.ctx = ctx;
      this.node = node;
      this.master = master;
      for (const m of this.queued) node.port.postMessage(m);
      this.queued = [];
    })();
    return this.ready;
  }

  private send(m: PlayerMsg) {
    if (this.node) this.node.port.postMessage(m);
    else this.queued.push(m);
  }

  /** Must be called from a user gesture at least once (autoplay rules). */
  async unlock() {
    await this.init();
    if (this.ctx!.state !== 'running') await this.ctx!.resume();
  }

  load(stems: Stereo[], gains: number[]) {
    this.queued = this.queued.filter((m) => m.type !== 'load');
    this.send({ type: 'load', stems, gains });
    this.state = { ...this.state, pos: 0, playing: false, passes: 0 };
    void this.init();
  }
  setGains(gains: number[], pans?: number[], eqs?: (EqParams | undefined)[]) {
    this.send({ type: 'gains', gains, pans, eqs });
  }
  async play() {
    await this.unlock();
    this.send({ type: 'play' });
  }
  pause() {
    this.send({ type: 'pause' });
  }
  seek(pos: number) {
    this.send({ type: 'seek', pos: Math.max(0, Math.round(pos)) });
  }
  setLoop(on: boolean, start: number, end: number) {
    this.send({ type: 'loop', on, start: Math.round(start), end: Math.round(end) });
  }
  setTempoPitch(tempo: number, pitch: number) {
    this.send({ type: 'tempo', tempo, pitch });
  }
  setPractice(practice: Practice) {
    this.send({ type: 'practice', practice });
  }
  setVolume(v: number) {
    if (this.master) this.master.gain.value = v;
  }
}
