// Transcription tools above the stem lanes:
//  - Notes: which notes are sounding over time (one row per semitone), with a
//    keyboard to hear any pitch, "freeze" to hold the sound at the playhead,
//    and audio-to-MIDI (Basic Pitch) drawn on top and exportable.
//  - Chords: a detected, editable chord lane and a printable chord chart.
// Everything is shown as you hear it: a pitch shift moves notes and chords too.

import { background } from '../encode/client.ts';
import { BINS, CQT_FPS, NOTE_HI, NOTE_LO, noteName, type Cqt } from '../analysis/cqt.ts';
import { beatCells, beatPositionAt, displayName, type BeatCell } from '../analysis/chordStrip.ts';
import { QUALITIES, chordName, chordSheet, detectChords, mergeSame, noteLetter, prefersSharps, type Chord, type Quality } from '../analysis/chords.ts';
import { cancelTranscribe, transcribe } from '../analysis/transcribe.ts';
import { singleLine, type NoteEvent } from '../analysis/basicPitch.ts';
import { monoOf } from '../analysis/resample.ts';
import { programFor, writeMidi } from '../encode/midi.ts';
import { renderMix } from '../player/mixcore.ts';
import type { Player, Voice } from '../player/player.ts';
import type { EqParams } from '../player/eq.ts';
import type { KeyResult } from '../analysis/key.ts';
import { saveFile } from '../platform.ts';
import { $, fitCanvas, fmtTime, h, pressed, toast } from './dom.ts';

const SR = 44100;
const HEAR = '*'; // source id for "what you hear"

/** What the deck lends the transcription tools. */
export interface TxHost {
  player: Player;
  song(): TxSong | null;
  view(): { start: number; end: number };
  gains(): number[];
  pans(): number[];
  eqs(): (EqParams | undefined)[];
  lanes(): { name: string; colour: string }[];
  pitch(): number;
  loop(): { on: boolean; a: number; b: number };
  markers(): { name: string; pos: number }[];
  beats(): number[]; // seconds
  downbeat(): number; // index into beats
  perBar(): number;
  bpm(): number | undefined;
  key(): KeyResult | undefined;
  keyLabel(): string | undefined;
  seekFrac(f: number): void;
  /** The playhead, smoothed between the player's reports, for motion that must look continuous. */
  smoothPos(): number;
  /** Loops the frames [a, b) and starts playing from the start of them. */
  loopFrames(a: number, b: number): void;
  wheel(e: WheelEvent, el: HTMLElement): void;
  changed(): void; // save
  redraw(): void;
  baseName(): string;
}

/** The parts of a song the tools use, plus what they add to it. */
export interface TxSong {
  title: string;
  stems: { name: string; data: Float32Array[] }[];
  chords?: Chord[];
  midi?: Record<string, NoteEvent[]>;
  /** Note energy per stem, kept in memory only (quick to recompute). */
  cqt?: Map<string, { c: Cqt; peak: number }>;
}

export interface TxState {
  notes: boolean;
  chords: boolean;
  source: string;
  chordList?: Chord[];
  midi?: Record<string, NoteEvent[]>;
  notesHeight?: number; // px; unset uses the CSS default
  /** The scrolling chord timeline: shown, plain major / minor only, and its zoom (1 = default width of a beat). */
  strip?: boolean;
  simple?: boolean;
  stripZoom?: number;
}

// Heat-map palette for the note view: dark → violet → orange → yellow.
const LUT = (() => {
  const stops: [number, number, number, number][] = [
    [0, 15, 15, 23],
    [0.3, 60, 30, 110],
    [0.55, 150, 50, 150],
    [0.75, 240, 110, 60],
    [1, 255, 235, 140],
  ];
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, ...a] = stops[k];
    const [t1, ...b] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = a[c] + (b[c] - a[c]) * f;
  }
  return out;
})();

const isBlack = (n: number) => [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);

// Computer keyboard as a piano, while the Notes view is open: the bottom row is white keys,
// the row above is black keys, offset to sit over the gaps between them (as on a real piano).
const PIANO_BASE = 60; // C4
const PIANO_KEYS: Record<string, number> = {
  z: 0, x: 2, c: 4, v: 5, b: 7, n: 9, m: 11, ',': 12, '.': 14, '/': 16,
  s: 1, d: 3, g: 6, h: 8, j: 10, l: 13, ';': 15,
};

/** Rough role of a track from its name, for choosing what chord detection listens to. */
function role(name: string): 'drums' | 'vocals' | 'bass' | 'harm' {
  const n = name.toLowerCase();
  if (n.startsWith('no_')) return 'harm';
  if (/drum|kick|snare|hat|perc|cymbal|overhead|\btom/.test(n)) return 'drums';
  if (/vox|vocal|voice|sing|\bbv/.test(n)) return 'vocals';
  if (/bass/.test(n)) return 'bass';
  return 'harm';
}

/** Which preview-tone timbre suits the currently selected part, so it's closer to what you're matching by ear. */
function voiceFor(name: string): Voice {
  if (name === HEAR) return 'default';
  const n = name.toLowerCase();
  if (/bass/.test(n)) return 'bass';
  if (/guitar/.test(n)) return 'guitar';
  if (/vox|vocal|voice|sing|\bbv/.test(n)) return 'vocal';
  return 'default';
}

export class Transcribe {
  private notesOn = false;
  private chordsOn = false;
  // The scrolling chord timeline (a row of beat boxes that moves with the music).
  private stripLane: HTMLElement;
  private simpleBox: HTMLInputElement;
  private stripCanvas: HTMLCanvasElement;
  private stripOn = false;
  private simple = false;
  private stripZoom = 1;
  private cells: { chords: Chord[]; beats: number[]; downbeat: number; perBar: number; list: BeatCell[] } | null = null;
  /** Where the timeline last drew the playhead, so a click can be turned back into a beat. */
  private stripGeom = { cur: 0, hold: 0, cw: 78 };
  private source = HEAR;
  private img: { key: string; canvas: HTMLCanvasElement } | null = null;
  private hover: { row: number; t: number } | null = null;
  /** Visible pitch range, as rows (0 = NOTE_HI at the top, BINS = one past NOTE_LO). Scroll/zoom the piano to change it. */
  private pitchView = { top: 0, bottom: BINS };
  private keyHover: number | null = null;
  private heldRows = new Set<number>();
  private notesHeight?: number; // px; unset uses the CSS default
  private frozenAt = -1;
  private busy = '';
  private editing = -1;
  private editAt = 0;

  // DOM
  private chordLane: HTMLElement;
  private chordCanvas: HTMLCanvasElement;
  private chordNow: HTMLElement;
  private chordStatus: HTMLElement;
  private editor: HTMLElement;
  private notesLane: HTMLElement;
  private noteCanvas: HTMLCanvasElement;
  private keys: HTMLCanvasElement;
  private sourceSel: HTMLSelectElement;
  private noteStatus: HTMLElement;
  private freezeBtn: HTMLButtonElement;
  private midiBtn: HTMLButtonElement;
  private midiClearBtn: HTMLButtonElement;
  private midiSaveBtn: HTMLButtonElement;

  constructor(private host: TxHost) {
    // ---- chord timeline lane
    this.stripCanvas = h('canvas');
    const simpleBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
    simpleBox.onchange = () => {
      this.simple = simpleBox.checked;
      this.host.changed();
    };
    this.simpleBox = simpleBox;
    const zoomOut = h('button', { class: 'btn tiny ghost', type: 'button', title: 'Show fewer beats' }, '−');
    const zoomIn = h('button', { class: 'btn tiny ghost', type: 'button', title: 'Show more of each beat' }, '+');
    zoomOut.onclick = () => this.setStripZoom(this.stripZoom / 1.25);
    zoomIn.onclick = () => this.setStripZoom(this.stripZoom * 1.25);
    const stripWave = h('div', { class: 'wave x-wave chord-strip-wave', title: 'Click a beat to jump to it; click a bar number to loop that bar' }, this.stripCanvas);
    stripWave.onclick = (e) => this.stripClick(e.offsetX, e.offsetY);
    this.stripLane = h(
      'div',
      { class: 'lane x-lane chord-strip-lane' },
      h(
        'div',
        { class: 'lane-ctl x-ctl' },
        h('span', { class: 'name' }, 'Chord timeline'),
        h('label', { class: 'switch', title: 'Plain major and minor chords only: no sevenths, sus or slash chords' }, simpleBox, ' Simple'),
        zoomOut,
        zoomIn,
      ),
      stripWave,
    );

    // ---- chords lane
    this.chordCanvas = h('canvas');
    this.chordNow = h('span', { class: 'x-now' });
    this.chordStatus = h('span', { class: 'muted small x-status' });
    const redo = h('button', { class: 'btn tiny ghost', type: 'button', title: 'Detect the chords again (replaces your edits)' }, 'Redo');
    const sheet = h(
      'button',
      { class: 'btn tiny ghost', type: 'button', title: 'Save a chord chart (text), in bars, with your markers as sections' },
      'Chart ⤓',
    );
    redo.onclick = () => {
      const s = this.host.song();
      if (s?.chords?.some((c) => c.manual) && !confirm('Detect the chords again? Your corrections will be lost.')) return;
      void this.detectChords();
    };
    sheet.onclick = () => this.saveChart();
    const chordWave = h('div', { class: 'wave x-wave' }, this.chordCanvas);
    this.chordLane = h(
      'div',
      { class: 'lane x-lane chord-lane' },
      h('div', { class: 'lane-ctl x-ctl' }, h('span', { class: 'name' }, 'Chords'), this.chordNow, redo, sheet, this.chordStatus),
      chordWave,
    );
    this.editor = h('div', { class: 'chord-edit', hidden: true });
    chordWave.onclick = (e) => this.chordClick(e.offsetX / chordWave.clientWidth);
    chordWave.addEventListener('wheel', (e) => this.host.wheel(e, chordWave), { passive: false });

    // ---- notes lane
    this.noteCanvas = h('canvas');
    this.keys = h('canvas', {
      title: "Click a key to hear it, in a tone roughly matching the part you're viewing. Scroll to zoom, Shift+scroll to pan, double-click to reset.",
    });
    this.sourceSel = h('select', { title: 'Which part to show' });
    this.sourceSel.onchange = () => {
      this.source = this.sourceSel.value;
      this.refreshMidiButtons();
      void this.ensureCqt(this.sourceNames());
      this.invalidate();
      this.host.changed();
    };
    this.freezeBtn = h(
      'button',
      { class: 'btn tiny ghost toggle', type: 'button', title: 'Hold the sound at the playhead so you can find the note (F)' },
      'Freeze',
    );
    this.freezeBtn.onclick = () => this.toggleFreeze();
    pressed(this.freezeBtn, false);
    this.midiBtn = h('button', { class: 'btn tiny ghost', type: 'button', title: 'Work out the notes of this part as MIDI (Basic Pitch)' }, 'To MIDI');
    this.midiBtn.onclick = () => void this.toMidi();
    this.midiClearBtn = h('button', { class: 'btn tiny ghost', type: 'button', title: 'Remove the MIDI notes for this part', hidden: true }, '×');
    this.midiClearBtn.onclick = () => this.clearMidi();
    this.midiSaveBtn = h('button', { class: 'btn tiny ghost', type: 'button', title: 'Save the MIDI (every part you have transcribed)' }, 'MIDI ⤓');
    this.midiSaveBtn.onclick = () => this.saveMidi();
    this.noteStatus = h('span', { class: 'muted small x-status' });
    const noteWave = h('div', { class: 'wave x-wave notes-wave' }, this.noteCanvas);
    const notesResize = h('div', { class: 'lane-resize', title: 'Drag to resize the notes view. Double-click to reset.' });
    this.notesLane = h(
      'div',
      { class: 'lane x-lane notes-lane' },
      h(
        'div',
        { class: 'lane-ctl x-ctl notes-ctl' },
        h(
          'div',
          { class: 'x-col' },
          h('span', { class: 'name' }, 'Notes'),
          this.sourceSel,
          h('div', { class: 'x-row' }, this.freezeBtn, this.midiBtn, this.midiClearBtn, this.midiSaveBtn),
          this.noteStatus,
        ),
        h('div', { class: 'x-keys' }, this.keys),
      ),
      noteWave,
      notesResize,
    );
    noteWave.onclick = (e) => this.host.seekFrac(e.offsetX / noteWave.clientWidth);
    noteWave.addEventListener('wheel', (e) => this.host.wheel(e, noteWave), { passive: false });
    let notesDragFromH: number | null = null;
    notesResize.addEventListener('pointerdown', (e) => {
      notesResize.setPointerCapture(e.pointerId);
      notesDragFromH = noteWave.clientHeight - e.clientY;
    });
    notesResize.addEventListener('pointermove', (e) => {
      if (notesDragFromH == null) return;
      // Floor matches the CSS default (360px): below that the keyboard and note rows become
      // too small to read, which is the exact problem the default height was set to fix.
      noteWave.style.height = `${Math.max(360, Math.min(800, notesDragFromH + e.clientY))}px`;
      this.redraw();
    });
    notesResize.addEventListener('pointerup', () => {
      if (notesDragFromH == null) return;
      notesDragFromH = null;
      this.notesHeight = noteWave.clientHeight;
      this.host.changed();
    });
    notesResize.ondblclick = () => {
      noteWave.style.height = '';
      this.notesHeight = undefined;
      this.redraw();
      this.host.changed();
    };
    noteWave.onpointermove = (e) => {
      const { top, bottom } = this.pitchView;
      const row = top + Math.floor((e.offsetY / noteWave.clientHeight) * (bottom - top));
      const v = this.host.view();
      this.hover = { row, t: (v.start + (e.offsetX / noteWave.clientWidth) * (v.end - v.start)) / SR };
      this.redraw();
    };
    noteWave.onpointerleave = () => {
      this.hover = null;
      this.redraw();
    };
    const keyRowAt = (e: MouseEvent) => {
      const { top, bottom } = this.pitchView;
      return Math.max(0, Math.min(BINS - 1, top + Math.floor((e.offsetY / this.keys.clientHeight) * (bottom - top))));
    };
    this.keys.onclick = (e) => void this.host.player.tone(NOTE_HI - keyRowAt(e), voiceFor(this.source));
    this.keys.onpointermove = (e) => {
      this.keyHover = keyRowAt(e);
      this.redraw();
    };
    this.keys.onpointerleave = () => {
      this.keyHover = null;
      this.redraw();
    };
    this.keys.ondblclick = () => {
      this.pitchView = { top: 0, bottom: BINS };
      this.redraw();
    };
    this.keys.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { top, bottom } = this.pitchView;
        const span = bottom - top;
        if (e.shiftKey) {
          const d = (e.deltaY / this.keys.clientHeight) * span;
          this.pitchView = this.clampPitchView(top + d, bottom + d);
        } else {
          const f = Math.max(0, Math.min(1, e.offsetY / this.keys.clientHeight));
          const centre = top + f * span;
          const nextSpan = span / Math.exp(-e.deltaY * 0.002);
          const t = centre - f * nextSpan;
          this.pitchView = this.clampPitchView(t, t + nextSpan);
        }
        this.redraw();
      },
      { passive: false },
    );
    // Computer keyboard as a piano while the Notes view is showing. Capture phase + stopPropagation
    // so mapped keys (some overlap the deck's own shortcuts, e.g. L, M) play a note instead here.
    const pianoKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return null;
      if (e.metaKey || e.ctrlKey || e.altKey) return null;
      const offset = PIANO_KEYS[e.key.toLowerCase()];
      return offset == null ? null : PIANO_BASE + offset;
    };
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.notesOn || e.repeat) return;
        const note = pianoKey(e);
        if (note == null) return;
        e.preventDefault();
        e.stopPropagation();
        const row = NOTE_HI - note;
        if (row >= 0 && row < BINS) {
          this.heldRows.add(row);
          this.redraw();
        }
        void this.host.player.tone(note, voiceFor(this.source));
      },
      { capture: true },
    );
    window.addEventListener(
      'keyup',
      (e) => {
        const note = pianoKey(e);
        if (note == null) return;
        if (this.heldRows.delete(NOTE_HI - note)) this.redraw();
      },
      { capture: true },
    );

    $('xlanes').append(this.stripLane, this.chordLane, this.editor, this.notesLane);
    $('stripBtn').onclick = () => this.show({ strip: !this.stripOn });
    $('chordsBtn').onclick = () => this.show({ chords: !this.chordsOn });
    $('notesBtn').onclick = () => this.show({ notes: !this.notesOn });
    this.show({});
  }

  private redraw() {
    this.host.redraw();
  }

  /** Clamps a pitch view (in rows) to the real range and a sensible minimum zoom. */
  private clampPitchView(top: number, bottom: number) {
    // Whole rows only: a fractional top/bottom would make every row lookup (hover, clicks,
    // the keyboard mapping) land on a non-integer index, and noteName() would read undefined.
    const span = Math.min(BINS, Math.max(4, Math.round(bottom - top)));
    top = Math.max(0, Math.min(BINS - span, Math.round(top)));
    return { top, bottom: top + span };
  }

  // ---------- song / state ----------
  open(s: TxSong, st?: TxState) {
    this.pitchView = { top: 0, bottom: BINS };
    this.heldRows.clear();
    this.unfreeze();
    cancelTranscribe();
    this.busy = '';
    this.closeEditor();
    if (st?.chordList && !s.chords) s.chords = st.chordList;
    if (st?.midi && !s.midi) s.midi = st.midi;
    this.source = st?.source && (st.source === HEAR || s.stems.some((x) => x.name === st.source)) ? st.source : HEAR;
    this.sourceSel.replaceChildren(
      h('option', { value: HEAR }, 'All parts (no drums)'),
      ...s.stems.map((x) => h('option', { value: x.name }, x.name.startsWith('no_') ? `No ${x.name.slice(3)}` : x.name)),
    );
    this.sourceSel.value = this.source;
    this.simple = st?.simple ?? false;
    this.simpleBox.checked = this.simple;
    this.stripZoom = Math.max(0.5, Math.min(2.5, st?.stripZoom ?? 1));
    this.show({ notes: st?.notes ?? this.notesOn, chords: st?.chords ?? this.chordsOn, strip: st?.strip ?? this.stripOn }, false);
    this.refreshMidiButtons();
    this.notesHeight = st?.notesHeight;
    if (this.notesHeight) (this.notesLane.querySelector('.notes-wave') as HTMLElement).style.height = `${this.notesHeight}px`;
    this.invalidate();
  }

  getState(): TxState {
    const s = this.host.song();
    return { notes: this.notesOn, chords: this.chordsOn, strip: this.stripOn, simple: this.simple, stripZoom: this.stripZoom, source: this.source, chordList: s?.chords, midi: s?.midi, notesHeight: this.notesHeight };
  }

  private show(p: { notes?: boolean; chords?: boolean; strip?: boolean }, save = true) {
    if (p.notes != null) this.notesOn = p.notes;
    if (p.chords != null) this.chordsOn = p.chords;
    if (p.strip != null) this.stripOn = p.strip;
    this.notesLane.hidden = !this.notesOn;
    this.chordLane.hidden = !this.chordsOn;
    this.stripLane.hidden = !this.stripOn;
    pressed($('stripBtn'), this.stripOn);
    if (!this.chordsOn) this.closeEditor();
    if (!this.notesOn) {
      this.unfreeze();
      this.heldRows.clear();
    }
    pressed($('notesBtn'), this.notesOn);
    pressed($('chordsBtn'), this.chordsOn);
    const s = this.host.song();
    if (s && this.notesOn) void this.ensureCqt(this.sourceNames());
    if (s && (this.chordsOn || this.stripOn) && !s.chords) void this.detectChords();
    this.invalidate();
    if (save) this.host.changed();
  }

  invalidate() {
    this.img = null;
    this.redraw();
  }

  // ---------- note energy (CQT) ----------
  private sourceNames() {
    const s = this.host.song();
    if (!s) return [];
    return this.source === HEAR ? s.stems.map((x) => x.name).filter((n) => role(n) !== 'drums') : [this.source];
  }

  private pending = new Map<string, Promise<void>>();
  private ensureCqt(names: string[]) {
    const s = this.host.song();
    if (!s) return Promise.resolve();
    s.cqt ??= new Map();
    const jobs = names.map((name) => {
      if (s.cqt!.has(name)) return Promise.resolve();
      const key = `${s.title}|${name}`;
      let p = this.pending.get(key);
      if (!p) {
        const stem = s.stems.find((x) => x.name === name);
        if (!stem) return Promise.resolve();
        this.setStatus('Finding notes…');
        p = background
          .run<Cqt>({ type: 'cqt', mono: monoOf([stem]) })
          .then((c) => {
            let peak = 0;
            for (let i = 0; i < c.data.length; i++) if (c.data[i] > peak) peak = c.data[i];
            s.cqt!.set(name, { c, peak });
            if (this.host.song() === s) this.invalidate();
          })
          .finally(() => {
            this.pending.delete(key);
            if (!this.pending.size) this.setStatus('');
          });
        this.pending.set(key, p);
      }
      return p;
    });
    return Promise.all(jobs).then(() => {});
  }

  private setStatus(t: string) {
    if (!this.busy) this.noteStatus.textContent = t;
  }

  /** Stems shown, with their weights (power, so gain²). */
  private weighted() {
    const s = this.host.song();
    if (!s?.cqt) return [];
    const g = this.host.gains();
    return s.stems
      .map((x, i) => ({
        e: s.cqt!.get(x.name),
        // "What you hear" leaves drums out: a drum hit lights up every note.
        w: this.source === HEAR ? (role(x.name) === 'drums' ? 0 : g[i] * g[i]) : x.name === this.source ? 1 : 0,
      }))
      .filter((x): x is { e: { c: Cqt; peak: number }; w: number } => !!x.e && x.w > 0);
  }

  private buildImage(w: number) {
    const parts = this.weighted();
    const shift = this.host.pitch();
    const v = this.host.view();
    const key = [w, v.start, v.end, shift, this.source, parts.map((p) => p.w.toFixed(3)).join(',')].join('|');
    if (this.img?.key === key) return this.img.canvas;
    const c = this.img?.canvas ?? document.createElement('canvas');
    c.width = w;
    c.height = BINS;
    const g = c.getContext('2d')!;
    const im = g.createImageData(w, BINS);
    const ref = Math.max(1e-12, ...parts.map((p) => p.e.peak * p.w));
    const fps = CQT_FPS / SR;
    const col = new Float32Array(BINS);
    for (let x = 0; x < w; x++) {
      const f0 = Math.floor((v.start + (x / w) * (v.end - v.start)) * fps);
      const f1 = Math.max(f0 + 1, Math.floor((v.start + ((x + 1) / w) * (v.end - v.start)) * fps));
      col.fill(0);
      for (const p of parts) {
        const d = p.e.c.data;
        const last = Math.min(f1, p.e.c.frames);
        for (let t = Math.max(0, f0); t < last; t++)
          for (let b = 0; b < BINS; b++) {
            const val = d[t * BINS + b] * p.w;
            if (val > col[b]) col[b] = val;
          }
      }
      for (let b = 0; b < BINS; b++) {
        const row = BINS - 1 - (b + shift);
        if (row < 0 || row >= BINS) continue;
        const db = 10 * Math.log10(col[b] / ref + 1e-12);
        const t = Math.max(0, Math.min(1, (db + 55) / 55));
        const li = Math.round(t ** 1.3 * 255) * 3;
        const o = (row * w + x) * 4;
        im.data[o] = LUT[li];
        im.data[o + 1] = LUT[li + 1];
        im.data[o + 2] = LUT[li + 2];
        im.data[o + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
    this.img = { key, canvas: c };
    return c;
  }

  /** Rows (display) sounding at a time, 0–1 strength. */
  private activeRows(pos: number) {
    const out = new Float32Array(BINS);
    const parts = this.weighted();
    if (!parts.length) return out;
    const ref = Math.max(1e-12, ...parts.map((p) => p.e.peak * p.w));
    const t = Math.floor((pos / SR) * CQT_FPS);
    const col = new Float32Array(BINS);
    for (const p of parts) if (t < p.e.c.frames) for (let b = 0; b < BINS; b++) col[b] += p.e.c.data[t * BINS + b] * p.w;
    const top = Math.max(...col);
    const shift = this.host.pitch();
    for (let b = 0; b < BINS; b++) {
      const row = BINS - 1 - (b + shift);
      if (row < 0 || row >= BINS || col[b] <= 0) continue;
      const rel = 10 * Math.log10(col[b] / top);
      const abs = 10 * Math.log10(col[b] / ref);
      if (rel > -15 && abs > -40) out[row] = 1 + rel / 15;
    }
    return out;
  }

  // ---------- drawing ----------
  /** Called by the deck whenever it redraws. */
  draw(pos: number) {
    const s = this.host.song();
    if (!s) return;
    if (this.chordsOn) this.drawChords(pos);
    if (this.notesOn) this.drawNotes(pos);
    this.followFreeze(pos);
  }

  private x(frame: number, w: number) {
    const v = this.host.view();
    return ((frame - v.start) / (v.end - v.start)) * w;
  }

  private drawNotes(pos: number) {
    const c = this.noteCanvas;
    const g = fitCanvas(c);
    const { width: w, height: H } = c;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { top, bottom } = this.pitchView;
    const rowH = H / (bottom - top);
    const rowY = (row: number) => (row - top) * rowH;
    g.imageSmoothingEnabled = false;
    const img = this.buildImage(Math.max(1, Math.round(w / dpr)));
    g.drawImage(img, 0, top, img.width, bottom - top, 0, 0, w, H);
    const shift = this.host.pitch();
    // Octave lines (at each C) and labels.
    g.font = `${9 * dpr}px system-ui, sans-serif`;
    g.textBaseline = 'bottom';
    for (let n = NOTE_LO; n <= NOTE_HI; n++) {
      if (n % 12) continue;
      const y = rowY(NOTE_HI - n + 1);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(0, Math.round(y), w, 1);
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.fillText(noteName(n), 3 * dpr, y - 1);
    }
    // Bars.
    const beats = this.host.beats();
    if (beats.length) {
      const per = this.host.perBar();
      const d = this.host.downbeat();
      g.fillStyle = 'rgba(255,255,255,0.07)';
      beats.forEach((b, i) => {
        if ((i - d) % per) return;
        const bx = this.x(b * SR, w);
        if (bx >= 0 && bx <= w) g.fillRect(Math.round(bx), 0, 1, H);
      });
    }
    // Loop.
    const lp = this.host.loop();
    if (lp.b > lp.a) {
      g.fillStyle = lp.on ? 'rgba(139,124,246,0.16)' : 'rgba(139,124,246,0.07)';
      g.fillRect(this.x(lp.a, w), 0, this.x(lp.b, w) - this.x(lp.a, w), H);
    }
    // MIDI notes for this source.
    const notes = this.host.song()?.midi?.[this.midiKey()];
    if (notes?.length) {
      const colour = this.sourceColour();
      const v = this.host.view();
      for (const n of notes) {
        if (n.end * SR < v.start || n.start * SR > v.end) continue;
        const row = NOTE_HI - (n.pitch + shift);
        if (row < top || row >= bottom) continue;
        const x0 = this.x(n.start * SR, w);
        const x1 = Math.max(x0 + 2, this.x(n.end * SR, w));
        // White outline shows on the heat map; a tick in the part's colour marks the start.
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = Math.max(1, dpr);
        g.strokeRect(x0 - 0.5, rowY(row) - 1.5, x1 - x0 + 1, rowH + 3);
        g.fillStyle = colour;
        g.fillRect(x0 - 0.5, rowY(row) - 1.5, 2 * dpr, rowH + 3);
      }
    }
    // Markers and playhead.
    g.fillStyle = '#f59e0b';
    for (const m of this.host.markers()) {
      const mx = this.x(m.pos, w);
      if (mx >= 0 && mx <= w) g.fillRect(Math.round(mx), 0, Math.max(1, dpr), H);
    }
    g.fillStyle = '#fff';
    g.fillRect(Math.round(this.x(pos, w)), 0, Math.max(1, dpr), H);
    // Hover: highlight the row and name it.
    if (this.hover && this.hover.row >= top && this.hover.row < bottom) {
      const r = this.hover.row;
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(0, rowY(r), w, rowH);
      const label = `${noteName(NOTE_HI - r)} · ${fmtTime(this.hover.t)}`;
      g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
      const tw = g.measureText(label).width + 8 * dpr;
      const ly = Math.max(14 * dpr, rowY(r));
      g.fillStyle = 'rgba(0,0,0,0.7)';
      g.fillRect(w - tw - 4 * dpr, ly - 14 * dpr, tw, 14 * dpr);
      g.fillStyle = '#fff';
      g.fillText(label, w - tw, ly - 2 * dpr);
    }
    this.drawKeys(pos);
  }

  private drawKeys(pos: number) {
    const c = this.keys;
    if (!c.clientWidth) return;
    const g = fitCanvas(c);
    const { width: w, height: H } = c;
    const { top, bottom } = this.pitchView;
    const rowH = H / (bottom - top);
    const active = this.activeRows(pos);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // y of a pitch value (a note's row runs from v = n to n + 1, low at the bottom)
    const y = (v: number) => (NOTE_HI + 1 - v - top) * rowH;
    g.fillStyle = '#e8e8ee';
    g.fillRect(0, 0, w, H);
    // White-key edges: at B|C and E|F, and half-way up each black key.
    const edges = [0, 1.5, 3.5, 5, 6.5, 8.5, 10.5];
    g.fillStyle = 'rgba(0,0,0,0.28)';
    for (let oct = NOTE_LO - (NOTE_LO % 12); oct <= NOTE_HI; oct += 12)
      for (const e of edges) g.fillRect(0, Math.round(y(oct + e)), w, 1);
    for (let n = NOTE_LO; n <= NOTE_HI; n++) {
      if (!isBlack(n)) continue;
      g.fillStyle = '#26262e';
      g.fillRect(0, y(n + 1), w * 0.6, rowH);
    }
    // Sounding notes.
    active.forEach((a, r) => {
      if (a <= 0 || r < top || r >= bottom) return;
      g.fillStyle = `rgba(139,124,246,${0.4 + 0.6 * a})`;
      g.fillRect(0, (r - top) * rowH, w, rowH);
    });
    g.fillStyle = '#666';
    g.font = `${8 * dpr}px system-ui, sans-serif`;
    g.textBaseline = 'bottom';
    for (let n = NOTE_LO; n <= NOTE_HI; n++) if (n % 12 === 0) g.fillText(`C${n / 12 - 1}`, w - g.measureText(`C${n / 12 - 1}`).width - 2 * dpr, y(n) - 1);
    // Keys held on the computer keyboard.
    for (const r of this.heldRows) {
      if (r < top || r >= bottom) continue;
      g.fillStyle = 'rgba(139,124,246,0.55)';
      g.fillRect(0, (r - top) * rowH, w, rowH);
    }
    // Hover: highlight the key and name it.
    if (this.keyHover != null) {
      const r = this.keyHover;
      g.fillStyle = 'rgba(139,124,246,0.35)';
      g.fillRect(0, (r - top) * rowH, w, rowH);
      const label = noteName(NOTE_HI - r);
      g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
      const tw = g.measureText(label).width + 8 * dpr;
      const ly = Math.max(14 * dpr, Math.min(H, (r - top) * rowH + rowH));
      g.fillStyle = 'rgba(0,0,0,0.8)';
      g.fillRect(2 * dpr, ly - 14 * dpr, tw, 14 * dpr);
      g.fillStyle = '#fff';
      g.fillText(label, 4 * dpr, ly - 2 * dpr);
    }
  }

  private sourceColour() {
    const lanes = this.host.lanes();
    return lanes.find((l) => l.name === this.source)?.colour ?? '#8b7cf6';
  }

  // ---------- chord timeline ----------
  get stripShown() {
    return this.stripOn;
  }

  private setStripZoom(z: number) {
    this.stripZoom = Math.max(0.5, Math.min(2.5, z));
    this.host.changed();
    this.host.redraw();
  }

  private beatCellList(s: TxSong) {
    const chords = s.chords ?? [];
    const beats = this.host.beats();
    const downbeat = this.host.downbeat();
    const perBar = this.host.perBar();
    const c = this.cells;
    if (c && c.chords === chords && c.beats === beats && c.downbeat === downbeat && c.perBar === perBar) return c.list;
    const list = beatCells(chords, beats, downbeat, perBar);
    this.cells = { chords, beats, downbeat, perBar, list };
    return list;
  }

  /** Draws the timeline: a row of beat boxes sliding past a fixed playhead, the chord shown where it starts, the current one lit. Called every screen frame while playing. */
  drawStrip() {
    if (!this.stripOn) return;
    const s = this.host.song();
    if (!s) return;
    const c = this.stripCanvas;
    const g = fitCanvas(c);
    const { width: w, height: H } = c;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    g.clearRect(0, 0, w, H);
    const beats = this.host.beats();
    const ink = getComputedStyle(document.body).color;
    const accent = '#8b7cf6';
    g.textBaseline = 'middle';
    const say = (text: string) => {
      g.font = `500 ${13 * dpr}px system-ui, sans-serif`;
      g.fillStyle = ink;
      g.globalAlpha = 0.6;
      g.fillText(text, 12 * dpr, H / 2);
      g.globalAlpha = 1;
    };
    if (!beats.length) return say('Waiting for the tempo to be detected…');
    if (!s.chords) return say('Detecting chords…');
    const list = this.beatCellList(s);
    const chords = s.chords;
    const cw = 78 * dpr * this.stripZoom;
    const hold = w * 0.28;
    const cur = beatPositionAt(beats, this.host.smoothPos() / SR);
    this.stripGeom = { cur, hold: hold / dpr, cw: cw / dpr };
    const shift = this.host.pitch();
    const sharps = this.sharps();
    const names = (cell?: BeatCell) => (cell && cell.chord >= 0 ? displayName(chords[cell.chord], shift, sharps, this.simple) : '');
    const curCell = list[Math.max(0, Math.min(list.length - 1, Math.floor(cur)))];
    const curName = names(curCell);
    const top = 22 * dpr;
    const bottom = H - 6 * dpr;
    const first = Math.max(0, Math.floor(cur - hold / cw) - 1);
    const last = Math.min(list.length - 1, Math.ceil(cur + (w - hold) / cw) + 1);
    g.font = `700 ${Math.round(21 * dpr * Math.min(1.25, this.stripZoom))}px system-ui, sans-serif`;
    for (let i = first; i <= last; i++) {
      const cell = list[i];
      const x = hold + (i - cur) * cw;
      const name = names(cell);
      const prevName = i > 0 ? names(list[i - 1]) : '';
      const isCur = i === Math.floor(cur);
      const sameAsNow = name !== '' && name === curName;
      g.fillStyle = isCur ? accent : sameAsNow ? 'rgba(139,124,246,0.30)' : name ? 'rgba(139,124,246,0.10)' : 'rgba(127,127,127,0.06)';
      g.fillRect(x + dpr, top, cw - 2 * dpr, bottom - top);
      // A new chord shows its name; the beats it carries on through stay quiet.
      if (name && name !== prevName) {
        g.fillStyle = isCur ? '#fff' : ink;
        g.fillText(name, x + 8 * dpr, (top + bottom) / 2);
      } else if (name) {
        g.fillStyle = isCur ? '#fff' : ink;
        g.globalAlpha = 0.35;
        g.fillRect(x + cw / 2 - 2 * dpr, (top + bottom) / 2 - dpr, 4 * dpr, 2 * dpr);
        g.globalAlpha = 1;
      }
      if (cell.beat === 0) {
        g.fillStyle = ink;
        g.globalAlpha = 0.55;
        g.fillRect(x, 4 * dpr, dpr, bottom - 4 * dpr + dpr);
        g.globalAlpha = 1;
        if (cell.bar >= 1) {
          g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
          g.fillStyle = ink;
          g.globalAlpha = 0.7;
          g.fillText(String(cell.bar), x + 4 * dpr, 11 * dpr);
          g.globalAlpha = 1;
          g.font = `700 ${Math.round(21 * dpr * Math.min(1.25, this.stripZoom))}px system-ui, sans-serif`;
        }
      }
    }
    // The playhead.
    g.fillStyle = ink;
    g.fillRect(Math.round(hold), 2 * dpr, Math.max(1, dpr), H - 4 * dpr);
  }

  /** A click on the timeline: the top strip is a bar number (loop that bar); anywhere else jumps to that beat. */
  private stripClick(x: number, y: number) {
    const s = this.host.song();
    const beats = this.host.beats();
    if (!s || !beats.length) return;
    const { cur, hold, cw } = this.stripGeom;
    const idx = Math.floor(cur + (x - hold) / cw);
    const list = this.beatCellList(s);
    if (idx < 0 || idx >= list.length) return;
    if (y < 20) {
      const bar = list[idx].bar;
      const inBar = list.filter((c) => c.bar === bar);
      if (!inBar.length) return;
      this.host.loopFrames(inBar[0].t0 * SR, inBar[inBar.length - 1].t1 * SR);
      toast(`Looping bar ${bar}`);
      return;
    }
    this.host.player.seek(Math.round(list[idx].t0 * SR));
  }

  // ---------- chords ----------
  private sharps() {
    // Spell for the key you hear (after any pitch shift).
    const k = this.host.key();
    return prefersSharps(k && { tonic: (((k.tonic + this.host.pitch()) % 12) + 12) % 12, mode: k.mode });
  }

  private chordAt(t: number) {
    return this.host.song()?.chords?.findIndex((c) => t >= c.start && t < c.end) ?? -1;
  }

  private drawChords(pos: number) {
    const s = this.host.song()!;
    const c = this.chordCanvas;
    const g = fitCanvas(c);
    const { width: w, height: H } = c;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    g.clearRect(0, 0, w, H);
    const chords = s.chords ?? [];
    const shift = this.host.pitch();
    const sharps = this.sharps();
    const now = this.chordAt(pos / SR);
    g.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    g.textBaseline = 'middle';
    const accent = '#8b7cf6';
    const ink = getComputedStyle(document.body).color;
    chords.forEach((ch, i) => {
      const x0 = this.x(ch.start * SR, w);
      const x1 = this.x(ch.end * SR, w);
      if (x1 < 0 || x0 > w) return;
      const cur = i === now;
      g.fillStyle = cur ? accent : i === this.editing ? 'rgba(245,158,11,0.35)' : ch.root < 0 ? 'rgba(127,127,127,0.08)' : 'rgba(139,124,246,0.14)';
      g.fillRect(x0 + dpr, 2 * dpr, Math.max(1, x1 - x0 - 2 * dpr), H - 4 * dpr);
      const name = chordName(ch, shift, sharps);
      const tw = g.measureText(name).width;
      if (tw + 6 * dpr < x1 - x0) {
        g.fillStyle = cur ? '#fff' : ch.root < 0 ? 'rgba(127,127,127,0.8)' : ink;
        g.fillText(name, Math.max(x0 + 4 * dpr, Math.min(x1 - tw - 4 * dpr, x0 + 4 * dpr)), H / 2);
      }
      if (ch.manual) {
        g.fillStyle = '#f59e0b';
        g.fillRect(x0 + dpr, H - 4 * dpr, Math.max(1, x1 - x0 - 2 * dpr), 2 * dpr);
      }
    });
    g.fillStyle = ink;
    g.fillRect(Math.round(this.x(pos, w)), 0, Math.max(1, dpr), H);
    // "Now → next" in the side panel.
    if (!this.chordStatus.textContent) {
      const cur = chords[now];
      const next = chords.slice(now + 1).find((c) => c.root >= 0 || !cur);
      this.chordNow.textContent = cur ? `${chordName(cur, shift, sharps)}${next ? `  → ${chordName(next, shift, sharps)}` : ''}` : '';
    } else this.chordNow.textContent = '';
  }

  private async detectChords() {
    const s = this.host.song();
    if (!s) return;
    this.closeEditor();
    this.chordStatus.textContent = 'Detecting…';
    try {
      const roles = s.stems.map((x) => role(x.name));
      let harm = s.stems.filter((_, i) => roles[i] === 'harm');
      const bassStem = s.stems.find((_, i) => roles[i] === 'bass');
      if (!harm.length) harm = s.stems.filter((_, i) => roles[i] !== 'drums');
      if (!harm.length) harm = s.stems;
      const useBass = bassStem && !harm.includes(bassStem) ? bassStem : undefined;
      await this.ensureCqt([...harm.map((x) => x.name), ...(useBass ? [useBass.name] : [])]);
      if (this.host.song() !== s) return;
      const parts = harm.map((x) => s.cqt!.get(x.name)!.c);
      const sum: Cqt = { frames: parts[0].frames, data: new Float32Array(parts[0].data.length) };
      for (const p of parts) for (let i = 0; i < sum.data.length; i++) sum.data[i] += p.data[i];
      s.chords = detectChords(sum, this.host.beats(), useBass ? s.cqt!.get(useBass.name)!.c : undefined, {
        downbeat: this.host.downbeat(),
        perBar: this.host.perBar(),
      });
      this.host.changed();
    } catch (e) {
      toast(`Couldn't detect chords: ${(e as Error).message}`, true);
    } finally {
      this.chordStatus.textContent = '';
      this.redraw();
    }
  }

  private chordClick(f: number) {
    const s = this.host.song();
    if (!s?.chords) return;
    const v = this.host.view();
    const t = (v.start + f * (v.end - v.start)) / SR;
    const i = this.chordAt(t);
    if (i < 0) return;
    if (i === this.editing) return this.closeEditor();
    this.editing = i;
    this.editAt = t;
    this.renderEditor();
    this.redraw();
  }

  private closeEditor() {
    this.editing = -1;
    this.editor.hidden = true;
    this.redraw();
  }

  private renderEditor() {
    const s = this.host.song();
    const ch = s?.chords?.[this.editing];
    if (!s || !ch) return this.closeEditor();
    const shift = this.host.pitch();
    const sharps = this.sharps();
    const pcs = Array.from({ length: 12 }, (_, i) => i);
    const sel = (opts: [string, string][], val: string, label: string) => {
      const x = h('select', { 'aria-label': label } as any, ...opts.map(([v, t]) => h('option', { value: v }, t)));
      x.value = val;
      return x;
    };
    // Selects show sounding pitches (with the shift); stored chords stay at the original pitch.
    const root = sel([['-1', 'No chord'], ...pcs.map((p) => [String(p), noteLetter(p + shift, sharps)] as [string, string])], String(ch.root), 'Root');
    const qual = sel(
      QUALITIES.map((q) => [q, q || 'major'] as [string, string]),
      ch.q,
      'Type',
    );
    const bass = sel(
      [['', 'bass: root'], ...pcs.map((p) => [String(p), `bass: ${noteLetter(p + shift, sharps)}`] as [string, string])],
      ch.bass != null ? String(ch.bass) : '',
      'Bass note',
    );
    const apply = (patch: Partial<Chord>) => {
      const list = [...s.chords!];
      // Keep what was detected as a choice, in case the edit was wrong.
      const alts: [number, Quality][] = ch.manual ? (ch.alts ?? []) : [[ch.root, ch.q], ...(ch.alts ?? [])];
      list[this.editing] = { ...ch, ...patch, alts, manual: true };
      const at = ch.start;
      s.chords = mergeSame(list);
      this.editing = s.chords.findIndex((c) => at >= c.start && at < c.end);
      this.host.changed();
      this.renderEditor();
      this.redraw();
    };
    const set = h('button', { class: 'btn tiny', type: 'button' }, 'Set');
    set.onclick = () => apply({ root: Number(root.value), q: qual.value as Quality, bass: bass.value === '' ? undefined : Number(bass.value) });
    const alts = (ch.alts ?? []).filter(([r, q]) => r !== ch.root || q !== ch.q).map(([r, q]) => {
      const b = h('button', { class: 'eq-chip', type: 'button', title: 'Use this chord' }, chordName({ root: r, q }, shift, sharps));
      b.onclick = () => apply({ root: r, q, bass: undefined });
      return b;
    });
    // Split at the beat nearest the click, inside this chord.
    const beats = this.host.beats().filter((b) => b > ch.start + 0.05 && b < ch.end - 0.05);
    const splitAt = beats.length ? beats.reduce((a, b) => (Math.abs(b - this.editAt) < Math.abs(a - this.editAt) ? b : a)) : (ch.start + ch.end) / 2;
    const split = h(
      'button',
      { class: 'btn tiny ghost', type: 'button', title: 'Split this chord in two, to change one half' },
      `Split at ${fmtTime(splitAt)}`,
    );
    split.onclick = () => {
      const list = [...s.chords!];
      list.splice(this.editing, 1, { ...ch, end: splitAt, manual: true }, { ...ch, start: splitAt, manual: true });
      s.chords = list;
      this.editing += 1;
      this.editAt = splitAt;
      this.host.changed();
      this.renderEditor();
      this.redraw();
    };
    const close = h('button', { class: 'btn tiny ghost', type: 'button' }, 'Close');
    close.onclick = () => this.closeEditor();
    this.editor.replaceChildren(
      ...[
        h('span', { class: 'ce-name' }, chordName(ch, shift, sharps)),
        h('span', { class: 'muted small' }, `${fmtTime(ch.start)}–${fmtTime(ch.end)}`),
        alts.length ? h('span', { class: 'ce-alts' }, h('span', { class: 'muted small' }, 'Or:'), ...alts) : null,
        h('span', { class: 'ce-set' }, root, qual, bass, set),
        split,
        close,
      ].filter((x): x is HTMLElement => !!x),
    );
    this.editor.hidden = false;
  }

  private saveChart() {
    const s = this.host.song();
    if (!s?.chords?.length) {
      toast('No chords yet');
      return;
    }
    const text = chordSheet({
      title: s.title.replace(/\.[a-z0-9]{2,5}$/i, ''),
      chords: s.chords,
      beats: this.host.beats(),
      downbeat: this.host.downbeat(),
      perBar: this.host.perBar(),
      markers: this.host.markers().map((m) => ({ name: m.name, time: m.pos / SR })),
      shift: this.host.pitch(),
      sharps: this.sharps(),
      keyName: this.host.keyLabel(),
      bpm: this.host.bpm(),
    });
    void saveFile(`${this.host.baseName()} - chords.txt`, new TextEncoder().encode(text), 'text/plain');
  }

  // ---------- audio to MIDI ----------
  private midiKey() {
    return this.source === HEAR ? 'mix' : this.source;
  }

  private refreshMidiButtons() {
    const s = this.host.song();
    const has = !!s?.midi && Object.values(s.midi).some((n) => n.length);
    this.midiSaveBtn.hidden = !has;
    this.midiClearBtn.hidden = !s?.midi?.[this.midiKey()];
    this.midiBtn.textContent = this.busy ? 'Cancel' : s?.midi?.[this.midiKey()] ? 'Redo MIDI' : 'To MIDI';
  }

  private clearMidi() {
    const s = this.host.song();
    if (!s?.midi?.[this.midiKey()]) return;
    const { [this.midiKey()]: _, ...rest } = s.midi;
    s.midi = rest;
    this.host.changed();
    this.refreshMidiButtons();
    this.redraw();
  }

  private async toMidi() {
    if (this.busy) {
      cancelTranscribe();
      return;
    }
    const s = this.host.song();
    if (!s) return;
    const key = this.midiKey();
    const g = this.host.gains();
    const pick = s.stems.map((x, i) => ({ x, g: g[i] })).filter(({ x }) => (this.source === HEAR ? role(x.name) !== 'drums' : x.name === this.source));
    const stems = pick.map((p) => p.x);
    const gains = this.source === HEAR ? pick.map((p) => p.g) : undefined;
    const label = this.source === HEAR ? 'all parts' : (this.sourceSel.selectedOptions[0]?.text ?? key);
    this.busy = key;
    this.refreshMidiButtons();
    this.noteStatus.textContent = `MIDI: ${label}…`;
    const t0 = performance.now();
    try {
      const notes = await transcribe(monoOf(stems, gains), (done, total) => {
        const el = (performance.now() - t0) / 1000;
        const left = done ? (el / done) * (total - done) : 0;
        this.noteStatus.textContent = `MIDI: ${Math.round((100 * done) / total)}%${done > 2 ? ` · ${Math.ceil(left)} s left` : ''}`;
      });
      if (this.host.song() !== s) return;
      // Lead vocals and bass play one note at a time: drop overlapping extras.
      const mono = this.source !== HEAR && ['vocals', 'bass'].includes(role(this.source));
      const final = mono ? singleLine(notes) : notes;
      s.midi = { ...s.midi, [key]: final };
      this.host.changed();
      this.noteStatus.textContent = `${final.length} notes${mono ? ' (one at a time)' : ''}`;
      setTimeout(() => {
        if (!this.busy) this.noteStatus.textContent = '';
      }, 4000);
    } catch (e) {
      this.noteStatus.textContent = '';
      if ((e as Error).name !== 'Cancelled') toast(`Couldn't make MIDI: ${(e as Error).message}`, true);
    } finally {
      this.busy = '';
      this.refreshMidiButtons();
      this.redraw();
    }
  }

  private saveMidi() {
    const s = this.host.song();
    if (!s?.midi) return;
    const shift = this.host.pitch();
    const tracks = Object.entries(s.midi)
      .filter(([, n]) => n.length)
      .map(([name, notes]) => ({
        name: name === 'mix' ? 'Mix' : name,
        program: programFor(name),
        notes: notes.map((n) => ({ ...n, pitch: Math.max(0, Math.min(127, n.pitch + shift)) })),
      }));
    const bytes = writeMidi(tracks, this.host.bpm() ?? 120);
    void saveFile(`${this.host.baseName()}${shift ? ` ${shift > 0 ? '+' : ''}${shift}st` : ''}.mid`, bytes, 'audio/midi');
  }

  // ---------- freeze ----------
  get frozen() {
    return this.frozenAt >= 0;
  }

  toggleFreeze() {
    if (this.frozen) this.unfreeze();
    else void this.freeze(this.host.player.state.pos);
  }

  private unfreeze() {
    if (!this.frozen) return;
    this.frozenAt = -1;
    this.host.player.stopHold();
    pressed(this.freezeBtn, false);
  }

  private async freeze(pos: number) {
    const s = this.host.song();
    if (!s) return;
    this.host.player.pause();
    this.frozenAt = pos;
    pressed(this.freezeBtn, true);
    const seg = Math.round(0.3 * SR);
    const start = Math.max(0, Math.round(pos - seg / 4));
    const end = Math.min(s.stems[0].data[0].length, start + seg);
    if (end - start < 4096) return;
    const src = renderMix(
      s.stems.map((x) => x.data as [Float32Array, Float32Array]),
      this.host.gains(),
      start,
      end,
      1,
      0,
      this.host.pans(),
      this.host.eqs(),
    );
    // Granular hold: overlapping windowed grains from random points in the
    // segment, written round a 2 s loop so it repeats seamlessly.
    const L = 2 * SR;
    const G = 4096;
    const hop = G / 4;
    const out = [new Float32Array(L), new Float32Array(L)];
    const win = new Float32Array(G).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / G));
    let seed = 12345;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const span = src[0].length - G;
    for (let o = 0; o < L; o += hop) {
      const from = Math.floor(rnd() * span);
      for (let c = 0; c < 2; c++) for (let i = 0; i < G; i++) out[c][(o + i) % L] += src[c][from + i] * win[i] * 0.5;
    }
    await this.host.player.hold(out, 2 ** (this.host.pitch() / 12));
  }

  /** While frozen: follow clicks to a new spot; stop when playback starts. */
  private followFreeze(pos: number) {
    if (!this.frozen) return;
    if (this.host.player.state.playing) return this.unfreeze();
    if (Math.abs(pos - this.frozenAt) > SR * 0.05) void this.freeze(pos);
  }
}
