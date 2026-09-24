import { Player } from '../player/player.ts';
import type { Stereo } from '../player/mixcore.ts';
import { Encoder } from '../encode/client.ts';
import { extensionFor, mimeFor } from '../encode/meta.ts';
import { stemColour, MODELS } from '../models.ts';
import { openSink, safeName, saveFile } from '../platform.ts';
import type { Settings } from '../settings.ts';
import { $, fitCanvas, fmtDuration, fmtTime, h, pressed, toast } from './dom.ts';

const SR = 44100;
const BUCKETS = 2000;

export interface Result {
  title: string;
  stems: { name: string; data: Stereo }[];
  settings: Settings;
  seconds: number;
  /** Wall-clock seconds the separation took. */
  took?: number;
}

interface Lane {
  name: string;
  vol: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  peaks: Float32Array;
  layers?: [HTMLCanvasElement, HTMLCanvasElement];
}

function peaksOf(chs: Float32Array[], buckets = BUCKETS) {
  const n = chs[0].length;
  const out = new Float32Array(buckets);
  const size = Math.max(1, Math.floor(n / buckets));
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const end = Math.min(n, (b + 1) * size);
    for (let i = b * size; i < end; i += 4) {
      let v = 0;
      for (const c of chs) v += Math.abs(c[i]);
      if (v > m) m = v;
    }
    out[b] = m / chs.length;
  }
  return out;
}

/** Pre-render a waveform in one colour to an offscreen canvas. */
function waveLayer(peaks: Float32Array, w: number, hgt: number, colour: string, scale: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  const g = c.getContext('2d')!;
  g.fillStyle = colour;
  const mid = hgt / 2;
  const barW = Math.max(1, Math.round(w / 700));
  for (let x = 0; x < w; x += barW + 1) {
    const b0 = Math.floor((x / w) * peaks.length);
    const b1 = Math.max(b0 + 1, Math.floor(((x + barW) / w) * peaks.length));
    let m = 0;
    for (let b = b0; b < b1; b++) m = Math.max(m, peaks[b]);
    const hh = Math.max(1, Math.min(1, m * scale) * (mid - 2));
    g.fillRect(x, mid - hh, barW, hh * 2);
  }
  return c;
}

export class Deck {
  player = new Player();
  private encoder = new Encoder();
  private r: Result | null = null;
  private lanes: Lane[] = [];
  private overviewPeaks = new Float32Array(0);
  private overviewLayers: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
  private loop = { on: false, a: 0, b: 0 };
  private tempo = 1;
  private pitch = 0;
  private dirty = true;
  private drag: { x0: number; moved: boolean } | null = null;
  onRerun: () => void = () => {};

  constructor(private settings: () => Settings) {
    this.player.onState = (s) => {
      $('playBtn').classList.toggle('on', s.playing);
      this.dirty = true;
    };
    $('playBtn').onclick = () => this.toggle();
    $('loopBtn').onclick = () => this.setLoop(!this.loop.on);
    $('setA').onclick = () => this.setPoint('a');
    $('setB').onclick = () => this.setPoint('b');
    $('saveAllBtn').onclick = () => this.saveAll();
    $('exportMixBtn').onclick = () => this.exportMix();
    $('rerunBtn').onclick = () => this.onRerun();
    const tempo = $<HTMLInputElement>('tempo');
    const pitch = $<HTMLInputElement>('pitch');
    tempo.oninput = () => this.setTempoPitch(Number(tempo.value), this.pitch);
    pitch.oninput = () => this.setTempoPitch(this.tempo, Number(pitch.value));
    for (const b of document.querySelectorAll<HTMLElement>('[data-reset]'))
      b.onclick = () => (b.dataset.reset === 'tempo' ? this.setTempoPitch(1, this.pitch) : this.setTempoPitch(this.tempo, 0));
    $<HTMLInputElement>('volume').oninput = (e) => this.player.setVolume(Number((e.target as HTMLInputElement).value));
    this.initOverview();
    this.initKeys();
    new ResizeObserver(() => this.invalidateLayers()).observe($('deck'));
    const frame = () => {
      if (this.dirty && this.r) this.draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  get current() {
    return this.r;
  }

  open(r: Result) {
    this.player.pause();
    this.r = r;
    this.loop = { on: false, a: 0, b: 0 };
    $('welcome').hidden = true;
    $('deck').hidden = false;
    $('trackTitle').textContent = r.title;
    const s = r.settings;
    const extras = [r.took ? `separated in ${fmtDuration(r.took)}` : '', MODELS[s.model].label, s.shifts > 1 ? `${s.shifts} shifts` : '', s.precision === 'full' ? 'full precision' : ''];
    $('trackMeta').textContent = [fmtTime(r.seconds), ...extras].filter(Boolean).join(' · ');
    $('timeTotal').textContent = fmtTime(r.seconds);

    this.overviewPeaks = peaksOf(r.stems.flatMap((s) => s.data));
    // Normalise display to the loudest stem so quiet stems are still visible.
    const lanes = $('lanes');
    lanes.replaceChildren();
    this.lanes = r.stems.map((s, i) => {
      const colour = stemColour(s.name);
      const canvas = h('canvas');
      const mute = h('button', { class: 'ms m', type: 'button', title: `Mute (${i + 1})` }, 'M');
      const solo = h('button', { class: 'ms s', type: 'button', title: 'Solo' }, 'S');
      const dl = h('button', { class: 'dl', type: 'button', title: `Save ${s.name}` });
      dl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>';
      const vol = h('input', { type: 'range', min: '0', max: '1.5', step: '0.01', value: '1', title: 'Level' });
      const pan = h('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: '0', title: 'Pan (double-click to centre)' });
      const panOut = h('output', {}, 'C');
      const label = s.name.startsWith('no_') ? `No ${s.name.slice(3)}` : s.name;
      const ctl = h('div', { class: 'lane-ctl', style: `--c:${colour}` }, h('span', { class: 'name' }, label), mute, solo, dl,
        h('label', { class: 'mini' }, h('span', {}, 'Vol'), vol),
        h('label', { class: 'mini' }, h('span', {}, 'Pan'), pan, panOut));
      const wave = h('div', { class: 'wave' }, canvas);
      const el = h('div', { class: 'lane' }, ctl, wave);
      lanes.append(el);
      const lane: Lane = { name: s.name, vol: 1, pan: 0, mute: false, solo: false, el, canvas, peaks: peaksOf(s.data) };
      mute.onclick = () => this.setLane(lane, { mute: !lane.mute });
      solo.onclick = () => this.setLane(lane, { solo: !lane.solo });
      vol.oninput = () => this.setLane(lane, { vol: Number(vol.value) });
      const setPan = (v: number) => {
        pan.value = String(v);
        panOut.textContent = v === 0 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`;
        this.setLane(lane, { pan: v });
      };
      pan.oninput = () => setPan(Number(pan.value));
      pan.ondblclick = () => setPan(0);
      dl.onclick = () => this.saveStem(i);
      wave.onclick = (e) => this.seekFrac(e.offsetX / wave.clientWidth);
      pressed(mute, false);
      pressed(solo, false);
      return lane;
    });
    this.player.load(r.stems.map((s) => s.data), this.gains());
    this.setTempoPitch(this.tempo, this.pitch);
    this.player.setLoop(false, 0, 0);
    this.updateLoopUi();
    this.invalidateLayers();
  }

  close() {
    this.player.pause();
    this.r = null;
    this.lanes = [];
    $('deck').hidden = true;
    $('welcome').hidden = false;
  }

  // ---------- mixer ----------
  private gains() {
    const anySolo = this.lanes.some((l) => l.solo);
    return this.lanes.map((l) => (anySolo ? (l.solo ? l.vol : 0) : l.mute ? 0 : l.vol));
  }

  private pans() {
    return this.lanes.map((l) => l.pan);
  }

  private setLane(l: Lane, patch: Partial<Pick<Lane, 'vol' | 'pan' | 'mute' | 'solo'>>) {
    Object.assign(l, patch);
    pressed(l.el.querySelector('.m')!, l.mute);
    pressed(l.el.querySelector('.s')!, l.solo);
    const g = this.gains();
    this.lanes.forEach((x, i) => x.el.classList.toggle('off', g[i] === 0));
    this.player.setGains(g, this.pans());
  }

  private setTempoPitch(tempo: number, pitch: number) {
    this.tempo = tempo;
    this.pitch = pitch;
    $<HTMLInputElement>('tempo').value = String(tempo);
    $<HTMLInputElement>('pitch').value = String(pitch);
    $('tempoOut').textContent = `${Math.round(tempo * 100)}%`;
    $('pitchOut').textContent = `${pitch > 0 ? '+' : ''}${pitch} st`;
    this.player.setTempoPitch(tempo, pitch);
  }

  // ---------- transport & loop ----------
  toggle() {
    if (!this.r) return;
    if (this.player.state.playing) this.player.pause();
    else void this.player.play();
  }

  private get length() {
    return this.r?.stems[0].data[0].length ?? 0;
  }

  private seekFrac(f: number) {
    this.player.seek(Math.max(0, Math.min(1, f)) * this.length);
    this.dirty = true;
  }

  private setLoop(on: boolean) {
    if (on && this.loop.b - this.loop.a < SR / 4) {
      // No section chosen yet: loop 8 s from the playhead.
      this.loop.a = this.player.state.pos;
      this.loop.b = Math.min(this.length, this.loop.a + 8 * SR);
    }
    this.loop.on = on;
    this.player.setLoop(on, this.loop.a, this.loop.b);
    this.updateLoopUi();
  }

  private setPoint(which: 'a' | 'b') {
    this.loop[which] = this.player.state.pos;
    if (this.loop.b <= this.loop.a) {
      if (which === 'a') this.loop.b = Math.min(this.length, this.loop.a + 8 * SR);
      else this.loop.a = Math.max(0, this.loop.b - 8 * SR);
    }
    this.setLoop(true);
  }

  private updateLoopUi() {
    pressed($('loopBtn'), this.loop.on);
    $('loopInfo').textContent =
      this.loop.b > this.loop.a
        ? `${fmtTime(this.loop.a / SR)} – ${fmtTime(this.loop.b / SR)}${this.loop.on ? '' : ' (off)'}`
        : 'Drag across the waveform to pick a section';
    this.dirty = true;
  }

  private initOverview() {
    const wrap = $('overviewWrap');
    const frac = (e: PointerEvent) => Math.max(0, Math.min(1, (e.clientX - wrap.getBoundingClientRect().left) / wrap.clientWidth));
    wrap.addEventListener('pointerdown', (e) => {
      wrap.setPointerCapture(e.pointerId);
      this.drag = { x0: frac(e), moved: false };
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const f = frac(e);
      if (Math.abs(f - this.drag.x0) * wrap.clientWidth > 6) this.drag.moved = true;
      if (this.drag.moved) {
        const [a, b] = [this.drag.x0, f].sort((x, y) => x - y);
        this.loop.a = Math.round(a * this.length);
        this.loop.b = Math.round(b * this.length);
        this.dirty = true;
      }
    });
    wrap.addEventListener('pointerup', (e) => {
      if (!this.drag) return;
      if (this.drag.moved) {
        this.setLoop(true);
        this.player.seek(this.loop.a);
      } else this.seekFrac(frac(e));
      this.drag = null;
    });
  }

  private initKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this.r || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
      const pos = this.player.state.pos;
      if (e.code === 'Space') this.toggle();
      else if (e.key === 'ArrowLeft') this.player.seek(pos - 5 * SR);
      else if (e.key === 'ArrowRight') this.player.seek(Math.min(this.length - SR, pos + 5 * SR));
      else if (e.key === 'l' || e.key === 'L') this.setLoop(!this.loop.on);
      else if (e.key === '[') this.setPoint('a');
      else if (e.key === ']') this.setPoint('b');
      else if (/^[1-6]$/.test(e.key) && this.lanes[+e.key - 1]) this.setLane(this.lanes[+e.key - 1], { mute: !this.lanes[+e.key - 1].mute });
      else return;
      e.preventDefault();
    });
  }

  // ---------- drawing ----------
  private invalidateLayers() {
    this.overviewLayers = null;
    for (const l of this.lanes) l.layers = undefined;
    this.dirty = true;
  }

  private drawStrip(canvas: HTMLCanvasElement, layers: [HTMLCanvasElement, HTMLCanvasElement], pos: number, showLoop: boolean) {
    const g = fitCanvas(canvas);
    const { width: w, height: hh } = canvas;
    g.clearRect(0, 0, w, hh);
    const len = this.length || 1;
    const px = (pos / len) * w;
    if (showLoop && this.loop.b > this.loop.a) {
      g.fillStyle = this.loop.on ? 'rgba(139,124,246,0.18)' : 'rgba(139,124,246,0.08)';
      g.fillRect((this.loop.a / len) * w, 0, ((this.loop.b - this.loop.a) / len) * w, hh);
    }
    g.drawImage(layers[0], 0, 0);
    g.save();
    g.beginPath();
    g.rect(0, 0, px, hh);
    g.clip();
    g.drawImage(layers[1], 0, 0);
    g.restore();
    g.fillStyle = getComputedStyle(document.body).color;
    g.fillRect(Math.round(px), 0, Math.max(1, devicePixelRatio), hh);
  }

  private draw() {
    this.dirty = false;
    const pos = this.player.state.pos;
    $('timeNow').textContent = fmtTime(pos / SR);
    const ov = $<HTMLCanvasElement>('overview');
    fitCanvas(ov);
    if (!this.overviewLayers || this.overviewLayers[0].width !== ov.width || this.overviewLayers[0].height !== ov.height) {
      const scale = 1 / Math.max(1e-3, Math.max(...this.overviewPeaks));
      this.overviewLayers = [
        waveLayer(this.overviewPeaks, ov.width, ov.height, 'rgba(139,147,165,0.55)', scale),
        waveLayer(this.overviewPeaks, ov.width, ov.height, '#8b7cf6', scale),
      ];
    }
    this.drawStrip(ov, this.overviewLayers, pos, true);
    const maxPeak = Math.max(1e-3, ...this.lanes.map((l) => Math.max(...l.peaks)));
    for (const l of this.lanes) {
      fitCanvas(l.canvas);
      if (!l.layers || l.layers[0].width !== l.canvas.width || l.layers[0].height !== l.canvas.height) {
        const c = stemColour(l.name);
        l.layers = [waveLayer(l.peaks, l.canvas.width, l.canvas.height, c + '66', 1 / maxPeak), waveLayer(l.peaks, l.canvas.width, l.canvas.height, c, 1 / maxPeak)];
      }
      this.drawStrip(l.canvas, l.layers, pos, true);
    }
  }

  // ---------- export ----------
  private baseName() {
    return safeName((this.r?.title ?? 'track').replace(/\.[a-z0-9]{2,5}$/i, ''));
  }

  private async saveStem(i: number) {
    if (!this.r) return;
    const s = this.r.stems[i];
    const o = this.settings();
    const t = toast(`Encoding ${s.name}…`);
    try {
      await this.encoder.run({ type: 'stems', stems: [s], out: o }, async (name, bytes) => {
        await saveFile(`${this.baseName()} - ${name}.${extensionFor(o)}`, bytes, mimeFor(o));
      });
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, true);
    } finally {
      t.remove();
    }
  }

  private async saveAll() {
    if (!this.r) return;
    const o = this.settings();
    const base = this.baseName();
    const sink = await openSink(`${base} (stems).zip`);
    if (!sink) return;
    const btn = $<HTMLButtonElement>('saveAllBtn');
    btn.disabled = true;
    let n = 0;
    const total = this.r.stems.length;
    btn.textContent = `Encoding 0/${total}…`;
    try {
      await this.encoder.run({ type: 'stems', stems: this.r.stems, out: o }, async (name, bytes) => {
        await sink.write(`${base} - ${name}.${extensionFor(o)}`, bytes);
        btn.textContent = `Encoding ${++n}/${total}…`;
      });
      await sink.close();
      toast(`Saved ${total} stems`);
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save all stems';
    }
  }

  private async exportMix() {
    if (!this.r) return;
    const o = this.settings();
    const useLoop = this.loop.on && this.loop.b > this.loop.a;
    const [start, end] = useLoop ? [this.loop.a, this.loop.b] : [0, this.length];
    const g = this.gains();
    const on = this.lanes.filter((_, i) => g[i] > 0).map((l) => l.name);
    const bits = [
      on.length === this.lanes.length ? 'mix' : on.join('+') || 'silence',
      this.tempo !== 1 ? `${Math.round(this.tempo * 100)}%` : '',
      this.pitch ? `${this.pitch > 0 ? '+' : ''}${this.pitch}st` : '',
      useLoop ? `${fmtTime(start / SR).replace(':', '.')}-${fmtTime(end / SR).replace(':', '.')}` : '',
    ].filter(Boolean);
    const name = `${this.baseName()} - ${bits.join(' ')}.${extensionFor(o)}`;
    const btn = $<HTMLButtonElement>('exportMixBtn');
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      await this.encoder.run(
        { type: 'mix', name, stems: this.r.stems.map((s) => s.data), gains: g, pans: this.pans(), start, end, tempo: this.tempo, pitch: this.pitch, out: o },
        async (n, bytes) => void (await saveFile(n, bytes, mimeFor(o))),
      );
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Export mix';
    }
  }
}
