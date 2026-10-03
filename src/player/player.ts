import workletUrl from './worklet.ts?worker&url';
import probeUrl from './inputProbe.ts?worker&url';
import { detectLatency, type LatencyResult } from './latency.ts';
import { loadLowLatencyAudio } from '../settings.ts';
import type { PlayerMsg, PlayerReport } from './worklet.ts';
import type { Practice } from './transport.ts';
import type { Stereo } from './mixcore.ts';
import type { EqParams } from './eq.ts';

export type PlayerState = PlayerReport;

/** Rough timbre families for the Notes-view preview tone, picked to suit what you're comparing it against. */
export type Voice = 'default' | 'bass' | 'guitar' | 'vocal';
interface VoiceParams {
  harmonics: number[]; // relative starting gains, index 0 = fundamental
  attack: number; // seconds
  decay: number; // seconds to near-silence, for the fundamental
  /** How much faster each successive harmonic fades than the one below it. 1 = all together (a flat, buzzy decay). */
  decaySpread: number;
  filterHz?: number; // lowpass cutoff, for a darker/rounder tone
  vibrato?: { rate: number; cents: number }; // a slow pitch wobble, for a sung quality
  pluck?: boolean; // a brief noise "attack" click, for a plucked string
}
const VOICES: Record<Voice, VoiceParams> = {
  default: { harmonics: [1, 0.4, 0.2, 0.1], attack: 0.01, decay: 1.4, decaySpread: 1 },
  // Dominant fundamental, dark (low-passed), slower attack, rings out longer.
  bass: { harmonics: [1, 0.32, 0.08], attack: 0.02, decay: 2.4, decaySpread: 1, filterHz: 900 },
  // A pluck transient, bright at onset, upper harmonics fading much faster than the fundamental.
  guitar: { harmonics: [1, 0.7, 0.5, 0.3, 0.18, 0.1], attack: 0.002, decay: 1.7, decaySpread: 2.2, pluck: true },
  // Soft, filtered, few harmonics, with a slow vibrato.
  vocal: { harmonics: [1, 0.3, 0.1], attack: 0.07, decay: 1.9, decaySpread: 1, filterHz: 2400, vibrato: { rate: 5.5, cents: 25 } },
};

/** Main-thread handle on the AudioWorklet stem player. */
/** Which input channels the live input uses: both as they come, one of them as mono, or both summed (not averaged) to mono. */
export type InputChannel = 'stereo' | 'left' | 'right' | 'sum';

export class Player {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private ready: Promise<void> | null = null;
  private queued: PlayerMsg[] = [];
  state: PlayerState = { pos: 0, playing: false, ended: false, passes: 0, tempo: 1, countingIn: false };
  onState: (s: PlayerState) => void = () => {};
  private stateStamp = 0;

  /** The playhead estimated for right now. Reports arrive about every 23 ms, out of step with screen
   * frames, so a display that moves smoothly (the tab scroll strip) carries on at the playing speed
   * from the last report instead of stepping with it. Looks no further ahead than the next report is due. */
  smoothPos(): number {
    const s = this.state;
    if (!s.playing || s.countingIn) return s.pos;
    const dt = Math.min(0.06, Math.max(0, (performance.now() - this.stateStamp) / 1000));
    return s.pos + dt * 44100 * s.tempo;
  }

  // ---- live input monitoring: a real instrument/mic played live alongside the tracks ----
  private monitorStream: MediaStream | null = null;
  private monitorSource: MediaStreamAudioSourceNode | null = null;
  private monitorInput: GainNode | null = null; // between the source and the level control: where the channel choice is wired
  private monitorSplit: ChannelSplitterNode | null = null;
  private monitorGain: GainNode | null = null;
  private monitorPanner: StereoPannerNode | null = null;
  private monitorAnalyser: AnalyserNode | null = null;
  // ---- recording your own take while monitoring (not the separated stems) ----
  private recorder: MediaRecorder | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private recordedChunks: Blob[] = [];

  private init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // Low-latency mode runs at the sound card's own rate (the worklet converts the songs to it), which saves the
      // system a second conversion; the standard mode keeps the fixed 44.1 kHz context.
      let ctx = loadLowLatencyAudio() ? new AudioContext({ latencyHint: 'interactive' }) : new AudioContext({ sampleRate: 44100, latencyHint: 'playback' });
      if (ctx.sampleRate < 44100) {
        void ctx.close();
        ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
      }
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'stem-player', { numberOfInputs: 0, outputChannelCount: [2] });
      const master = ctx.createGain();
      node.connect(master).connect(ctx.destination);
      node.port.onmessage = (e) => {
        this.state = e.data;
        this.stateStamp = performance.now();
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
  /** Adds a track to the playing song in place, without resetting playback (unlike load()). Follow up with setGains() to size the gain/pan/EQ arrays to match. */
  addTrack(stem: Stereo) {
    this.send({ type: 'addTrack', stem });
  }
  /** Swaps the audio at an existing track slot (e.g. switching which take is active) without resetting playback or touching gain/pan/EQ. */
  replaceTrack(index: number, stem: Stereo) {
    this.send({ type: 'replaceTrack', index, stem });
  }
  async play() {
    await this.unlock();
    this.send({ type: 'play' });
  }
  pause() {
    this.send({ type: 'pause' });
  }
  /** Called when a seek is refused because a take is being recorded (the UI shows why). */
  onSeekBlocked: (() => void) | null = null;
  seek(pos: number) {
    // A take is laid down in real time from where recording began, so moving the playhead
    // mid-take would leave everything after the jump out of sync with the song.
    if (this.recording) {
      this.onSeekBlocked?.();
      return;
    }
    const p = Math.max(0, Math.round(pos));
    this.state = { ...this.state, pos: p }; // update now; the player confirms shortly
    this.stateStamp = performance.now();
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

  /** A one-off ~100 ms snippet (stereo, at the song's sample rate) for scrubbing while paused, with
   * short edge ramps so the cuts don't click. Overlapping snippets just add. */
  async scrubGrain(chs: Float32Array[]) {
    await this.unlock();
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(chs.length, chs[0].length, 44100);
    chs.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    const dur = buf.duration;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + 0.008);
    gain.gain.setValueAtTime(1, t + Math.max(0.008, dur - 0.03));
    gain.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(gain).connect(this.master!);
    src.start(t);
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

  /** A short preview tone for a MIDI note, in a timbre roughly suited to `voice`. */
  async tone(midi: number, voice: Voice = 'default') {
    await this.unlock();
    const ctx = this.ctx!;
    const p = VOICES[voice];
    const f = 440 * 2 ** ((midi - 69) / 12);
    const t = ctx.currentTime;

    const out = ctx.createGain();
    out.gain.value = 0.28;
    let dest: AudioNode = out;
    if (p.filterHz) {
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = p.filterHz;
      filt.Q.value = 0.7;
      out.connect(filt);
      dest = filt;
    }
    dest.connect(this.master!);

    // A slow pitch wobble, shared by every harmonic, for a sung quality.
    let vibrato: GainNode | null = null;
    if (p.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.vibrato.rate;
      vibrato = ctx.createGain();
      vibrato.gain.value = f * (2 ** (p.vibrato.cents / 1200) - 1);
      lfo.connect(vibrato);
      lfo.start(t);
      lfo.stop(t + p.decay + 0.2);
    }

    p.harmonics.forEach((amp, i) => {
      // Each harmonic decays a bit faster than the one below it (decaySpread > 1), so a
      // plucked/struck voice loses its brightness over time instead of decaying flat.
      const hDecay = p.decay / (1 + i * (p.decaySpread - 1) * 0.5);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f * (i + 1);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + p.attack);
      g.gain.exponentialRampToValueAtTime(0.001 * amp, t + hDecay);
      vibrato?.connect(o.frequency);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + hDecay + 0.1);
    });

    if (p.pluck) {
      const dur = 0.02;
      const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * dur), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = f * 2;
      const g = ctx.createGain();
      g.gain.value = 0.18;
      src.connect(hp).connect(g).connect(out);
      src.start(t);
    }
  }

  // ---------- live input monitoring ----------
  get monitoring() {
    return !!this.monitorStream;
  }

  /** Input devices, with labels — only populated once permission has been granted at least once. */
  async listInputs(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  /** Starts playing a real instrument/mic live through the same output as the tracks, at `gain`/`pan`. */
  async startMonitor(deviceId: string | undefined, gain: number, pan = 0, channel: InputChannel = 'stereo') {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't capture audio input.");
    this.stopMonitor();
    await this.unlock();
    const ctx = this.ctx!;
    // Raw signal, not voice-call processing: echo cancellation/noise suppression/AGC all
    // audibly mangle an instrument or a mic held up to one.
    const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audio.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    const source = ctx.createMediaStreamSource(stream);
    const g = ctx.createGain();
    g.gain.value = gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const analyser = ctx.createAnalyser();
    // Big enough to hold several cycles of a low bass note (~30 Hz) for pitch detection,
    // not just a level meter.
    analyser.fftSize = 4096;
    const input = ctx.createGain();
    input.connect(g).connect(panner).connect(ctx.destination);
    input.connect(analyser); // the meter, tuner and trainer listen to the input itself, not the monitor level
    this.monitorStream = stream;
    this.monitorSource = source;
    this.monitorInput = input;
    this.monitorGain = g;
    this.monitorPanner = panner;
    this.monitorAnalyser = analyser;
    this.setMonitorChannel(channel);
    return stream.getAudioTracks()[0]?.getSettings().channelCount ?? 0;
  }

  /**
   * Which of the input's channels are used. An interface with an instrument in input 1 sends a silent
   * second channel, and the default stereo-to-mono downmix averages the two, halving the level; picking
   * the channel (or summing without averaging) avoids that.
   */
  setMonitorChannel(mode: InputChannel) {
    const ctx = this.ctx;
    const source = this.monitorSource;
    const input = this.monitorInput;
    if (!ctx || !source || !input) return;
    try {
      source.disconnect(input); // throws if they aren't connected yet (first call)
    } catch {
      /* nothing to undo */
    }
    if (this.monitorSplit) {
      try {
        source.disconnect(this.monitorSplit);
      } catch {
        /* already gone */
      }
      this.monitorSplit.disconnect();
      this.monitorSplit = null;
    }
    if (mode === 'stereo') {
      input.channelCount = 2;
      input.channelCountMode = 'max';
      source.connect(input);
      return;
    }
    input.channelCount = 1;
    input.channelCountMode = 'explicit';
    const split = ctx.createChannelSplitter(2);
    source.connect(split);
    if (mode === 'sum') {
      split.connect(input, 0);
      split.connect(input, 1);
    } else {
      split.connect(input, mode === 'left' ? 0 : 1);
    }
    this.monitorSplit = split;
  }

  stopMonitor() {
    // Stopping monitoring tears down the graph a recording taps into; the caller (the UI) is
    // expected to stop and save a recording first, but drop it cleanly here either way rather
    // than leave a dangling recorder.
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
    this.recordDest = null;
    this.recordedChunks = [];
    this.monitorSource?.disconnect();
    this.monitorSplit?.disconnect();
    this.monitorInput?.disconnect();
    this.monitorGain?.disconnect();
    this.monitorPanner?.disconnect();
    this.monitorAnalyser?.disconnect();
    for (const t of this.monitorStream?.getTracks() ?? []) t.stop();
    this.monitorStream = null;
    this.monitorSource = null;
    this.monitorSplit = null;
    this.monitorInput = null;
    this.monitorGain = null;
    this.monitorPanner = null;
    this.monitorAnalyser = null;
  }

  get recording() {
    return this.recorder?.state === 'recording';
  }

  /** Starts recording your own take while monitoring; call startMonitor() first. It records the input itself, before the monitor level and pan, so it works with the level at 0 (hearing yourself through the interface instead). */
  startRecording() {
    if (!this.ctx || !this.monitorInput) throw new Error('Start monitoring first.');
    if (this.recording) return;
    const dest = this.ctx.createMediaStreamDestination();
    this.monitorInput.connect(dest);
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported?.(t));
    const rec = new MediaRecorder(dest.stream, mimeType ? { mimeType } : undefined);
    this.recordedChunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) this.recordedChunks.push(e.data);
    };
    rec.start();
    this.recorder = rec;
    this.recordDest = dest;
  }

  /** Stops recording and returns the take, or null if nothing was recording. */
  stopRecording(): Promise<{ blob: Blob; mimeType: string } | null> {
    const rec = this.recorder;
    const dest = this.recordDest;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        this.monitorInput?.disconnect(dest!);
        const mimeType = rec.mimeType || 'audio/webm';
        resolve(this.recordedChunks.length ? { blob: new Blob(this.recordedChunks, { type: mimeType }), mimeType } : null);
        this.recordedChunks = [];
        this.recorder = null;
        this.recordDest = null;
      };
      rec.stop();
    });
  }

  private probeLoaded = false;

  /**
   * Plays a few clicks and listens for them on the input, returning the round-trip delay (output to
   * speakers or a cable, and back in), or null if they weren't heard clearly. Monitoring must be on,
   * and the monitor is muted for the duration so the clicks aren't fed back into themselves.
   */
  async measureLatency(): Promise<LatencyResult | null> {
    const ctx = this.ctx;
    const source = this.monitorSource;
    if (!ctx || !source) throw new Error('Start monitoring first.');
    if (!this.probeLoaded) {
      await ctx.audioWorklet.addModule(probeUrl);
      this.probeLoaded = true;
    }
    const rate = ctx.sampleRate;
    const probe = new AudioWorkletNode(ctx, 'input-probe', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain(); // the probe has to be pulled by something to run; nothing audible comes out
    mute.gain.value = 0;
    const blocks: { frame: number; samples: Float32Array }[] = [];
    probe.port.onmessage = (e) => blocks.push(e.data);
    source.connect(probe);
    probe.connect(mute).connect(ctx.destination);
    const before = this.monitorGain?.gain.value ?? 0;
    if (this.monitorGain) this.monitorGain.gain.value = 0;
    try {
      // A short two-tone burst: sharp enough to find the start of, and heard through small speakers and mics.
      const click = ctx.createBuffer(1, 256, rate);
      const d = click.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 0.35 * (Math.sin(i * 0.14) + Math.sin(i * 0.4)) * (1 - i / d.length);
      const first = ctx.currentTime + 0.5;
      const offsets = [0, 0.6, 1.2, 1.8, 2.4];
      for (const o of offsets) {
        const s = ctx.createBufferSource();
        s.buffer = click;
        s.connect(ctx.destination);
        s.start(first + o);
      }
      await new Promise((r) => setTimeout(r, (first - ctx.currentTime + offsets[offsets.length - 1] + 0.9) * 1000));
      if (!blocks.length) return null;
      const start = blocks[0].frame;
      const last = blocks[blocks.length - 1];
      const all = new Float32Array(last.frame + last.samples.length - start);
      for (const b of blocks) all.set(b.samples, b.frame - start);
      return detectLatency(all, start, offsets.map((o) => Math.round((first + o) * rate)), rate);
    } finally {
      if (this.monitorGain) this.monitorGain.gain.value = before;
      source.disconnect(probe);
      probe.disconnect();
      probe.port.onmessage = null;
    }
  }

  setMonitorGain(v: number) {
    if (this.monitorGain) this.monitorGain.gain.value = v;
  }

  setMonitorPan(v: number) {
    if (this.monitorPanner) this.monitorPanner.pan.value = v;
  }

  /** Current input level, 0–1 (peak over the last analysis window), for a simple meter. */
  monitorLevel(): number {
    if (!this.monitorAnalyser) return 0;
    const buf = new Float32Array(this.monitorAnalyser.fftSize);
    this.monitorAnalyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  }

  /** Raw samples for pitch detection (a tuner), or null while not monitoring. */
  monitorTimeDomain(): { buf: Float32Array; sampleRate: number } | null {
    if (!this.monitorAnalyser || !this.ctx) return null;
    const buf = new Float32Array(this.monitorAnalyser.fftSize);
    this.monitorAnalyser.getFloatTimeDomainData(buf);
    return { buf, sampleRate: this.ctx.sampleRate };
  }
}
