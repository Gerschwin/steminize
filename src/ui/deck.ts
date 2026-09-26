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
import { Transcribe, type TxHost, type TxState } from './transcribePanel.ts';
import type { Chord } from '../analysis/chords.ts';
import type { NoteEvent } from '../analysis/basicPitch.ts';
import type { Cqt } from '../analysis/cqt.ts';
import { noteName } from '../analysis/cqt.ts';
import { detectPitch, freqToNote } from '../analysis/pitch.ts';

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
  /** Detected (and corrected) chords; MIDI notes per part ("mix" = what you heard). */
  chords?: Chord[];
  midi?: Record<string, NoteEvent[]>;
  /** Note energy per stem for the note view (memory only). */
  cqt?: Map<string, { c: Cqt; peak: number }>;
  /** Live-recorded takes, loaded from the library alongside the stems (see the Live input drawer). One entry per recorded source (bass, guitar, ...). */
  takeGroups?: { id: string; activeTake?: string; takes: { id: string; data: Stereo; note?: string }[] }[];
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
  lanes: { vol: number; pan: number; mute: boolean; solo: boolean; eq?: EqParams; height?: number; label?: string }[];
  loop: { on: boolean; a: number; b: number };
  tempo: number;
  pitch: number;
  practice: PracticeUi;
  markers?: Marker[];
  /** Note view, chords and MIDI. */
  tx?: TxState;
  /** Lyrics, tab, drum tab and free notes, per song. */
  scratch?: ScratchState;
}

/** Plain-text scratchpad, kept simple on purpose: no per-line structure, just what you paste or type. */
export interface ScratchState {
  lyrics?: string;
  tab?: string;
  drums?: string;
  notes?: string;
}

interface Marker {
  name: string;
  pos: number; // frames
}
const FINE = 256; // samples per bucket in the fine peak arrays used for zoomed drawing
// Matches the CSS default track height: below that the waveform becomes too thin to read.
const LANE_MIN_H = 58;
// With per-track Pan sliders shown, the control panel grows a row taller: below this the
// waveform falls short of it again (matches .lanes.show-pan .wave in styles.css).
const PAN_MIN_H = 88;

interface Lane {
  name: string;
  colour: string;
  vol: number;
  pan: number;
  eq?: EqParams;
  eqPanel?: EqPanel;
  mute: boolean;
  solo: boolean;
  label?: string; // display name; unset shows a formatted `name`. Doesn't affect role detection (chords, MIDI).
  height?: number; // px; unset uses the CSS default
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  peaks: Float32Array; // fine peaks (FINE samples per bucket)
  data: Stereo;
  layers?: [HTMLCanvasElement, HTMLCanvasElement];
  /** This track's own zoom, independent of the shared view; unset follows the shared view. */
  ownView?: { start: number; end: number };
  /** True for a lane that holds live-recorded takes (a song can have several — bass, guitar,
   * ...); all its takes share this one mixer slot, only the active one is ever actually mixed in. */
  recordGroup?: boolean;
  /** Stable internal id for a recordGroup lane, used as its takes' storage filename prefix (its
   * own display name is just the lane's normal, renameable label — this is never shown). */
  groupId?: string;
  takes?: Take[];
  activeTakeId?: string;
  takesEl?: HTMLElement; // the collapsed-takes strip under this lane, once it has more than one
}

interface Take {
  id: string; // "take-1", "take-2", ... also the saved filename stem
  data: Stereo;
  peaks: Float32Array;
  note?: string; // freeform, e.g. "rushed the bridge" — a reminder for telling takes apart later
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
/** A track's display name: its own rename if it has one, else a tidied-up stem name. */
function laneLabel(l: Pick<Lane, 'name' | 'label'>) {
  return l.label ?? (l.name.startsWith('no_') ? `No ${l.name.slice(3)}` : l.name);
}

/** Restores a line's leading "label|" (e.g. "HH|") if it's been damaged: the pipe deleted on its own, or the whole prefix gone. Already-correct lines pass through unchanged. */
function fixLinePrefix(line: string, templateLine: string) {
  const pipeIdx = templateLine.indexOf('|');
  if (pipeIdx < 0) return line;
  const label = templateLine.slice(0, pipeIdx);
  const prefix = templateLine.slice(0, pipeIdx + 1);
  if (line.startsWith(prefix)) return line;
  if (line.startsWith(label)) return `${label}|${line.slice(label.length)}`;
  return prefix + line;
}

/**
 * Adds more bars to a tab/drum-tab, each line's own trailing "|" kept at the end so the lines
 * stay lined up. An empty box gets the blank template back rather than nothing to extend. Within
 * the template's line count, any row that's missing or was emptied out (a string deleted along
 * with its content, not just missing from the end) gets that string's line restored from the
 * template, brought up to the other lines' width, before everyone gets the new bars. A line whose
 * leading "label|" was damaged (e.g. just the "|" deleted) gets that fixed too, not just extended
 * as-is. Extra lines past the template (freeform notes below the tab) are left alone if blank,
 * extended if not.
 */
function extendTabText(text: string, template: string, addChars = 16) {
  if (!text.trim()) return template;
  const templateLines = template.split('\n');
  const lines = text.split('\n');
  while (lines.length < templateLines.length) lines.push('');
  for (let i = 0; i < templateLines.length; i++) lines[i] = lines[i].trim() ? fixLinePrefix(lines[i], templateLines[i]) : templateLines[i];
  const maxLen = Math.max(...lines.slice(0, templateLines.length).map((l) => l.length));
  const pad = (line: string, len: number, ch: string) => (line.endsWith('|') ? `${line.slice(0, -1)}${ch.repeat(len)}|` : line + ch.repeat(len));
  return lines
    .map((line, i) => {
      if (i >= templateLines.length) return line.trim() ? pad(line, addChars, '-') : line;
      if (line.length < maxLen) line = pad(line, maxLen - line.length, '-');
      return pad(line, addChars, '-');
    })
    .join('\n');
}

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
  private seekToastAt = 0;
  private notifySeekBlocked = () => {
    if (performance.now() - this.seekToastAt < 2000) return;
    this.seekToastAt = performance.now();
    toast('Stop recording to move the playhead');
  };
  private encoder = encoder;
  private pr: PracticeUi = structuredClone(DEFAULT_PR);
  private taps: number[] = [];
  private quiet = false; // suppress state-change events while restoring a song
  /** Called (often) whenever the player setup changes; the caller debounces saving. */
  onStateChange: (s: DeckState) => void = () => {};
  /** Called when a tempo correction changes the song's analysis. */
  onAnalysisChange: (r: Result) => void = () => {};
  /** Called when the song is renamed, so the library entry (if any) can be updated. */
  onRename: (title: string) => void = () => {};
  /** A new take was recorded and is now the active one; save it (and which one is active) to the library, if this song is kept there. `groupId` identifies which recording (bass, guitar, ...) it belongs to. */
  onTakeAdded: (groupId: string, take: { id: string; data: Stereo; note?: string }) => Promise<void> = () => Promise.resolve();
  /** A different existing take was switched to. */
  onTakeSelected: (groupId: string, takeId: string) => void = () => {};
  /** A take was discarded; remove it from the library, if this song is kept there. */
  onTakeRemoved: (groupId: string, takeId: string) => Promise<void> = () => Promise.resolve();
  /** A take's note was edited; metadata only, no audio to re-save. */
  onTakeNoteChanged: (groupId: string, takeId: string, note: string) => void = () => {};
  /** Ranks keys for the song, or for a range of frames. */
  rankKeys: (r: Result, start?: number, end?: number) => Promise<KeyCandidate[]> = () => Promise.resolve([]);
  /** Provides onset envelopes for a song that doesn't have them in memory. */
  needOnsets: (r: Result) => Promise<{ env: Float32Array; low: Float32Array }> = () => Promise.reject(new Error('unavailable'));
  private r: Result | null = null;
  private lanes: Lane[] = [];
  /** The track scroll-to-zoom applies to; others just scroll the page. Click a track to pick it. */
  private selectedLane: Lane | null = null;
  private stopLiveInputUi: () => void = () => {};
  private refreshRecordTargetsUi: () => void = () => {};
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
  private drag: { x0: number; moved: boolean; edge?: 'a' | 'b' } | null = null;
  onRerun: () => void = () => {};
  private tx: Transcribe;
  private scratch: ScratchState = {};
  private scratchAreas!: { lyrics: HTMLTextAreaElement; tab: HTMLTextAreaElement; drums: HTMLTextAreaElement; notes: HTMLTextAreaElement };
  // ---- a live recording being drawn in as its own track while it's captured ----
  private recordLane: Lane | null = null;
  private recordStartPos = 0;
  private recordDrawTimer = 0;

  constructor(private settings: () => Settings) {
    this.player.onSeekBlocked = this.notifySeekBlocked;
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
    $('trackTitle').title = 'Double-click to rename';
    $('trackTitle').ondblclick = () => this.renameSong();
    $('playBtn').onclick = () => this.toggle();
    $('toStartBtn').onclick = () => this.player.seek(0);
    $('toEndBtn').onclick = () => this.player.seek(Math.max(0, this.length - SR));
    $('rewindBtn').onclick = () => this.skip(-5);
    $('ffBtn').onclick = () => this.skip(5);
    $('loopBtn').onclick = () => this.setLoop(!this.loop.on);
    $('setA').onclick = () => this.setPoint('a');
    $('setB').onclick = () => this.setPoint('b');
    $('clearLoop').onclick = () => this.clearLoop();
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
      // Tracks with an explicit (drag-resized) height keep it, but never smaller than what
      // the current control panel needs, so toggling Pan can't leave them shorter than it.
      const floor = this.laneMinH();
      for (const l of this.lanes) {
        if (l.height == null) continue;
        (l.el.querySelector('.wave') as HTMLElement).style.height = `${Math.max(l.height, floor)}px`;
      }
      try {
        localStorage.setItem('steminize.showPan', on ? '1' : '');
      } catch {
        /* ignore */
      }
    };
    let panOn = false;
    try {
      panOn = localStorage.getItem('steminize.showPan') === '1';
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
    this.initLiveInput();
    this.initTuner();
    this.initScratchpad();
    const host: TxHost = {
      player: this.player,
      song: () => this.r,
      view: () => this.view,
      gains: () => this.gains(),
      pans: () => this.pans(),
      eqs: () => this.eqs(),
      lanes: () => this.lanes.map((l) => ({ name: l.name, colour: l.colour })),
      pitch: () => this.pitch,
      loop: () => this.loop,
      markers: () => this.markers,
      beats: () => this.r?.analysis?.beats ?? [],
      downbeat: () => this.downbeat(),
      perBar: () => this.pr.perBar,
      bpm: () => this.r?.analysis?.bpm,
      key: () => this.r?.analysis?.key,
      keyLabel: () => {
        const k = this.r?.analysis?.key;
        return k ? keyName(k, this.pitch) : undefined;
      },
      seekFrac: (f) => this.seekFrac(f),
      wheel: (e, el) => this.onWheel(e, el),
      changed: () => this.emit(),
      redraw: () => (this.dirty = true),
      baseName: () => this.baseName(),
    };
    this.tx = new Transcribe(host);
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

  /** Builds one track's DOM and wiring (mute/solo/EQ/vol/pan/rename/resize/zoom/export) and appends it to #lanes. Shared by the initial song-open loop and by a finished live recording, which adds itself as a lane the same way. */
  private buildLane(s: { name: string; data: Stereo }, i: number, colourOverride?: string): Lane {
    const colour = colourOverride ?? stemColour(s.name, i);
    const canvas = h('canvas');
    const mute = h('button', { class: 'ms m', type: 'button', title: `Mute (${i + 1})` }, 'M');
    const solo = h('button', { class: 'ms s', type: 'button', title: 'Solo' }, 'S');
    const eqBtn = h('button', { class: 'ms eq', type: 'button', title: 'EQ: presets, low/high cut and a focus band' }, 'EQ');
    const dl = h('button', { class: 'dl', type: 'button', title: `Save ${laneLabel({ name: s.name })}` });
    dl.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>';
    const vol = h('input', { type: 'range', min: '0', max: '1.5', step: '0.01', value: '1', title: 'Level' });
    const pan = h('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: '0', title: 'Pan (double-click to centre)' });
    const panOut = h('output', {}, 'C');
    const nameBtn = h(
      'button',
      { class: 'name', type: 'button', title: 'Double-click to rename' },
      laneLabel({ name: s.name }),
      h('span', { class: 'take-badge muted' }),
    );
    const ctl = h(
      'div',
      { class: 'lane-ctl' },
      nameBtn,
      mute,
      solo,
      eqBtn,
      dl,
      h('label', { class: 'mini vol' }, h('span', {}, 'Vol'), vol),
      h('label', { class: 'mini pan' }, h('span', {}, 'Pan'), pan, panOut),
    );
    const wave = h('div', { class: 'wave', title: 'Click to seek and pick this track; scroll to zoom once it’s picked' }, canvas);
    const resizeHandle = h('div', {
      class: 'lane-resize',
      title: 'Drag to resize this track (or Shift with + / − for every track). Double-click to reset.',
    });
    const el = h('div', { class: 'lane', style: `--c:${colour}` }, ctl, wave, resizeHandle);
    $('lanes').append(el);
    const lane: Lane = { name: s.name, colour, vol: 1, pan: 0, mute: false, solo: false, el, canvas, peaks: peaksOf(s.data), data: s.data };
    eqBtn.onclick = () => this.toggleEq(lane, lane.colour);
    pressed(eqBtn, false);
    nameBtn.ondblclick = () => this.renameLane(lane, nameBtn, dl);
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
    dl.onclick = () => this.saveStem(this.lanes.indexOf(lane));
    // Click seeks; dragging across the lane marks a loop section, like the overview strip does
    // (the section is marked but the loop is left off, so scanning for a part doesn't yank playback).
    // Mouse/pen only: on touch a drag has to keep scrolling the page.
    const laneFrame = (e: PointerEvent) => {
      const view = lane.ownView ?? this.view;
      const f = Math.max(0, Math.min(1, (e.clientX - wave.getBoundingClientRect().left) / wave.clientWidth));
      return { f, frame: view.start + f * (view.end - view.start) };
    };
    let laneDrag: { f0: number; frame0: number; moved: boolean; edge?: 'a' | 'b' } | null = null;
    let swallowClick = false; // a drag ends in a click event; don't let it also seek
    wave.addEventListener('pointerdown', (e) => {
      swallowClick = false; // a drag that produced no click must not eat the next real one
      if (e.button !== 0 || e.pointerType === 'touch') return;
      wave.setPointerCapture(e.pointerId);
      const { f, frame } = laneFrame(e);
      const edge = this.loopEdgeAt(f * wave.clientWidth, wave.clientWidth, lane.ownView ?? this.view);
      laneDrag = { f0: f, frame0: frame, moved: false, edge: edge ?? undefined };
    });
    wave.addEventListener('pointermove', (e) => {
      const { f, frame } = laneFrame(e);
      if (!laneDrag) {
        wave.style.cursor = this.loopEdgeAt(f * wave.clientWidth, wave.clientWidth, lane.ownView ?? this.view) ? 'ew-resize' : '';
        return;
      }
      if (laneDrag.edge) {
        if (Math.abs(f - laneDrag.f0) * wave.clientWidth > 3) laneDrag.moved = true;
        if (laneDrag.moved) this.dragLoopEdge(laneDrag.edge, frame);
        return;
      }
      if (Math.abs(f - laneDrag.f0) * wave.clientWidth > 6) laneDrag.moved = true;
      if (!laneDrag.moved) return;
      this.loop.a = Math.round(Math.min(laneDrag.frame0, frame));
      this.loop.b = Math.round(Math.max(laneDrag.frame0, frame));
      this.dirty = true;
    });
    wave.addEventListener('pointerup', () => {
      if (laneDrag?.moved) {
        swallowClick = true;
        if (laneDrag.edge) this.finishLoopEdgeDrag();
        else {
          this.snapLoop();
          this.updateLoopUi();
          this.emit();
        }
      }
      laneDrag = null;
    });
    wave.addEventListener('pointercancel', () => (laneDrag = null));
    wave.onclick = (e) => {
      if (swallowClick) {
        swallowClick = false;
        return;
      }
      const view = lane.ownView ?? this.view;
      const f = Math.max(0, Math.min(1, e.offsetX / wave.clientWidth));
      this.player.seek(view.start + f * (view.end - view.start));
    };
    // Scroll-to-zoom only acts on the picked track, zooming just that track, so scrolling
    // the page past the others doesn't hijack it or change what they're showing.
    el.addEventListener('click', () => this.selectLane(lane));
    wave.addEventListener(
      'wheel',
      (e) => {
        if (this.selectedLane === lane) this.onWheel(e, wave, lane);
      },
      { passive: false },
    );
    let dragFromH: number | null = null;
    resizeHandle.addEventListener('pointerdown', (e) => {
      resizeHandle.setPointerCapture(e.pointerId);
      dragFromH = wave.clientHeight - e.clientY;
    });
    resizeHandle.addEventListener('pointermove', (e) => {
      if (dragFromH == null) return;
      wave.style.height = `${Math.max(this.laneMinH(), Math.min(500, dragFromH + e.clientY))}px`;
      this.dirty = true;
    });
    resizeHandle.addEventListener('pointerup', () => {
      if (dragFromH == null) return;
      dragFromH = null;
      lane.height = wave.clientHeight;
      this.emit();
    });
    resizeHandle.ondblclick = () => {
      wave.style.height = '';
      lane.height = undefined;
      this.dirty = true;
      this.emit();
    };
    pressed(mute, false);
    pressed(solo, false);
    return lane;
  }

  /** Every lane that holds live-recorded takes (e.g. one for bass, one for guitar). */
  private findRecordGroups() {
    return this.lanes.filter((l) => l.recordGroup);
  }

  /** How many takes to keep per recording (oldest dropped first past this); a global preference, set in the Live input drawer. */
  private maxTakes(): number {
    try {
      const v = Number(localStorage.getItem('steminize.maxTakes'));
      if (Number.isFinite(v) && v >= 1) return Math.min(20, Math.round(v));
    } catch {
      /* ignore */
    }
    return 5;
  }

  /** Starts drawing a live waveform for a new take in progress. Pass an existing take-group lane
   * to add another take to it (e.g. a second bass take); omit it to start a new named group (e.g.
   * switching to guitar) — its mixer slot is created once and reused by every take put into it,
   * only the active one is ever actually in the mix. finishRecordLane() turns the draft into a
   * real take once it's stopped; this is just visual feedback that it's actually picking up
   * signal, so it doesn't touch the group's own name (set once, renameable like any track). */
  private beginRecordLane(target?: Lane) {
    if (!this.r) return;
    const bucketCount = Math.max(1, Math.ceil(this.length / FINE));
    let lane = target;
    if (!lane) {
      const data: Stereo = [new Float32Array(this.length), new Float32Array(this.length)];
      lane = this.buildLane({ name: `Track ${this.findRecordGroups().length + 1}`, data }, this.lanes.length, '#ef4444');
      lane.recordGroup = true;
      lane.groupId = Math.random().toString(36).slice(2, 10);
      lane.takes = [];
      this.lanes.push(lane);
      this.player.addTrack(data);
      this.player.setGains(this.gains(), this.pans(), this.eqs());
    } else {
      lane.data = [new Float32Array(this.length), new Float32Array(this.length)];
    }
    lane.peaks = new Float32Array(bucketCount);
    lane.el.classList.add('recording');
    this.recordLane = lane;
    this.recordStartPos = this.player.state.pos;
    // Grows by wall-clock time, not the playhead: recording works whether or not the song is
    // actually playing, so tying live drawing to a possibly-stationary playhead could leave it
    // updating a single bucket in place instead of visibly filling in left to right.
    const wallStart = performance.now();
    this.recordDrawTimer = window.setInterval(() => {
      const l = this.recordLane;
      if (!l) return;
      const elapsedFrames = Math.round(((performance.now() - wallStart) / 1000) * SR);
      const bucket = Math.floor((this.recordStartPos + elapsedFrames) / FINE);
      if (bucket >= 0 && bucket < l.peaks.length) {
        // A live meter reading is usually well under the amplitude the shared display scale
        // expects (calibrated off the separated stems), so boost it a bit here purely for
        // visibility; it has no bearing on the real, accurate peaks computed after stopping.
        l.peaks[bucket] = Math.max(l.peaks[bucket], Math.min(1, this.player.monitorLevel() * 2.5));
        l.layers = undefined;
        this.dirty = true;
      }
    }, 80);
  }

  /** Stops the live waveform drawing and, given the finished recording (or null if there was
   * nothing to keep), decodes it, places it in the song at the frame position recording started
   * at, and adds it as a new take — selected, saved, and mixed in at the group's one slot. */
  private async finishRecordLane(blob: Blob | null) {
    clearInterval(this.recordDrawTimer);
    const lane = this.recordLane;
    this.recordLane = null;
    if (!lane) return;
    lane.el.classList.remove('recording');
    const takes = lane.takes ?? [];
    if (!blob) {
      if (takes.length) this.selectTake(lane, takes[takes.length - 1]);
      else {
        lane.el.remove();
        this.lanes.splice(this.lanes.indexOf(lane), 1);
      }
      return;
    }
    try {
      const ctx = new OfflineAudioContext(2, 1, SR);
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
      const ch = (i: number) => audio.getChannelData(Math.min(i, audio.numberOfChannels - 1));
      const raw: Stereo = [ch(0), ch(1)];
      const data: Stereo = [new Float32Array(this.length), new Float32Array(this.length)];
      const offset = Math.min(this.length, Math.max(0, this.recordStartPos));
      const n = Math.min(raw[0].length, this.length - offset);
      if (n > 0) {
        data[0].set(raw[0].subarray(0, n), offset);
        data[1].set(raw[1].subarray(0, n), offset);
      }
      const take: Take = { id: `take-${takes.length + 1}`, data, peaks: peaksOf(data) };
      lane.takes = [...takes, take];
      if (takes.length === 0) {
        lane.colour = stemColour('take', this.lanes.indexOf(lane));
        lane.el.style.setProperty('--c', lane.colour);
      }
      // Oldest take(s) first, once there are more than the "Keep last" setting allows.
      const cap = this.maxTakes();
      const dropped: Take[] = [];
      while (lane.takes.length > cap) dropped.push(lane.takes.shift()!);
      this.selectTake(lane, take);
      this.refreshTunerSources();
      await this.onTakeAdded(lane.groupId!, { id: take.id, data: take.data });
      for (const d of dropped) await this.onTakeRemoved(lane.groupId!, d.id).catch(() => {});
      toast(dropped.length ? `${take.id} added (dropped ${dropped.map((d) => d.id).join(', ')})` : `${take.id} added`);
    } catch (e) {
      if (takes.length) this.selectTake(lane, takes[takes.length - 1]);
      else {
        lane.el.remove();
        this.lanes.splice(this.lanes.indexOf(lane), 1);
      }
      toast(`Couldn't add the recording: ${(e as Error).message}`, true);
    }
  }

  /** Makes `take` the active, audible one for its take-group lane: swaps the displayed waveform
   * and the mixer's audio at that one shared slot, and rebuilds the collapsed-takes strip. */
  private selectTake(lane: Lane, take: Take) {
    lane.activeTakeId = take.id;
    lane.data = take.data;
    lane.peaks = take.peaks;
    lane.layers = undefined;
    const badge = lane.el.querySelector('.take-badge');
    if (badge) badge.textContent = (lane.takes?.length ?? 0) > 1 ? ` · ${take.id}` : '';
    this.laneScale = 1 / Math.max(1e-3, ...this.lanes.flatMap((l) => Math.max(...l.peaks)));
    this.player.replaceTrack(this.lanes.indexOf(lane), take.data);
    this.renderTakeStrip(lane);
    this.dirty = true;
    this.emit();
  }

  /** The row of other takes for a lane, below its main controls: click one to switch to it, or delete it. */
  /** A click-to-edit note button for one take, reused for both the active take's row and the collapsed others. */
  private takeNoteEditor(lane: Lane, t: Take): HTMLElement {
    const val = t.note ?? '';
    const btn = h('button', { class: 'take-note', type: 'button', title: val || 'Add a note' }, val || '+ note');
    btn.onclick = (e) => {
      e.stopPropagation();
      const input = h('input', { type: 'text', class: 'take-note-edit', value: val, placeholder: 'Note…', maxLength: 80 } as any);
      const finish = (save: boolean) => {
        if (save && input.value.trim() !== (t.note ?? '')) {
          t.note = input.value.trim() || undefined;
          this.onTakeNoteChanged(lane.groupId!, t.id, t.note ?? '');
        }
        input.replaceWith(this.takeNoteEditor(lane, t));
      };
      input.onclick = (e2) => e2.stopPropagation();
      input.onkeydown = (e2) => {
        e2.stopPropagation();
        if (e2.key === 'Enter') finish(true);
        if (e2.key === 'Escape') finish(false);
      };
      input.onblur = () => finish(true);
      btn.replaceWith(input);
      input.focus();
      input.select();
    };
    return btn;
  }

  /** Every take for a lane, one row each: the active one first (no switch/delete, just its note),
   * then the others (click to switch, × to delete). Notes are editable on any of them. */
  private renderTakeStrip(lane: Lane) {
    const takes = lane.takes ?? [];
    if (!takes.length) {
      lane.takesEl?.remove();
      lane.takesEl = undefined;
      return;
    }
    lane.takesEl ??= h('div', { class: 'take-strip' });
    if (!lane.takesEl.isConnected) lane.el.insertBefore(lane.takesEl, lane.el.lastElementChild);
    lane.takesEl.replaceChildren(
      ...takes.map((t) => {
        const active = t.id === lane.activeTakeId;
        if (active) return h('div', { class: 'take-row active' }, h('span', { class: 'take-chip current' }, t.id), this.takeNoteEditor(lane, t));
        const switchBtn = h('button', { class: 'take-chip', type: 'button', title: `Switch to ${t.id}` }, t.id);
        switchBtn.onclick = () => {
          this.selectTake(lane, t);
          this.onTakeSelected(lane.groupId!, t.id);
        };
        const del = h('button', { class: 'take-del', type: 'button', title: `Delete ${t.id}` }, '×');
        del.onclick = (e) => {
          e.stopPropagation();
          void this.deleteTake(lane, t);
        };
        return h('div', { class: 'take-row' }, switchBtn, this.takeNoteEditor(lane, t), del);
      }),
    );
  }

  private async deleteTake(lane: Lane, take: Take) {
    if (!confirm(`Delete ${take.id}? This can't be undone.`)) return;
    lane.takes = (lane.takes ?? []).filter((t) => t.id !== take.id);
    this.renderTakeStrip(lane);
    try {
      await this.onTakeRemoved(lane.groupId!, take.id);
    } catch (e) {
      toast(`Couldn't delete ${take.id}: ${(e as Error).message}`, true);
    }
    if (!lane.takes.length) {
      // Nothing left at this slot. There's no message to remove a track from the player outright,
      // so silence it in place (a zeroed stem is inaudible either way) and drop its row.
      this.player.replaceTrack(this.lanes.indexOf(lane), [new Float32Array(this.length), new Float32Array(this.length)]);
      lane.takesEl?.remove();
      lane.el.remove();
      this.lanes.splice(this.lanes.indexOf(lane), 1);
      this.player.setGains(this.gains(), this.pans(), this.eqs());
      this.refreshRecordTargetsUi();
      this.dirty = true;
      this.emit();
    }
  }

  /** Rebuilds the take-group lane from takes loaded off the library (if any), same shape as a
   * live recording produces: one lane, one mixer slot, the saved active take selected. Appended
   * after the stem lanes, same as a live recording would be, so a saved DeckState's per-lane
   * settings (indexed positionally) still line up with the right lane on reopen. */
  private restoreTakes(r: Result) {
    if (!r.takeGroups?.length) return;
    for (const g of r.takeGroups) {
      if (!g.takes.length) continue;
      const placeholder: Stereo = [new Float32Array(this.length), new Float32Array(this.length)];
      const lane = this.buildLane({ name: `Track ${this.findRecordGroups().length + 1}`, data: placeholder }, this.lanes.length, '#ef4444');
      lane.recordGroup = true;
      lane.groupId = g.id;
      const takes: Take[] = g.takes.map((t) => ({ id: t.id, data: t.data, peaks: peaksOf(t.data), note: t.note }));
      const active = takes.find((t) => t.id === g.activeTake) ?? takes[takes.length - 1];
      // The "Keep last" cap may have been lowered since these were saved: trim down to it now,
      // oldest first, but never the one that's actually selected.
      const cap = this.maxTakes();
      const dropped: Take[] = [];
      while (takes.length > cap) {
        const i = takes.findIndex((t) => t !== active);
        if (i < 0) break;
        dropped.push(takes.splice(i, 1)[0]);
      }
      lane.takes = takes;
      this.lanes.push(lane);
      this.player.addTrack(placeholder);
      this.selectTake(lane, active);
      for (const d of dropped) void this.onTakeRemoved(g.id, d.id).catch(() => {});
    }
    this.refreshRecordTargetsUi();
  }

  open(r: Result, state?: DeckState) {
    this.stopLiveInputUi();
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
    this.updateLyricsLink();
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
    this.selectedLane = null;
    this.lanes = r.stems.map((s, i) => this.buildLane(s, i));
    this.player.load(r.stems.map((s) => s.data), this.gains());
    this.restoreTakes(r);
    if (state) this.applyState(state);
    this.refreshTunerSources();
    this.setTempoPitch(this.tempo, this.pitch, false);
    this.player.setLoop(this.loop.on, this.loop.a, this.loop.b);
    this.updateLoopUi();
    this.laneScale = 1 / Math.max(1e-3, ...this.lanes.flatMap((l) => Math.max(...l.peaks)));
    this.syncPracticeUi();
    this.renderMarkers();
    this.setView(0, this.length);
    this.setAnalysis(r.analysis);
    this.tx.open(r, state?.tx);
    this.applyScratch(state?.scratch);
    this.invalidateLayers();
    this.quiet = false;
  }

  // ---------- saved state ----------
  getState(): DeckState {
    return {
      lanes: this.lanes.map((l) => ({ vol: l.vol, pan: l.pan, mute: l.mute, solo: l.solo, eq: l.eq, height: l.height, label: l.label })),
      loop: { ...this.loop },
      tempo: this.tempo,
      pitch: this.pitch,
      practice: structuredClone({ ...this.pr, trainer: { ...this.pr.trainer, on: false } }),
      markers: this.markers.map((m) => ({ ...m })),
      tx: this.tx.getState(),
      scratch: { ...this.scratch },
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
      if (l.height) (l.el.querySelector('.wave') as HTMLElement).style.height = `${Math.max(l.height, this.laneMinH())}px`;
      if (l.label) {
        const nameBtn = l.el.querySelector('.name')!;
        const badgeText = nameBtn.querySelector('.take-badge')?.textContent ?? '';
        nameBtn.replaceChildren(laneLabel(l), h('span', { class: 'take-badge muted' }, badgeText));
        (l.el.querySelector('.dl') as HTMLElement).title = `Save ${laneLabel(l)}`;
      }
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

  // ---------- live input: a real instrument or mic, played live alongside the tracks ----------
  private initLiveInput() {
    if (!navigator.mediaDevices?.getUserMedia) return; // liveTab stays hidden: not available here
    $('liveTab').hidden = false;
    const btn = $<HTMLButtonElement>('liveBtn');
    const deviceSel = $<HTMLSelectElement>('liveDevice');
    const vol = $<HTMLInputElement>('liveVol');
    const volWrap = $('liveVolWrap');
    const pan = $<HTMLInputElement>('livePan');
    const panWrap = $('livePanWrap');
    const panOut = $('livePanOut');
    const meter = $('liveMeter');
    const meterBar = $('liveMeterBar');
    const recordTarget = $<HTMLSelectElement>('liveRecordTarget');
    const recordBtn = $<HTMLButtonElement>('liveRecordBtn');
    const recordTime = $('liveRecordTime');
    const status = $('liveStatus');
    const sum = $('sumLive');

    const maxTakesInput = $<HTMLInputElement>('liveMaxTakes');
    maxTakesInput.value = String(this.maxTakes());
    maxTakesInput.onchange = () => {
      const v = Math.max(1, Math.min(20, Math.round(Number(maxTakesInput.value)) || 5));
      maxTakesInput.value = String(v);
      try {
        localStorage.setItem('steminize.maxTakes', String(v));
      } catch {
        /* ignore */
      }
      // Apply immediately to every recording (bass, guitar, ...) that already has more takes than the new cap allows.
      for (const lane of this.findRecordGroups()) {
        if (!lane.takes) continue;
        const active = lane.takes.find((t) => t.id === lane.activeTakeId);
        while (lane.takes.length > v) {
          const i = lane.takes.findIndex((t) => t !== active);
          if (i < 0) break;
          const [dropped] = lane.takes.splice(i, 1);
          void this.onTakeRemoved(lane.groupId!, dropped.id).catch(() => {});
        }
        this.renderTakeStrip(lane);
      }
    };

    const refreshRecordTargets = () => {
      const groups = this.findRecordGroups();
      recordTarget.hidden = groups.length === 0;
      const current = recordTarget.value;
      recordTarget.replaceChildren(...groups.map((l) => h('option', { value: String(this.lanes.indexOf(l)) }, laneLabel(l))), h('option', { value: 'new' }, '+ New track'));
      if ([...recordTarget.options].some((o) => o.value === current)) recordTarget.value = current;
    };
    this.refreshRecordTargetsUi = refreshRecordTargets;
    refreshRecordTargets();

    const refreshDevices = async () => {
      const inputs = await this.player.listInputs();
      const current = deviceSel.value;
      deviceSel.replaceChildren(...inputs.map((d, i) => h('option', { value: d.deviceId }, d.label || `Input ${i + 1}`)));
      if (inputs.some((d) => d.deviceId === current)) deviceSel.value = current;
      deviceSel.hidden = inputs.length < 2;
    };
    navigator.mediaDevices.addEventListener?.('devicechange', () => {
      if (this.player.monitoring) void refreshDevices();
    });

    let meterTimer = 0;
    const meterTick = () => {
      if (!this.player.monitoring) return;
      meterBar.style.width = `${Math.round(this.player.monitorLevel() * 100)}%`;
      meterTimer = requestAnimationFrame(meterTick);
    };

    const setUi = (on: boolean) => {
      pressed(btn, on);
      btn.textContent = on ? 'Stop' : 'Monitor';
      volWrap.hidden = !on;
      panWrap.hidden = !on;
      meter.hidden = !on;
      recordBtn.hidden = !on;
      if (on) refreshRecordTargets();
      else recordTarget.hidden = true;
      if (on) {
        meterTimer = requestAnimationFrame(meterTick);
      } else {
        cancelAnimationFrame(meterTimer);
        meterBar.style.width = '0%';
      }
      sum.textContent = on ? 'on' : '';
      sum.classList.toggle('on', on);
    };

    // ---- recording your own take while monitoring, as a new track alongside the others ----
    let recordStart = 0;
    let recordTimer = 0;
    /** The tempo to restore once recording stops, if it had to be forced to 100% to start it. */
    let restoreTempo: number | null = null;
    /** True while a loop that was on has been suspended for the take (its wrap would jump the playhead). */
    let loopSuspended = false;
    const jumpButtons = ['toStartBtn', 'toEndBtn', 'loopBtn'].map((id) => $<HTMLButtonElement>(id));
    /** Puts a suspended loop back exactly as it was; the deck's own loop state was never touched. */
    const resumeLoop = () => {
      if (!loopSuspended) return;
      loopSuspended = false;
      this.player.setLoop(this.loop.on, this.loop.a, this.loop.b);
    };
    const recordUi = (on: boolean) => {
      for (const b of jumpButtons) b.disabled = on;
      pressed(recordBtn, on);
      recordBtn.textContent = on ? '■ Stop' : '● Record';
      recordTime.hidden = !on;
      if (on) {
        recordStart = performance.now();
        recordTime.textContent = '0:00';
        recordTimer = window.setInterval(() => (recordTime.textContent = fmtTime((performance.now() - recordStart) / 1000)), 500);
      } else {
        clearInterval(recordTimer);
      }
    };
    /** Stops an in-progress recording (if any) and turns it into a track. Used by the Record
     * button and by "Stop" on Monitor itself, so switching off monitoring never silently drops
     * a take that's in progress. */
    const finishRecording = async () => {
      if (!this.player.recording) return;
      recordUi(false);
      const take = await this.player.stopRecording();
      await this.finishRecordLane(take?.blob ?? null);
      resumeLoop();
      if (restoreTempo != null) {
        this.setTempoPitch(restoreTempo, this.pitch);
        restoreTempo = null;
      }
    };
    recordBtn.onclick = () => {
      if (this.player.recording) {
        void finishRecording();
        return;
      }
      // Which track this take goes into is decided now, before the lead-in, not after.
      const targetIdx = recordTarget.hidden || recordTarget.value === 'new' ? NaN : Number(recordTarget.value);
      const target = Number.isFinite(targetIdx) ? this.lanes[targetIdx] : undefined;
      void (async () => {
        recordBtn.disabled = true;
        try {
          // A recorded take is raw mic/instrument audio in real wall-clock time; it never goes
          // through the song's own time-stretcher. Placing it against the song's native timeline
          // only lines up if that timeline is advancing at 1x, so force 100% tempo for the
          // recording — restored afterwards — rather than let a slowed-down take quietly drift
          // out of sync with nothing to show for it until it's too late to redo.
          if (this.tempo !== 1) {
            restoreTempo = this.tempo;
            this.setTempoPitch(1, this.pitch);
            toast('Tempo reset to 100% for recording');
          }
          // Otherwise it's very easy to hit Record on a paused song (or a beat late on a
          // playing one) and get a take that's nowhere near in sync. Start playback first if
          // it isn't already, and give a short lead-in — a bar at the song's tempo if known,
          // else a fixed beat — before capture actually starts, so there's time to come in on
          // the beat instead of getting cut off mid-breath.
          if (this.loop.on) {
            loopSuspended = true;
            this.player.setLoop(false, this.loop.a, this.loop.b);
            toast('Loop paused while recording');
          }
          if (!this.player.state.playing) await this.player.play();
          const bpm = this.r?.analysis?.bpm;
          const leadInMs = bpm ? Math.max(800, Math.min(4000, (60 / bpm) * this.pr.perBar * 1000)) : 1500;
          status.textContent = 'Get ready…';
          await new Promise((res) => setTimeout(res, leadInMs));
          if (!this.player.monitoring) return; // monitoring stopped during the lead-in
          status.textContent = '';
          this.player.startRecording();
          this.beginRecordLane(target);
          refreshRecordTargets();
          recordUi(true);
        } catch (e) {
          toast(`Couldn't start recording: ${(e as Error).message}`, true);
        } finally {
          recordBtn.disabled = false;
          // Didn't end up recording after all (lead-in cancelled, or it failed to start): put
          // the tempo back rather than leave it stuck at 100% with nothing to show for it.
          if (!this.player.recording) resumeLoop();
          if (!this.player.recording && restoreTempo != null) {
            this.setTempoPitch(restoreTempo, this.pitch);
            restoreTempo = null;
          }
        }
      })();
    };

    this.stopLiveInputUi = () => {
      if (!this.player.monitoring) return;
      void finishRecording().then(() => {
        this.player.stopMonitor();
        setUi(false);
        status.textContent = '';
      });
    };

    btn.onclick = async () => {
      if (this.player.monitoring) {
        this.stopLiveInputUi();
        return;
      }
      btn.disabled = true;
      status.textContent = 'Starting…';
      try {
        await this.player.startMonitor(deviceSel.value || undefined, Number(vol.value), Number(pan.value));
        await refreshDevices();
        setUi(true);
        status.textContent = '';
      } catch (e) {
        status.textContent = "Couldn't start.";
        toast(`Live input: ${(e as Error).message}`, true);
      } finally {
        btn.disabled = false;
      }
    };
    deviceSel.onchange = () => {
      if (!this.player.monitoring) return;
      void this.player.startMonitor(deviceSel.value || undefined, Number(vol.value), Number(pan.value)).then(() => setUi(true));
    };
    vol.oninput = () => this.player.setMonitorGain(Number(vol.value));
    const setPan = (v: number) => {
      pan.value = String(v);
      panOut.textContent = v === 0 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`;
      this.player.setMonitorPan(v);
    };
    pan.oninput = () => setPan(Number(pan.value));
    pan.ondblclick = () => setPan(0);

    void refreshDevices();
  }

  // ---------- tuner: pitch detection against the live input or any track ----------
  private refreshTunerSources() {
    const sel = $<HTMLSelectElement>('tunerSource');
    const current = sel.value;
    const options: HTMLOptionElement[] = [];
    const hasMonitor = !!navigator.mediaDevices?.getUserMedia;
    if (hasMonitor) options.push(h('option', { value: 'monitor' }, 'Live input (Monitor)'));
    options.push(...this.lanes.map((l, i) => h('option', { value: String(i) }, laneLabel(l))));
    sel.replaceChildren(...options);
    if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  }

  private initTuner() {
    const pane = document.querySelector<HTMLElement>('[data-pane="tuner"]')!;
    const noteEl = $('tunerNote');
    const needle = $('tunerNeedle');
    const hz = $('tunerHz');
    const status = $('tunerStatus');
    const sel = $<HTMLSelectElement>('tunerSource');
    const N = 4096;

    const clear = () => {
      noteEl.textContent = '–';
      // A non-breaking space, not '': an empty line box is shorter than one with real text
      // (as tall as the font's natural line height), so losing the note between one note and
      // the next made this row's height flicker every tick while a track was playing.
      hz.textContent = ' ';
      needle.style.left = '50%';
      needle.classList.remove('in-tune');
    };

    const tick = () => {
      if (pane.hidden || !this.r) {
        setTimeout(tick, 200);
        return;
      }
      const src = sel.value;
      let result: ReturnType<typeof detectPitch> = null;
      let shift = 0;
      if (src === 'monitor') {
        const td = this.player.monitorTimeDomain();
        if (td) result = detectPitch(td.buf, td.sampleRate);
        status.textContent = td ? '' : 'Start Live input monitoring first';
      } else {
        const lane = this.lanes[Number(src)];
        if (lane) {
          const data = lane.data;
          const len = data[0].length;
          const start = Math.max(0, Math.min(Math.max(0, len - N), Math.round(this.player.state.pos)));
          const end = Math.min(len, start + N);
          const mono = new Float32Array(end - start);
          for (let i = 0; i < mono.length; i++) mono[i] = (data[0][start + i] + data[1][start + i]) / 2;
          result = detectPitch(mono, SR);
          shift = this.pitch;
        }
        status.textContent = '';
      }
      if (result) {
        const { note, cents } = freqToNote(result.freq);
        noteEl.textContent = noteName(note + shift);
        hz.textContent = `${result.freq.toFixed(1)} Hz`;
        needle.style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
        needle.classList.toggle('in-tune', Math.abs(cents) <= 5);
        if (!status.textContent) status.textContent = Math.abs(cents) <= 5 ? 'In tune' : cents < 0 ? 'Flat' : 'Sharp';
      } else {
        clear();
        if (!status.textContent) status.textContent = 'Play a single note';
      }
      setTimeout(tick, 90);
    };
    tick();

    this.refreshTunerSources();
  }

  // ---------- scratchpad: plain-text lyrics, tab, drum tab and notes, per song ----------
  private initScratchpad() {
    const tabBtns = {
      lyrics: $<HTMLButtonElement>('scratchTabLyrics'),
      tab: $<HTMLButtonElement>('scratchTabTab'),
      drums: $<HTMLButtonElement>('scratchTabDrums'),
      notes: $<HTMLButtonElement>('scratchTabNotes'),
    };
    const areas = {
      lyrics: $<HTMLTextAreaElement>('scratchLyrics'),
      tab: $<HTMLTextAreaElement>('scratchTab'),
      drums: $<HTMLTextAreaElement>('scratchDrums'),
      notes: $<HTMLTextAreaElement>('scratchNotes'),
    };
    this.scratchAreas = areas;
    const show = (name: keyof typeof areas) => {
      for (const k of Object.keys(areas) as (keyof typeof areas)[]) {
        pressed(tabBtns[k], k === name);
        areas[k].hidden = k !== name;
      }
      // Clicking the tab button leaves focus on the button itself, not the text box it reveals,
      // so typing right after switching tabs (the natural next move) hit the deck's own keyboard
      // shortcuts instead of the text — a "0"/"-" for tab notation would zoom out, "1"-"6" would
      // mute a track, etc. Move focus into the box so typing lands there immediately. A no-op if
      // the pane isn't actually visible yet (e.g. this initial call, before a song is open).
      areas[name].focus();
    };
    for (const k of Object.keys(tabBtns) as (keyof typeof tabBtns)[]) tabBtns[k].onclick = () => show(k);
    show('lyrics');

    // "Extend line": add more bars to every string/beat line at once, staying lined up, instead
    // of hand-typing dashes onto each one separately. Works on whichever of Tab/Drum tab is open.
    const extend = (ta: HTMLTextAreaElement) => {
      const pos = ta.selectionStart;
      ta.value = extendTabText(ta.value, ta.placeholder);
      ta.setSelectionRange(pos, pos);
      ta.dispatchEvent(new Event('input'));
      ta.focus();
    };
    $('tabExtendBtn').onclick = () => extend(areas.tab.hidden ? areas.drums : areas.tab);
    for (const ta of [areas.tab, areas.drums])
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          extend(ta);
        }
      });

    areas.lyrics.oninput = () => {
      this.scratch.lyrics = areas.lyrics.value;
      this.updateScratchSummary();
      this.emit();
    };
    areas.tab.oninput = () => {
      this.scratch.tab = areas.tab.value;
      this.updateScratchSummary();
      this.emit();
    };
    areas.drums.oninput = () => {
      this.scratch.drums = areas.drums.value;
      this.updateScratchSummary();
      this.emit();
    };
    areas.notes.oninput = () => {
      this.scratch.notes = areas.notes.value;
      this.updateScratchSummary();
      this.emit();
    };
  }

  private applyScratch(s?: ScratchState) {
    this.scratch = { lyrics: s?.lyrics ?? '', tab: s?.tab ?? '', drums: s?.drums ?? '', notes: s?.notes ?? '' };
    this.scratchAreas.lyrics.value = this.scratch.lyrics ?? '';
    // Tab/Drum tab start with the blank string/beat template actually typed in (not just a
    // placeholder hint), so there's something to type fret numbers or hits onto directly. Only
    // for a song that has nothing saved yet; this.scratch itself stays empty until they edit it,
    // so an untouched template is never mistaken for real content or saved as one.
    this.scratchAreas.tab.value = this.scratch.tab || this.scratchAreas.tab.placeholder;
    this.scratchAreas.drums.value = this.scratch.drums || this.scratchAreas.drums.placeholder;
    this.scratchAreas.notes.value = this.scratch.notes ?? '';
    this.updateScratchSummary();
  }

  private updateScratchSummary() {
    const bits = [
      this.scratch.lyrics ? 'Lyrics' : '',
      this.scratch.tab ? 'Tab' : '',
      this.scratch.drums ? 'Drum tab' : '',
      this.scratch.notes ? 'Notes' : '',
    ].filter(Boolean);
    const sum = $('sumScratch');
    sum.textContent = bits.join(' · ');
    sum.classList.toggle('on', bits.length > 0);
  }

  /** Points the Scratchpad's "Search lyrics" link at this song's title; never fetched or stored here, just a jump-off search. */
  private updateLyricsLink() {
    const title = this.r?.title ?? '';
    ($('lyricsSearchLink') as HTMLAnchorElement).href = `https://genius.com/search?q=${encodeURIComponent(title)}`;
  }

  // ---------- collapsible "Practice" / "Tempo & key" drawer ----------
  private initDrawer() {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.dtab')];
    const open = (name: string | null) => {
      for (const t of tabs) t.setAttribute('aria-expanded', String(t.dataset.tab === name));
      for (const p of document.querySelectorAll<HTMLElement>('.dpane')) p.hidden = p.dataset.pane !== name;
      try {
        localStorage.setItem('steminize.drawer', name ?? '');
      } catch {
        /* ignore */
      }
    };
    for (const t of tabs) t.onclick = () => open(t.getAttribute('aria-expanded') === 'true' ? null : t.dataset.tab!);
    let saved = '';
    try {
      saved = localStorage.getItem('steminize.drawer') ?? '';
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
    this.stopLiveInputUi();
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
    this.dirty = true;
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

  private selectLane(lane: Lane) {
    if (this.selectedLane === lane) return;
    this.selectedLane = lane;
    for (const l of this.lanes) l.el.classList.toggle('selected', l === lane);
  }

  /** Renames a track for display/export only; chords, MIDI etc. still key off its real stem name. */
  private renameLane(lane: Lane, nameBtn: HTMLButtonElement, dl: HTMLButtonElement) {
    const input = h('input', { type: 'text', value: laneLabel(lane), maxLength: 40, class: 'name-edit', 'aria-label': 'Track name' } as any);
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save) lane.label = input.value.trim() || undefined;
      const badgeText = nameBtn.querySelector('.take-badge')?.textContent ?? '';
      nameBtn.replaceChildren(laneLabel(lane), h('span', { class: 'take-badge muted' }, badgeText));
      dl.title = `Save ${laneLabel(lane)}`;
      input.replaceWith(nameBtn);
      if (save) {
        this.refreshTunerSources();
        if (lane.recordGroup) this.refreshRecordTargetsUi();
        this.emit();
      }
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
    nameBtn.replaceWith(input);
    input.focus();
    input.select();
  }

  private renameSong() {
    if (!this.r) return;
    const heading = $('trackTitle');
    const input = h('input', { type: 'text', value: this.r.title, maxLength: 120, class: 'title-edit', 'aria-label': 'Song title' } as any);
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (save && val && this.r) {
        this.r.title = val;
        this.onRename(val);
      }
      heading.textContent = this.r?.title ?? '';
      input.replaceWith(heading);
      this.updateLyricsLink();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
    heading.replaceWith(input);
    input.focus();
    input.select();
  }

  private setTempoPitch(tempo: number, pitch: number, save = true) {
    this.tempo = tempo;
    this.pitch = pitch;
    this.showTempoPitch();
    this.player.setTempoPitch(tempo, pitch);
    this.dirty = true;
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
  private clampView(start: number, end: number) {
    const len = this.length || 1;
    const span = Math.min(len, Math.max(SR, end - start));
    start = Math.max(0, Math.min(len - span, start));
    return { start, end: start + span };
  }

  private setView(start: number, end: number) {
    this.view = this.clampView(start, end);
    const len = this.length || 1;
    const span = this.view.end - this.view.start;
    const zoomed = span < len - 1;
    const scroll = $<HTMLInputElement>('viewScroll');
    scroll.hidden = !zoomed;
    if (zoomed) scroll.value = String(Math.round((1000 * this.view.start) / Math.max(1, len - span)));
    this.invalidateLayers();
  }

  /** A track's own zoom, independent of the shared view and every other track's. */
  private setLaneView(lane: Lane, start: number, end: number) {
    lane.ownView = this.clampView(start, end);
    lane.layers = undefined;
    this.dirty = true;
  }

  /** Resets the shared view and every track's own zoom back to the whole song. */
  private zoomFit() {
    this.setView(0, this.length);
    for (const l of this.lanes) {
      l.ownView = undefined;
      l.layers = undefined;
    }
    this.dirty = true;
  }

  private zoom(factor: number, centre = this.player.state.pos, lane?: Lane) {
    const view = lane ? (lane.ownView ?? this.view) : this.view;
    const span = view.end - view.start;
    const next = span / factor;
    const rel = span ? (centre - view.start) / span : 0.5;
    const start = centre - rel * next;
    if (lane) this.setLaneView(lane, start, start + next);
    else this.setView(start, start + next);
  }

  private onWheel(e: WheelEvent, el: HTMLElement, lane?: Lane) {
    if (!this.r) return;
    e.preventDefault();
    const view = lane ? (lane.ownView ?? this.view) : this.view;
    const span = view.end - view.start;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = e.shiftKey ? e.deltaY : e.deltaX;
      const start = view.start + (d / el.clientWidth) * span;
      const end = view.end + (d / el.clientWidth) * span;
      if (lane) this.setLaneView(lane, start, end);
      else this.setView(start, end);
    } else {
      const f = Math.max(0, Math.min(1, e.offsetX / el.clientWidth));
      this.zoom(Math.exp(-e.deltaY * 0.002), view.start + f * span, lane);
    }
  }

  // ---------- markers & pedal ----------
  private initMarkersAndZoom() {
    $('zoomIn').onclick = () => this.zoom(2);
    $('zoomOut').onclick = () => this.zoom(0.5);
    $('zoomFit').onclick = () => this.zoomFit();
    $<HTMLInputElement>('viewScroll').oninput = (e) => {
      const span = this.view.end - this.view.start;
      const start = (Number((e.target as HTMLInputElement).value) / 1000) * (this.length - span);
      this.setView(start, start + span);
    };
    $('overviewWrap').addEventListener('wheel', (e) => this.onWheel(e, $('overviewWrap')), { passive: false });
    $('addMarker').onclick = () => this.addMarker();
    const pedalBtn = $('pedalBtn');
    try {
      this.pedal = localStorage.getItem('steminize.pedal') === '1';
    } catch {
      /* ignore */
    }
    pressed(pedalBtn, this.pedal);
    pedalBtn.onclick = () => {
      this.pedal = !this.pedal;
      pressed(pedalBtn, this.pedal);
      try {
        localStorage.setItem('steminize.pedal', this.pedal ? '1' : '0');
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

  /** Skip forward (positive) or back (negative) `sec` seconds, clamped to the song. */
  private skip(sec: number) {
    const pos = this.player.state.pos;
    this.player.seek(sec < 0 ? pos + sec * SR : Math.min(this.length - SR, pos + sec * SR));
  }

  /** Floor for a track's waveform height: taller while per-track Pan sliders add a row to its control panel. */
  private laneMinH(): number {
    return $('lanes').classList.contains('show-pan') ? PAN_MIN_H : LANE_MIN_H;
  }

  /** Grow (positive) or shrink (negative) every track's waveform by `px`, together. */
  private resizeLanes(px: number) {
    for (const l of this.lanes) {
      const wave = l.el.querySelector('.wave') as HTMLElement;
      l.height = Math.max(this.laneMinH(), Math.min(500, (l.height ?? wave.clientHeight) + px));
      wave.style.height = `${l.height}px`;
    }
    this.dirty = true;
    this.emit();
  }

  private setLoop(on: boolean) {
    if (on && this.player.recording) return this.notifySeekBlocked();
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

  /** Which loop edge (if any) sits under x, so grabbing it resizes the section instead of drawing a new one. */
  private loopEdgeAt(px: number, width: number, view: { start: number; end: number }): 'a' | 'b' | null {
    if (!(this.loop.b > this.loop.a) || width <= 0) return null;
    const span = view.end - view.start || 1;
    const da = Math.abs(px - ((this.loop.a - view.start) / span) * width);
    const db = Math.abs(px - ((this.loop.b - view.start) / span) * width);
    if (da > 7 && db > 7) return null;
    return da <= db ? 'a' : 'b';
  }

  /** Moves one loop edge, never closer to the other than a quarter second. */
  private dragLoopEdge(edge: 'a' | 'b', frame: number) {
    const gap = Math.round(SR / 4);
    if (edge === 'a') this.loop.a = Math.round(Math.max(0, Math.min(frame, this.loop.b - gap)));
    else this.loop.b = Math.round(Math.min(this.length, Math.max(frame, this.loop.a + gap)));
    this.dirty = true;
  }

  private finishLoopEdgeDrag() {
    this.snapLoop();
    // While recording, a loop that is on has been suspended; the player is told again when the take ends.
    if (this.loop.on && !this.player.recording) this.player.setLoop(true, this.loop.a, this.loop.b);
    this.updateLoopUi();
    this.emit();
  }

  /** Removes the A/B section entirely (the Loop button only switches it off and leaves the region). */
  private clearLoop() {
    this.loop.a = 0;
    this.loop.b = 0;
    this.setLoop(false); // also stops the practice trainer, tells the player, and refreshes the UI
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
    $('clearLoop').hidden = !(this.loop.b > this.loop.a);
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
      if ((e.target as HTMLElement).closest('button')) return; // let the zoom overlay's buttons handle their own clicks
      wrap.setPointerCapture(e.pointerId);
      const edge = this.loopEdgeAt(frac(e) * wrap.clientWidth, wrap.clientWidth, this.view);
      this.drag = { x0: frac(e), moved: false, edge: edge ?? undefined };
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!this.drag) {
        wrap.style.cursor = this.loopEdgeAt(frac(e) * wrap.clientWidth, wrap.clientWidth, this.view) ? 'ew-resize' : '';
        return;
      }
      const f = frac(e);
      if (this.drag.edge) {
        if (Math.abs(f - this.drag.x0) * wrap.clientWidth > 3) this.drag.moved = true;
        if (this.drag.moved) this.dragLoopEdge(this.drag.edge, this.frameAt(f));
        return;
      }
      if (Math.abs(f - this.drag.x0) * wrap.clientWidth > 6) this.drag.moved = true;
      if (this.drag.moved) {
        const [a, b] = [this.drag.x0, f].sort((x, y) => x - y);
        this.loop.a = Math.round(this.frameAt(a));
        this.loop.b = Math.round(this.frameAt(b));
        this.dirty = true;
        // Scrub: preview audio at the pointer as you drag, same as scanning a tape (only audible while already playing).
        this.player.seek(this.frameAt(f));
      }
    });
    wrap.addEventListener('pointerup', (e) => {
      if (!this.drag) return;
      if (this.drag.edge && this.drag.moved) this.finishLoopEdgeDrag();
      else if (this.drag.moved) {
        // Mark the section but leave the loop off and playback where scrubbing left it:
        // dragging is also how you scan the song to find a part, and forcing the loop on
        // (jumping back to its start) would undo that. Press Loop to actually use the section.
        this.snapLoop();
        this.updateLoopUi();
        this.emit();
      } else this.seekFrac(frac(e));
      this.drag = null;
    });
  }

  private initKeys() {
    window.addEventListener('keydown', (e) => {
      if (
        !this.r ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target as HTMLElement)?.isContentEditable ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      const k = e.key;
      if (e.code === 'Space' || k === 'PageDown' || k === 'MediaPlayPause' || (this.pedal && ['ArrowRight', 'ArrowDown', 'Enter'].includes(k))) this.toggle();
      else if (k === 'PageUp' || k === 'Home' || (this.pedal && ['ArrowLeft', 'ArrowUp'].includes(k))) this.restart();
      else if (k === 'm' || k === 'M') this.addMarker();
      else if (e.shiftKey && (k === '+' || k === '=')) this.resizeLanes(20);
      else if (e.shiftKey && (k === '-' || k === '_')) this.resizeLanes(-20);
      else if (k === '+' || k === '=') this.zoom(2);
      else if (k === '-' || k === '_') this.zoom(0.5);
      else if (k === '0') this.zoomFit();
      else if (e.key === 'ArrowLeft') this.skip(-5);
      else if (e.key === 'ArrowRight') this.skip(5);
      else if (e.key === 'l' || e.key === 'L') this.setLoop(!this.loop.on);
      else if (e.key === 'f' || e.key === 'F') this.tx.toggleFreeze();
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

  private drawStrip(canvas: HTMLCanvasElement, layers: [HTMLCanvasElement, HTMLCanvasElement], pos: number, showLoop: boolean, view = this.view) {
    const g = fitCanvas(canvas);
    const { width: w, height: hh } = canvas;
    g.clearRect(0, 0, w, hh);
    const x = (f: number) => ((f - view.start) / (view.end - view.start)) * w;
    const px = Math.max(-2, Math.min(w + 2, x(pos)));
    if (showLoop && this.loop.b > this.loop.a) {
      const xa = x(this.loop.a);
      const xb = x(this.loop.b);
      g.save();
      g.fillStyle = getComputedStyle(document.body).getPropertyValue('--loop').trim() || '#22d3ee';
      g.globalAlpha = this.loop.on ? 0.3 : 0.2;
      g.fillRect(xa, 0, xb - xa, hh);
      // Edge lines mark exactly where A and B are, so a marked-but-off section is still obvious.
      const edge = Math.max(2, Math.round(devicePixelRatio * 2));
      g.globalAlpha = this.loop.on ? 1 : 0.75;
      g.fillRect(Math.round(xa), 0, edge, hh);
      g.fillRect(Math.round(xb) - edge, 0, edge, hh);
      g.restore();
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
      const view = l.ownView ?? this.view;
      if (!l.layers || l.layers[0].width !== l.canvas.width || l.layers[0].height !== l.canvas.height) {
        const c = l.colour;
        const p = peaksForView(l.peaks, l.data, view.start, view.end, buckets(l.canvas.width));
        l.layers = [waveLayer(p, l.canvas.width, l.canvas.height, c + '66', this.laneScale), waveLayer(p, l.canvas.width, l.canvas.height, c, this.laneScale)];
      }
      this.drawStrip(l.canvas, l.layers, pos, true, view);
    }
    this.tx.draw(pos);
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
    const lane = this.lanes[i];
    const o = this.settings();
    const t = toast(`Encoding ${laneLabel(lane)}…`);
    try {
      await this.encoder.run({ type: 'stems', stems: [{ name: safeName(laneLabel(lane)), data: lane.data }], out: o }, async (name, bytes) => {
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
    // Track names become file names, so keep them unique even if two tracks share a rename.
    const seen = new Map<string, number>();
    const stems = this.lanes.map((l) => {
      let name = safeName(laneLabel(l));
      const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
      seen.set(name.toLowerCase(), n);
      if (n > 1) name = `${name} (${n})`;
      return { name, data: l.data };
    });
    try {
      await this.encoder.run({ type: 'stems', stems, out: o }, async (name, bytes) => {
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
