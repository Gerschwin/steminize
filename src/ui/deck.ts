import { Player } from '../player/player.ts';
import type { Stereo } from '../player/mixcore.ts';
import { encoder } from '../encode/client.ts';
import type { Analysis } from '../library.ts';
import { periodForBpm, retrack } from '../analysis/beats.ts';
import { keyName, type KeyCandidate, type KeyResult } from '../analysis/key.ts';
import type { Trainer } from '../player/transport.ts';
import { extensionFor, mimeFor } from '../encode/meta.ts';
import { stemColour, MODELS } from '../models.ts';
import { openSink, safeName, saveFile } from '../platform.ts';
import type { Settings } from '../settings.ts';
import { isFlat, type EqParams } from '../player/eq.ts';
import { eqPanel, type EqPanel } from './eqPanel.ts';
import { $, fitCanvas, fmtDuration, fmtTime, h, pressed, toast } from './dom.ts';

const SR = 44100;

export interface Result {
  title: string;
  stems: { name: string; data: Stereo }[];
  settings: Settings;
  seconds: number;
  /** Wall-clock seconds the separation took. */
  took?: number;
  /** Library folder, once saved. */
  libId?: string;
  /** Opened from existing track files rather than separated. */
  kind?: 'separated' | 'multitrack';
  analysis?: Analysis;
  /** Onset envelopes, kept in memory for quick tempo corrections. */
  onsets?: { env: Float32Array; low: Float32Array };
}

type Snap = 'off' | 'beat' | 'bar';
interface PracticeUi {
  gap: number;
  countIn: boolean;
  click: boolean;
  clickVol: number;
  perBar: number;
  barShift: number;
  snap: Snap;
  trainer: Trainer;
}
const DEFAULT_PR: PracticeUi = {
  gap: 0,
  countIn: false,
  click: false,
  clickVol: 0.5,
  perBar: 4,
  barShift: 0,
  snap: 'bar',
  trainer: { on: false, from: 0.7, to: 1, step: 0.05, every: 1 },
};

/** Everything about how a song is set up in the player, saved per song. */
export interface DeckState {
  lanes: { vol: number; pan: number; mute: boolean; solo: boolean; eq?: EqParams }[];
  loop: { on: boolean; a: number; b: number };
  tempo: number;
  pitch: number;
  practice: PracticeUi;
  markers?: Marker[];
}

interface Marker {
  name: string;
  pos: number; // frames
}
const FINE = 256; // samples per bucket in the fine peak arrays used for zoomed drawing

interface Lane {
  name: string;
  colour: string;
  vol: number;
  pan: number;
  eq?: EqParams;
  eqPanel?: EqPanel;
  mute: boolean;
  solo: boolean;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  peaks: Float32Array; // fine peaks (FINE samples per bucket)
  data: Stereo;
  layers?: [HTMLCanvasElement, HTMLCanvasElement];
}

/** Peak level per FINE-sample bucket, averaged across channels. */
function peaksOf(chs: Float32Array[]) {
  const n = chs[0].length;
  const out = new Float32Array(Math.ceil(n / FINE));
  for (let b = 0; b < out.length; b++) {
    let m = 0;
    const end = Math.min(n, (b + 1) * FINE);
    for (let i = b * FINE; i < end; i += 2) {
      let v = 0;
      for (const c of chs) v += Math.abs(c[i]);
      if (v > m) m = v;
    }
    out[b] = m / chs.length;
  }
  return out;
}

/** Peaks for frames [start, end) at `buckets` resolution: from the fine array, or raw samples when zoomed in far. */
function peaksForView(fine: Float32Array, chs: Float32Array[], start: number, end: number, buckets: number) {
  const out = new Float32Array(buckets);
  const spb = (end - start) / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = start + b * spb;
    const e = start + (b + 1) * spb;
    let m = 0;
    if (spb >= FINE) {
      for (let k = Math.floor(s / FINE); k < Math.min(fine.length, Math.ceil(e / FINE)); k++) m = Math.max(m, fine[k]);
    } else {
      for (let i = Math.floor(s); i < Math.min(chs[0].length, Math.ceil(e)); i++) {
        let v = 0;
        for (const c of chs) v += Math.abs(c[i]);
        m = Math.max(m, v / chs.length);
      }
    }
    out[b] = m;
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
  private encoder = encoder;
  private pr: PracticeUi = structuredClone(DEFAULT_PR);
  private taps: number[] = [];
  private quiet = false; // suppress state-change events while restoring a song
  /** Called (often) whenever the player setup changes; the caller debounces saving. */
  onStateChange: (s: DeckState) => void = () => {};
  /** Called when a tempo correction changes the song's analysis. */
  onAnalysisChange: (r: Result) => void = () => {};
  /** Ranks keys for the song, or for a range of frames. */
  rankKeys: (r: Result, start?: number, end?: number) => Promise<KeyCandidate[]> = () => Promise.resolve([]);
  /** Provides onset envelopes for a song that doesn't have them in memory. */
  needOnsets: (r: Result) => Promise<{ env: Float32Array; low: Float32Array }> = () => Promise.reject(new Error('unavailable'));
  private r: Result | null = null;
  private lanes: Lane[] = [];
  private overviewPeaks = new Float32Array(0);
  private overviewScale = 1;
  private laneScale = 1;
  private markers: Marker[] = [];
  private view = { start: 0, end: 1 };
  private pedal = false;
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
      // The speed trainer changes tempo inside the player; mirror it here.
      if (Math.abs(s.tempo - this.tempo) > 1e-6) {
        this.tempo = s.tempo;
        this.showTempoPitch();
        this.emit();
      }
      this.updateTrainerInfo(s.passes, s.countingIn);
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
    // Pan sliders are hidden unless switched on (remembered).
    const panBtn = $('panToggle');
    const showPan = (on: boolean) => {
      pressed(panBtn, on);
      $('lanes').classList.toggle('show-pan', on);
      try {
        localStorage.setItem('stemdeck.showPan', on ? '1' : '');
      } catch {
        /* ignore */
      }
    };
    let panOn = false;
    try {
      panOn = localStorage.getItem('stemdeck.showPan') === '1';
    } catch {
      /* ignore */
    }
    showPan(panOn);
    panBtn.onclick = () => showPan(panBtn.getAttribute('aria-pressed') !== 'true');
    this.initPractice();
    this.initMarkersAndZoom();
    this.initKeyPanel();
    this.initDrawer();
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

  open(r: Result, state?: DeckState) {
    this.quiet = true;
    this.player.pause();
    this.r = r;
    this.loop = { on: false, a: 0, b: 0 };
    this.pr = structuredClone(DEFAULT_PR);
    this.tempo = 1;
    this.pitch = 0;
    $('welcome').hidden = true;
    $('deck').hidden = false;
    $('trackTitle').textContent = r.title;
    const s = r.settings;
    const extras =
      r.kind === 'multitrack'
        ? [`multitrack · ${r.stems.length} tracks`]
        : [r.took ? `separated in ${fmtDuration(r.took)}` : '', MODELS[s.model].label, s.shifts > 1 ? `${s.shifts} shifts` : '', s.precision === 'full' ? 'full precision' : ''];
    $('rerunBtn').hidden = r.kind === 'multitrack';
    $('trackMeta').textContent = [fmtTime(r.seconds), ...extras].filter(Boolean).join(' · ');
    $('timeTotal').textContent = fmtTime(r.seconds);

    this.overviewPeaks = peaksOf(r.stems.flatMap((s) => s.data));
    this.overviewScale = 1 / Math.max(1e-3, ...this.overviewPeaks);
    this.markers = [];
    this.view = { start: 0, end: r.stems[0].data[0].length };
    // Normalise display to the loudest stem so quiet stems are still visible.
    const lanes = $('lanes');
    lanes.replaceChildren();
    this.lanes = r.stems.map((s, i) => {
      const colour = stemColour(s.name, i);
      const canvas = h('canvas');
      const mute = h('button', { class: 'ms m', type: 'button', title: `Mute (${i + 1})` }, 'M');
      const solo = h('button', { class: 'ms s', type: 'button', title: 'Solo' }, 'S');
      const eqBtn = h('button', { class: 'ms eq', type: 'button', title: 'EQ: presets, low/high cut and a focus band' }, 'EQ');
      const dl = h('button', { class: 'dl', type: 'button', title: `Save ${s.name}` });
      dl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>';
      const vol = h('input', { type: 'range', min: '0', max: '1.5', step: '0.01', value: '1', title: 'Level' });
      const pan = h('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: '0', title: 'Pan (double-click to centre)' });
      const panOut = h('output', {}, 'C');
      const label = s.name.startsWith('no_') ? `No ${s.name.slice(3)}` : s.name;
      const ctl = h('div', { class: 'lane-ctl', style: `--c:${colour}` }, h('span', { class: 'name', title: label }, label), mute, solo, eqBtn, dl,
        h('label', { class: 'mini vol' }, h('span', {}, 'Vol'), vol),
        h('label', { class: 'mini pan' }, h('span', {}, 'Pan'), pan, panOut));
      const wave = h('div', { class: 'wave' }, canvas);
      const el = h('div', { class: 'lane' }, ctl, wave);
      lanes.append(el);
      const lane: Lane = { name: s.name, colour, vol: 1, pan: 0, mute: false, solo: false, el, canvas, peaks: peaksOf(s.data), data: s.data };
      eqBtn.onclick = () => this.toggleEq(lane, colour);
      pressed(eqBtn, false);
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
      wave.addEventListener('wheel', (e) => this.onWheel(e, wave), { passive: false });
      pressed(mute, false);
      pressed(solo, false);
      return lane;
    });
    this.player.load(r.stems.map((s) => s.data), this.gains());
    if (state) this.applyState(state);
    this.setTempoPitch(this.tempo, this.pitch, false);
    this.player.setLoop(this.loop.on, this.loop.a, this.loop.b);
    this.updateLoopUi();
    this.laneScale = 1 / Math.max(1e-3, ...this.lanes.flatMap((l) => Math.max(...l.peaks)));
    this.syncPracticeUi();
    this.renderMarkers();
    this.setView(0, this.length);
    this.setAnalysis(r.analysis);
    this.invalidateLayers();
    this.quiet = false;
  }

  // ---------- saved state ----------
  getState(): DeckState {
    return {
      lanes: this.lanes.map((l) => ({ vol: l.vol, pan: l.pan, mute: l.mute, solo: l.solo, eq: l.eq })),
      loop: { ...this.loop },
      tempo: this.tempo,
      pitch: this.pitch,
      practice: structuredClone({ ...this.pr, trainer: { ...this.pr.trainer, on: false } }),
      markers: this.markers.map((m) => ({ ...m })),
    };
  }

  private applyState(s: DeckState) {
    this.pr = { ...structuredClone(DEFAULT_PR), ...s.practice, trainer: { ...DEFAULT_PR.trainer, ...s.practice?.trainer, on: false } };
    this.tempo = s.tempo ?? 1;
    this.pitch = s.pitch ?? 0;
    this.loop = { ...this.loop, ...s.loop };
    this.markers = (s.markers ?? []).map((m) => ({ ...m })).sort((a, b) => a.pos - b.pos);
    s.lanes?.forEach((st, i) => {
      const l = this.lanes[i];
      if (!l) return;
      Object.assign(l, st);
      (l.el.querySelectorAll('input[type=range]')[0] as HTMLInputElement).value = String(l.vol);
      const pan = l.el.querySelectorAll('input[type=range]')[1] as HTMLInputElement;
      pan.value = String(l.pan);
      pan.dispatchEvent(new Event('input'));
    });
    for (const l of this.lanes) this.setLane(l, {});
  }

  private emit() {
    if (this.r && !this.quiet) this.onStateChange(this.getState());
  }

  // ---------- tempo analysis & practice tools ----------
  setAnalysis(a?: Analysis) {
    if (this.r) this.r.analysis = a;
    $('deck').classList.toggle('no-beats', !a?.beats.length);
    this.updateBpmInfo();
    this.sendPractice();
    this.invalidateLayers();
  }

  private beatFrames() {
    return (this.r?.analysis?.beats ?? []).map((s) => Math.round(s * SR));
  }

  private downbeat() {
    const a = this.r?.analysis;
    return a ? (((a.downbeat + this.pr.barShift) % this.pr.perBar) + this.pr.perBar) % this.pr.perBar : 0;
  }

  private sendPractice() {
    const p = this.pr;
    this.player.setPractice({
      gap: p.gap,
      countIn: p.countIn,
      perBar: p.perBar,
      beats: this.beatFrames(),
      downbeat: this.downbeat(),
      click: p.click,
      clickVol: p.clickVol,
      trainer: { ...p.trainer },
    });
  }

  private updateBpmInfo(analysing = false) {
    this.updateKeyInfo();
    this.updateDrawerSummary();
    const a = this.r?.analysis;
    const el = $('bpmInfo');
    if (analysing) el.textContent = 'Tempo: analysing…';
    else if (!a?.beats.length) el.textContent = this.r ? 'Tempo: analysing…' : 'Tempo: –';
    else {
      const now = Math.round(a.bpm * this.tempo);
      el.textContent = `${Math.round(a.bpm)} BPM${this.tempo !== 1 ? ` (${now} at this speed)` : ''}`;
    }
  }

  private updateKeyInfo() {
    const k = this.r?.analysis?.key;
    const el = $('keyInfo');
    el.hidden = !k;
    if (!k) {
      $('keyPanel').hidden = true;
      return;
    }
    const unsure = !k.manual && k.confidence < 0.05 ? ' (unsure)' : '';
    const set = k.manual ? ' ✓' : '';
    el.textContent = (this.pitch ? `Key ${keyName(k)} → ${keyName(k, this.pitch)}` : `Key ${keyName(k)}`) + unsure + set;
    el.title = 'Click to recheck or change the key';
    this.updateDrawerSummary();
  }

  // ---------- key panel ----------
  private initKeyPanel() {
    const panel = $('keyPanel');
    const tonic = $<HTMLSelectElement>('keyTonic');
    const mode = $<HTMLSelectElement>('keyMode');
    const names = ['C', 'C♯ / D♭', 'D', 'E♭', 'E', 'F', 'F♯ / G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
    tonic.replaceChildren(...names.map((n, i) => h('option', { value: String(i) }, n)));
    $('keyInfo').onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) void this.showKeyCandidates();
    };
    $('keyClose').onclick = () => (panel.hidden = true);
    $('keySection').onclick = () => {
      const r = this.range();
      void this.showKeyCandidates(r?.[0], r?.[1]);
    };
    $('keyWhole').onclick = () => void this.showKeyCandidates();
    $('keySet').onclick = () => this.setKey({ tonic: Number(tonic.value), mode: mode.value as 'major' | 'minor', confidence: 1, manual: true });
  }

  /** The loop if one is on, otherwise the current marked section. */
  private range(): [number, number, string] | undefined {
    if (this.loop.on && this.loop.b > this.loop.a) return [this.loop.a, this.loop.b, 'the loop'];
    const i = this.sectionAt(this.player.state.pos);
    if (i >= 0) return [this.markers[i].pos, this.markers[i + 1]?.pos ?? this.length, `“${this.markers[i].name}”`];
    return undefined;
  }

  private async showKeyCandidates(start?: number, end?: number) {
    const r = this.r;
    if (!r) return;
    const list = $('keyList');
    const where = start != null ? (this.range()?.[2] ?? 'this part') : 'the whole song';
    $('keyWhere').textContent = `Checking ${where}…`;
    list.replaceChildren();
    this.keyPartial = start != null;
    this.refreshKeySectionBtn();
    $('keyWhole').hidden = start == null;
    const cur = r.analysis?.key;
    if (cur) {
      $<HTMLSelectElement>('keyTonic').value = String(cur.tonic);
      $<HTMLSelectElement>('keyMode').value = cur.mode;
    }
    try {
      const c = await this.rankKeys(r, start, end);
      if (this.r !== r) return;
      const top = c[0]?.score ?? 1;
      $('keyWhere').textContent = `Best matches for ${where}:`;
      list.replaceChildren(
        ...c.slice(0, 5).map((k) => {
          const pct = Math.max(0, Math.round((k.score / top) * 100));
          const isCur = cur && cur.tonic === k.tonic && cur.mode === k.mode;
          const b = h('button', { class: `eq-chip${isCur ? ' cur' : ''}`, type: 'button', title: `Fit ${pct}% of the best match` }, `${keyName(k)} · ${pct}%`);
          b.onclick = () => this.setKey({ tonic: k.tonic, mode: k.mode, confidence: Math.round((k.score - (c[1]?.score ?? 0)) * 1000) / 1000, manual: true });
          return b;
        }),
      );
    } catch (e) {
      $('keyWhere').textContent = `Couldn't check the key: ${(e as Error).message}`;
    }
  }

  private keyPartial = false;
  /** Show "Check <loop/section> only" when there is one (kept current as loops and markers change). */
  private refreshKeySectionBtn() {
    const btn = $('keySection');
    const rng = this.range();
    btn.hidden = !rng || this.keyPartial;
    if (rng) btn.textContent = `Check ${rng[2]} only`;
  }

  private setKey(k: KeyResult) {
    const r = this.r;
    if (!r?.analysis) return;
    r.analysis = { ...r.analysis, key: k };
    this.updateKeyInfo();
    this.onAnalysisChange(r);
    for (const b of $('keyList').querySelectorAll('button')) b.classList.toggle('cur', b.textContent?.startsWith(keyName(k) + ' ') ?? false);
    toast(`Key set to ${keyName(k)}`);
  }

  private updateTrainerInfo(passes: number, countingIn: boolean) {
    const t = this.pr.trainer;
    $('trainerInfo').textContent = t.on
      ? `${countingIn ? 'Count-in… · ' : ''}Pass ${passes + 1} at ${Math.round(this.tempo * 100)}%${this.tempo >= t.to ? ' (target reached)' : ''}`
      : countingIn
        ? 'Count-in…'
        : '';
  }

  private syncPracticeUi() {
    const p = this.pr;
    pressed($('trainerBtn'), p.trainer.on);
    pressed($('countInBtn'), p.countIn);
    pressed($('clickBtn'), p.click);
    $<HTMLInputElement>('clickVol').value = String(p.clickVol);
    $<HTMLSelectElement>('gap').value = String(p.gap);
    $<HTMLSelectElement>('perBar').value = String(p.perBar);
    $<HTMLSelectElement>('snap').value = p.snap;
    $<HTMLInputElement>('trFrom').value = String(Math.round(p.trainer.from * 100));
    $<HTMLInputElement>('trTo').value = String(Math.round(p.trainer.to * 100));
    $<HTMLInputElement>('trStep').value = String(Math.round(p.trainer.step * 100));
    $<HTMLInputElement>('trEvery').value = String(p.trainer.every);
    this.updateTrainerInfo(0, false);
    this.updateBpmInfo();
    this.updateDrawerSummary();
  }

  // ---------- collapsible "Practice" / "Tempo & key" drawer ----------
  private initDrawer() {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.dtab')];
    const open = (name: string | null) => {
      for (const t of tabs) t.setAttribute('aria-expanded', String(t.dataset.tab === name));
      for (const p of document.querySelectorAll<HTMLElement>('.dpane')) p.hidden = p.dataset.pane !== name;
      try {
        localStorage.setItem('stemdeck.drawer', name ?? '');
      } catch {
        /* ignore */
      }
    };
    for (const t of tabs) t.onclick = () => open(t.getAttribute('aria-expanded') === 'true' ? null : t.dataset.tab!);
    let saved = '';
    try {
      saved = localStorage.getItem('stemdeck.drawer') ?? '';
    } catch {
      /* ignore */
    }
    open(saved || null);
  }

  /** One-line summaries on the drawer tabs, so closed panels still show what's on. */
  private updateDrawerSummary() {
    const p = this.pr;
    const bits = [
      p.trainer.on ? `Trainer ${Math.round(p.trainer.from * 100)}→${Math.round(p.trainer.to * 100)}%` : '',
      p.gap ? `Gap ${p.gap} s` : '',
      p.countIn ? 'Count-in' : '',
      p.click ? 'Click' : '',
    ].filter(Boolean);
    const sp = $('sumPractice');
    sp.textContent = bits.length ? bits.join(' · ') : 'off';
    sp.classList.toggle('on', bits.length > 0);
    const a = this.r?.analysis;
    const k = a?.key;
    $('sumBeat').textContent = a?.beats.length ? [`${Math.round(a.bpm)} BPM`, k ? keyName(k, this.pitch) : ''].filter(Boolean).join(' · ') : 'analysing…';
  }

  private practiceChanged() {
    this.syncPracticeUi();
    this.sendPractice();
    this.invalidateLayers();
    this.emit();
  }

  private initPractice() {
    $('trainerBtn').onclick = () => {
      const t = this.pr.trainer;
      t.on = !t.on;
      if (t.on) {
        if (!this.loop.on) this.setLoop(true);
        this.tempo = t.from; // the player also resets to this
        this.showTempoPitch();
      }
      this.practiceChanged();
    };
    const num = (id: string, f: (v: number) => void) => ($<HTMLInputElement>(id).onchange = (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) f(v);
      this.practiceChanged();
    });
    num('trFrom', (v) => (this.pr.trainer.from = Math.min(1.5, Math.max(0.3, v / 100))));
    num('trTo', (v) => (this.pr.trainer.to = Math.min(1.5, Math.max(0.3, v / 100))));
    num('trStep', (v) => (this.pr.trainer.step = Math.min(0.25, v / 100)));
    num('trEvery', (v) => (this.pr.trainer.every = Math.round(v)));
    $('countInBtn').onclick = () => ((this.pr.countIn = !this.pr.countIn), this.practiceChanged());
    $('clickBtn').onclick = () => ((this.pr.click = !this.pr.click), this.practiceChanged());
    $<HTMLInputElement>('clickVol').oninput = (e) => ((this.pr.clickVol = Number((e.target as HTMLInputElement).value)), this.practiceChanged());
    $<HTMLSelectElement>('gap').onchange = (e) => ((this.pr.gap = Number((e.target as HTMLSelectElement).value)), this.practiceChanged());
    $<HTMLSelectElement>('snap').onchange = (e) => ((this.pr.snap = (e.target as HTMLSelectElement).value as Snap), this.practiceChanged());
    $<HTMLSelectElement>('perBar').onchange = (e) => {
      this.pr.perBar = Number((e.target as HTMLSelectElement).value);
      this.pr.barShift = 0;
      this.practiceChanged();
    };
    $('shiftBar').onclick = () => ((this.pr.barShift = (this.pr.barShift + 1) % this.pr.perBar), this.practiceChanged());
    $('halfBtn').onclick = () => this.r?.analysis && void this.retempo(this.r.analysis.bpm / 2);
    $('dblBtn').onclick = () => this.r?.analysis && void this.retempo(this.r.analysis.bpm * 2);
    $('tapBtn').onclick = () => {
      const now = performance.now();
      if (this.taps.length && now - this.taps[this.taps.length - 1] > 2500) this.taps = [];
      this.taps.push(now);
      const btn = $('tapBtn');
      btn.classList.add('tap-on');
      setTimeout(() => btn.classList.remove('tap-on'), 90);
      const n = this.taps.length;
      if (n < 4) {
        btn.textContent = `Tap (${4 - n} more)`;
        return;
      }
      const bpm = (60000 * (n - 1)) / (this.taps[n - 1] - this.taps[0]);
      btn.textContent = `Tap · ${Math.round(bpm)}`;
      // Tapping is at the playback speed; the song's tempo is that divided by it.
      clearTimeout((this as any).tapTimer);
      (this as any).tapTimer = setTimeout(() => {
        btn.textContent = 'Tap';
        this.taps = [];
        void this.retempo(bpm / this.tempo);
      }, 1200);
    };
  }

  /** Re-track beats at a corrected tempo. */
  private async retempo(bpm: number) {
    const r = this.r;
    if (!r || bpm < 30 || bpm > 300) return;
    this.updateBpmInfo(true);
    try {
      r.onsets ??= await this.needOnsets(r);
      const a = retrack(r.onsets, periodForBpm(bpm), this.pr.perBar);
      this.pr.barShift = 0;
      this.setAnalysis({ ...r.analysis, bpm: a.bpm, beats: a.beats, downbeat: a.downbeat });
      this.onAnalysisChange(r);
      this.practiceChanged();
    } catch (e) {
      toast(`Couldn't re-analyse: ${(e as Error).message}`, true);
      this.updateBpmInfo();
    }
  }

  /** Snap a frame position to the nearest beat or bar start. */
  private snap(pos: number) {
    const beats = this.beatFrames();
    if (this.pr.snap === 'off' || !beats.length) return pos;
    const d = this.downbeat();
    const grid = this.pr.snap === 'bar' ? beats.filter((_, i) => (i - d) % this.pr.perBar === 0) : beats;
    let best = pos;
    let dist = Infinity;
    for (const b of grid) if (Math.abs(b - pos) < dist) [best, dist] = [b, Math.abs(b - pos)];
    return best;
  }

  private snapLoop() {
    const a = this.snap(this.loop.a);
    let b = this.snap(this.loop.b);
    if (b <= a) b = this.loop.b; // keep a sensible region if both snap to the same point
    this.loop.a = a;
    this.loop.b = b;
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

  private eqs() {
    return this.lanes.map((l) => l.eq);
  }

  /** Open/close a stem's EQ panel (one open at a time). */
  private toggleEq(l: Lane, colour: string) {
    const open = !!l.eqPanel?.el.isConnected;
    for (const x of this.lanes) {
      x.eqPanel?.el.remove();
      x.el.classList.remove('eq-open');
    }
    if (open) return;
    l.eqPanel ??= eqPanel(colour, (eq) => this.setLane(l, { eq }));
    if (l.eq) l.eqPanel.set(l.eq);
    l.el.append(l.eqPanel.el);
    l.el.classList.add('eq-open');
    requestAnimationFrame(() => l.eqPanel!.redraw());
  }

  private setLane(l: Lane, patch: Partial<Pick<Lane, 'vol' | 'pan' | 'mute' | 'solo' | 'eq'>>) {
    Object.assign(l, patch);
    this.emit();
    pressed(l.el.querySelector('.m')!, l.mute);
    pressed(l.el.querySelector('.s')!, l.solo);
    const g = this.gains();
    this.lanes.forEach((x, i) => x.el.classList.toggle('off', g[i] === 0));
    this.player.setGains(g, this.pans(), this.eqs());
    for (const x of this.lanes) x.el.querySelector('.eq')!.classList.toggle('on', !isFlat(x.eq));
    // If pan is hidden but in use, say so on the button so it isn't forgotten.
    $('panToggle').textContent = this.lanes.some((x) => x.pan) ? 'Pan (active)' : 'Pan';
  }

  private setTempoPitch(tempo: number, pitch: number, save = true) {
    this.tempo = tempo;
    this.pitch = pitch;
    this.showTempoPitch();
    this.player.setTempoPitch(tempo, pitch);
    if (save) this.emit();
  }

  private showTempoPitch() {
    $<HTMLInputElement>('tempo').value = String(this.tempo);
    $<HTMLInputElement>('pitch').value = String(this.pitch);
    $('tempoOut').textContent = `${Math.round(this.tempo * 100)}%`;
    $('pitchOut').textContent = `${this.pitch > 0 ? '+' : ''}${this.pitch} st`;
    this.updateBpmInfo();
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
    this.player.seek(this.frameAt(Math.max(0, Math.min(1, f))));
    this.dirty = true;
  }

  /** Frame at a fraction across the visible (possibly zoomed) waveform. */
  private frameAt(f: number) {
    return this.view.start + f * (this.view.end - this.view.start);
  }

  // ---------- zoom ----------
  private setView(start: number, end: number) {
    const len = this.length || 1;
    const span = Math.min(len, Math.max(SR, end - start));
    start = Math.max(0, Math.min(len - span, start));
    this.view = { start, end: start + span };
    const zoomed = span < len - 1;
    const scroll = $<HTMLInputElement>('viewScroll');
    scroll.hidden = !zoomed;
    if (zoomed) scroll.value = String(Math.round((1000 * start) / Math.max(1, len - span)));
    this.invalidateLayers();
  }

  private zoom(factor: number, centre = this.player.state.pos) {
    const span = this.view.end - this.view.start;
    const next = span / factor;
    const rel = span ? (centre - this.view.start) / span : 0.5;
    this.setView(centre - rel * next, centre - rel * next + next);
  }

  private onWheel(e: WheelEvent, el: HTMLElement) {
    if (!this.r) return;
    e.preventDefault();
    const span = this.view.end - this.view.start;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = e.shiftKey ? e.deltaY : e.deltaX;
      this.setView(this.view.start + (d / el.clientWidth) * span, this.view.end + (d / el.clientWidth) * span);
    } else {
      const f = Math.max(0, Math.min(1, e.offsetX / el.clientWidth));
      this.zoom(Math.exp(-e.deltaY * 0.002), this.frameAt(f));
    }
  }

  // ---------- markers & pedal ----------
  private initMarkersAndZoom() {
    $('zoomIn').onclick = () => this.zoom(2);
    $('zoomOut').onclick = () => this.zoom(0.5);
    $('zoomFit').onclick = () => this.setView(0, this.length);
    $<HTMLInputElement>('viewScroll').oninput = (e) => {
      const span = this.view.end - this.view.start;
      const start = (Number((e.target as HTMLInputElement).value) / 1000) * (this.length - span);
      this.setView(start, start + span);
    };
    $('overviewWrap').addEventListener('wheel', (e) => this.onWheel(e, $('overviewWrap')), { passive: false });
    $('addMarker').onclick = () => this.addMarker();
    const pedalBtn = $('pedalBtn');
    try {
      this.pedal = localStorage.getItem('stemdeck.pedal') === '1';
    } catch {
      /* ignore */
    }
    pressed(pedalBtn, this.pedal);
    pedalBtn.onclick = () => {
      this.pedal = !this.pedal;
      pressed(pedalBtn, this.pedal);
      try {
        localStorage.setItem('stemdeck.pedal', this.pedal ? '1' : '0');
      } catch {
        /* ignore */
      }
      toast(this.pedal ? 'Foot pedal mode: right/down = play/pause, left/up = restart section' : 'Arrow keys skip 5 s again');
    };
  }

  private addMarker() {
    if (!this.r) return;
    const pos = Math.round(this.snap(this.player.state.pos));
    if (this.markers.some((m) => Math.abs(m.pos - pos) < SR / 4)) {
      toast('There is already a marker here');
      return;
    }
    // Numbered by default; rename with ✎ to "Verse", "Solo", etc.
    const used = new Set(this.markers.map((m) => m.name));
    let n = 1;
    while (used.has(String(n))) n++;
    const name = String(n);
    this.markers.push({ name, pos });
    this.markers.sort((a, b) => a.pos - b.pos);
    this.markersChanged();
  }

  private markersChanged() {
    this.renderMarkers();
    this.invalidateLayers();
    this.emit();
  }

  /** Index of the section the playhead is in (last marker at or before it). */
  private sectionAt(pos: number) {
    let idx = -1;
    this.markers.forEach((m, i) => {
      if (m.pos <= pos + SR / 20) idx = i;
    });
    return idx;
  }

  private renderMarkers() {
    if (!$('keyPanel').hidden) this.refreshKeySectionBtn();
    const here = this.sectionAt(this.player.state.pos);
    $('markers').replaceChildren(
      ...this.markers.map((m, i) => {
        const go = h('button', { class: 'mk-go', type: 'button', title: `Jump to ${m.name} (${fmtTime(m.pos / SR)})` }, m.name);
        const ren = h('button', { class: 'mk-ren', type: 'button', title: 'Rename' }, '✎');
        const loop = h('button', { class: 'mk-loop', type: 'button', title: 'Loop this section' }, '⟳');
        const del = h('button', { class: 'mk-del', type: 'button', title: 'Remove marker' }, '×');
        // Single click jumps, but waits a moment so a double-click (rename) doesn't jump first.
        let clickTimer = 0;
        go.onclick = () => {
          clearTimeout(clickTimer);
          clickTimer = window.setTimeout(() => {
            this.player.seek(m.pos);
            this.dirty = true;
          }, 250);
        };
        // Rename: swap the button for a text box.
        const rename = () => {
          clearTimeout(clickTimer);
          const input = h('input', { type: 'text', value: m.name, maxLength: 30, class: 'mk-edit', 'aria-label': 'Marker name' } as any);
          let done = false;
          const finish = (save: boolean) => {
            if (done) return;
            done = true;
            const name = input.value.trim();
            if (save && name) m.name = name;
            this.markersChanged();
          };
          input.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') finish(false);
          };
          input.onblur = () => finish(true);
          go.replaceWith(input);
          input.focus();
          input.select();
        };
        go.ondblclick = rename;
        ren.onclick = rename;
        loop.onclick = () => {
          this.loop.a = m.pos;
          this.loop.b = this.markers[i + 1]?.pos ?? this.length;
          this.setLoop(true);
          this.player.seek(this.loop.a);
        };
        del.onclick = () => {
          this.markers.splice(i, 1);
          this.markersChanged();
        };
        return h('span', { class: `marker-chip${i === here ? ' here' : ''}` }, go, ren, loop, del);
      }),
    );
  }

  /** Back to the start of the loop, or of the current section (or the previous one if just past it), and play. */
  private restart() {
    if (!this.r) return;
    const pos = this.player.state.pos;
    let to = 0;
    if (this.loop.on) to = this.loop.a;
    else {
      const i = this.sectionAt(pos);
      if (i >= 0) to = pos - this.markers[i].pos < SR && i > 0 ? this.markers[i - 1].pos : this.markers[i].pos;
    }
    // Pause first so starting again gives the count-in, if it's on.
    this.player.pause();
    this.player.seek(to);
    void this.player.play();
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
    if (!on && this.pr.trainer.on) {
      this.pr.trainer.on = false;
      this.practiceChanged();
    }
    this.updateLoopUi();
    this.emit();
  }

  private setPoint(which: 'a' | 'b') {
    this.loop[which] = this.snap(this.player.state.pos);
    if (this.loop.b <= this.loop.a) {
      if (which === 'a') this.loop.b = Math.min(this.length, this.loop.a + 8 * SR);
      else this.loop.a = Math.max(0, this.loop.b - 8 * SR);
    }
    this.setLoop(true);
  }

  private updateLoopUi() {
    if (!$('keyPanel').hidden) this.refreshKeySectionBtn();
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
    // (fractions are of the visible range; frameAt() converts)
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
        this.loop.a = Math.round(this.frameAt(a));
        this.loop.b = Math.round(this.frameAt(b));
        this.dirty = true;
      }
    });
    wrap.addEventListener('pointerup', (e) => {
      if (!this.drag) return;
      if (this.drag.moved) {
        this.snapLoop();
        this.setLoop(true);
        this.player.seek(this.loop.a);
      } else this.seekFrac(frac(e));
      this.drag = null;
    });
  }

  private initKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this.r || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || (e.target as HTMLElement)?.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      const pos = this.player.state.pos;
      const k = e.key;
      if (e.code === 'Space' || k === 'PageDown' || k === 'MediaPlayPause' || (this.pedal && ['ArrowRight', 'ArrowDown', 'Enter'].includes(k))) this.toggle();
      else if (k === 'PageUp' || k === 'Home' || (this.pedal && ['ArrowLeft', 'ArrowUp'].includes(k))) this.restart();
      else if (k === 'm' || k === 'M') this.addMarker();
      else if (k === '+' || k === '=') this.zoom(2);
      else if (k === '-' || k === '_') this.zoom(0.5);
      else if (k === '0') this.setView(0, this.length);
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
    const x = (f: number) => ((f - this.view.start) / (this.view.end - this.view.start)) * w;
    const px = Math.max(-2, Math.min(w + 2, x(pos)));
    if (showLoop && this.loop.b > this.loop.a) {
      g.fillStyle = this.loop.on ? 'rgba(139,124,246,0.18)' : 'rgba(139,124,246,0.08)';
      g.fillRect(x(this.loop.a), 0, x(this.loop.b) - x(this.loop.a), hh);
    }
    g.drawImage(layers[0], 0, 0);
    g.save();
    g.beginPath();
    g.rect(0, 0, px, hh);
    g.clip();
    g.drawImage(layers[1], 0, 0);
    g.restore();
    // Section markers
    g.fillStyle = '#f59e0b';
    for (const m of this.markers) {
      const mx = x(m.pos);
      if (mx < -1 || mx > w + 1) continue;
      g.fillRect(Math.round(mx), 0, Math.max(1, devicePixelRatio), hh);
    }
    g.fillStyle = getComputedStyle(document.body).color;
    g.fillRect(Math.round(px), 0, Math.max(1, devicePixelRatio), hh);
  }

  /** Marker names on the overview. */
  private drawMarkerLabels(c: HTMLCanvasElement) {
    if (!this.markers.length) return;
    const g = c.getContext('2d')!;
    const w = c.width;
    const dpr = devicePixelRatio || 1;
    g.font = `600 ${10 * dpr}px system-ui, sans-serif`;
    g.textBaseline = 'top';
    for (const m of this.markers) {
      const mx = ((m.pos - this.view.start) / (this.view.end - this.view.start)) * w;
      if (mx < -40 * dpr || mx > w) continue;
      const tw = g.measureText(m.name).width + 6 * dpr;
      g.fillStyle = '#f59e0b';
      g.fillRect(mx, 0, tw, 13 * dpr);
      g.fillStyle = '#111';
      g.fillText(m.name, mx + 3 * dpr, 1.5 * dpr);
    }
  }

  private draw() {
    this.dirty = false;
    const pos = this.player.state.pos;
    $('timeNow').textContent = fmtTime(pos / SR);
    // Keep the playhead in view while zoomed in.
    const span = this.view.end - this.view.start;
    if (this.player.state.playing && span < this.length - 1 && (pos > this.view.end || pos < this.view.start)) this.setView(pos - span * 0.1, pos + span * 0.9);
    const here = this.sectionAt(pos);
    if (here !== (this as any).lastHere) {
      (this as any).lastHere = here;
      this.renderMarkers();
    }
    const ov = $<HTMLCanvasElement>('overview');
    fitCanvas(ov);
    const buckets = (w: number) => Math.max(1, Math.round(w / Math.max(2, Math.round(w / 700) + 1)));
    if (!this.overviewLayers || this.overviewLayers[0].width !== ov.width || this.overviewLayers[0].height !== ov.height) {
      const all = this.r!.stems.flatMap((s) => s.data);
      const p = peaksForView(this.overviewPeaks, all, this.view.start, this.view.end, buckets(ov.width));
      this.overviewLayers = [
        waveLayer(p, ov.width, ov.height, 'rgba(139,147,165,0.55)', this.overviewScale),
        waveLayer(p, ov.width, ov.height, '#8b7cf6', this.overviewScale),
      ];
    }
    this.drawStrip(ov, this.overviewLayers, pos, true);
    this.drawBars(ov);
    this.drawMarkerLabels(ov);
    for (const l of this.lanes) {
      fitCanvas(l.canvas);
      if (!l.layers || l.layers[0].width !== l.canvas.width || l.layers[0].height !== l.canvas.height) {
        const c = l.colour;
        const p = peaksForView(l.peaks, l.data, this.view.start, this.view.end, buckets(l.canvas.width));
        l.layers = [waveLayer(p, l.canvas.width, l.canvas.height, c + '66', this.laneScale), waveLayer(p, l.canvas.width, l.canvas.height, c, this.laneScale)];
      }
      this.drawStrip(l.canvas, l.layers, pos, true);
    }
  }

  /** Faint bar lines on the overview once the tempo is known. */
  private drawBars(c: HTMLCanvasElement) {
    const beats = this.beatFrames();
    if (!beats.length) return;
    const g = c.getContext('2d')!;
    const w = c.width;
    const span = this.view.end - this.view.start || 1;
    const x = (f: number) => Math.round(((f - this.view.start) / span) * w);
    const d = this.downbeat();
    const bars = beats.filter((_, i) => (i - d) % this.pr.perBar === 0);
    g.fillStyle = getComputedStyle(document.body).color;
    // Zoomed in far enough: show every beat faintly, bars stronger.
    if (beats.length > 1 && ((beats[1] - beats[0]) / span) * w >= 8) {
      g.globalAlpha = 0.08;
      for (const b of beats) if (b >= this.view.start && b <= this.view.end) g.fillRect(x(b), 0, Math.max(1, devicePixelRatio), c.height);
    }
    if (bars.length > 1 && ((bars[1] - bars[0]) / span) * w >= 4) {
      g.globalAlpha = 0.2;
      for (const b of bars) if (b >= this.view.start && b <= this.view.end) g.fillRect(x(b), 0, Math.max(1, devicePixelRatio), c.height);
    }
    g.globalAlpha = 1;
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
      this.lanes.some((l, i) => g[i] > 0 && !isFlat(l.eq)) ? 'EQ' : '',
      useLoop ? `${fmtTime(start / SR).replace(':', '.')}-${fmtTime(end / SR).replace(':', '.')}` : '',
    ].filter(Boolean);
    const name = `${this.baseName()} - ${bits.join(' ')}.${extensionFor(o)}`;
    const btn = $<HTMLButtonElement>('exportMixBtn');
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      await this.encoder.run(
        { type: 'mix', name, stems: this.r.stems.map((s) => s.data), gains: g, pans: this.pans(), eqs: this.eqs(), start, end, tempo: this.tempo, pitch: this.pitch, out: o },
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
