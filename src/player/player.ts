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
    const p = Math.max(0, Math.round(pos));
    this.state = { ...this.state, pos: p }; // update now; the player confirms shortly
    this.send({ type: 'seek', pos: p });
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

  // ---- extra sounds for the note tools (freeze, keyboard) ----
  private held: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

  /** Loop a stereo buffer (the "freeze" sound) until stopHold(); `rate` shifts its pitch. */
  async hold(chs: Float32Array[], rate = 1) {
    await this.unlock();
    const ctx = this.ctx!;
    this.stopHold();
    const buf = ctx.createBuffer(chs.length, chs[0].length, 44100);
    chs.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.05);
    src.connect(gain).connect(this.master!);
    src.start();
    this.held = { src, gain };
  }

  stopHold() {
    if (!this.held || !this.ctx) return;
    const { src, gain } = this.held;
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.06);
    src.stop(t + 0.07);
    this.held = null;
  }

  /** A short piano-ish tone for a MIDI note. */
  async tone(midi: number) {
    await this.unlock();
    const ctx = this.ctx!;
    const f = 440 * 2 ** ((midi - 69) / 12);
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.25, t + 0.01);
    out.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    out.connect(this.master!);
    [1, 2, 3, 4].forEach((hn, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f * hn;
      g.gain.value = [1, 0.4, 0.2, 0.1][i];
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 1.5);
    });
  }
}
