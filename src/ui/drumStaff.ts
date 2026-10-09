// A drum part as it is written on a percussion staff: hands up, kick down, x noteheads for the hi-hat and cymbals. Draws the same
// kind of strip the engraved guitar tab does and reports the same layout (where each moment of the music is, in pixels, and a box
// round each hit), so the follow-along view can scroll and highlight it exactly as it does for a guitar tab.

import type { TabBar } from '../lyrics/tabSync.ts';
import { DRUM_VOICES, type DrumNote, type DrumStyle, type DrumVoice } from '../lyrics/drumTab.ts';
import type { TabScoreLayout } from './staff.ts';

let vex: Promise<typeof import('vexflow/bravura')> | undefined;

/** One thing in a voice: a rest or a chord of hits, lasting `d` sixteenths from slot `at`. */
export interface Slot {
  at: number;
  d: number;
  hits: DrumNote[];
}

/** The note lengths drawn, in sixteenths (a hit is never written longer than a quarter: drums don't sustain). */
const NOTE_CODES: Record<number, string> = { 4: 'q', 3: '8d', 2: '8', 1: '16' };
/** Rests, from longest to shortest. */
const REST_SIZES = [16, 8, 4, 2, 1];

/**
 * One voice of one bar as a row of notes and rests that exactly fills it. `hits` are the hits in this voice with their slot (a
 * whole number of sixteenths from the bar's start); each lasts up to the next one, at most a quarter, and what is left until the
 * next hit is filled with rests, so that every note and rest sits on its natural place in the bar.
 */
export function voiceSlots(hits: { slot: number; note: DrumNote }[], length: number): Slot[] {
  const out: Slot[] = [];
  const bySlot = new Map<number, DrumNote[]>();
  for (const h of hits) bySlot.set(h.slot, [...(bySlot.get(h.slot) ?? []), h.note]);
  const slots = [...bySlot.keys()].filter((s) => s >= 0 && s < length).sort((a, b) => a - b);
  let pos = 0;
  const rest = (to: number) => {
    while (pos < to) {
      const size = REST_SIZES.find((s) => pos % s === 0 && s <= to - pos) ?? 1;
      out.push({ at: pos, d: size, hits: [] });
      pos += size;
    }
  };
  slots.forEach((s, i) => {
    rest(s);
    const next = i + 1 < slots.length ? slots[i + 1] : length;
    const gap = next - s;
    const d = [4, 2, 1].find((size) => size <= gap && s % size === 0) ?? 1;
    const dur = gap === 3 && s % 4 === 0 ? 3 : d; // a dotted eighth, only from a beat
    out.push({ at: s, d: dur, hits: bySlot.get(s)! });
    pos = s + dur;
  });
  rest(length);
  return out;
}

const STYLE_FOR_HEAD: Record<string, string> = { x: 'x2', normal: '' };

export async function drawDrumScore(host: HTMLElement, notes: DrumNote[], bars: TabBar[]): Promise<TabScoreLayout> {
  vex ??= import('vexflow/bravura');
  const vf = await vex;
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready.catch(() => {});
  const { Renderer, Stave, StaveNote, Voice, Formatter, Beam, Stem, Barline, Articulation, Parenthesis, Modifier, Dot } = vf;
  host.replaceChildren();

  const CLEF = 56;
  const INTRO = 40;
  const TOP = 50; // room above the stave for cymbals and the bar number
  const ROW = TOP + 44 + 60; // the five lines, then room for the kick and its stems
  const widthOf = (b: TabBar) => Math.max(120, b.length * 17 + 40);
  const total = INTRO + CLEF + bars.reduce((n, b) => n + widthOf(b), 0) + 20;
  const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(total, ROW);
  const ctx = renderer.getContext();
  ctx.setFillStyle('currentColor');
  ctx.setStrokeStyle('currentColor');
  const introSvg = host.querySelector('svg');

  const map: { u: number; x: number }[] = [];
  const notesOut: TabScoreLayout['notes'] = [];
  let x = INTRO;
  bars.forEach((bar, bi) => {
    const w = widthOf(bar) + (bi === 0 ? CLEF : 0);
    const stave = new Stave(x, TOP - 10, w);
    if (bi === 0) stave.addClef('percussion');
    stave.setMeasure(bi + 1);
    if (bar.repeatStart) stave.setBegBarType(Barline.type.REPEAT_BEGIN);
    if (bar.repeatEnd) stave.setEndBarType(Barline.type.REPEAT_END);
    stave.setContext(ctx).draw();
    // A click target over each bar's number, as on the guitar tab: pressing it loops that bar.
    if (introSvg) {
      const barNumY = stave.getYForTopText(0) + 3;
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [k, v] of Object.entries({ x: stave.getX() - 12, y: barNumY - 13, width: 24, height: 18, rx: 4, fill: 'transparent', stroke: 'none', class: 'tab-barnum', 'data-barnum': bi })) hit.setAttribute(k, String(v));
      hit.style.pointerEvents = 'all';
      const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      tip.textContent = `Bar ${bi + 1}: click to loop it · Shift-click to extend the loop to here`;
      hit.appendChild(tip);
      introSvg.appendChild(hit);
    }

    const length = Math.max(1, Math.round(bar.length));
    const inBar = notes.filter((n) => n.bar === bi);
    const toHit = (n: DrumNote) => ({ slot: Math.min(length - 1, Math.max(0, Math.round(n.start - bar.start))), note: n });
    const voices: { up: boolean; slots: Slot[] }[] = [];
    const upHits = inBar.filter((n) => DRUM_VOICES[n.drum.voice].up).map(toHit);
    const downHits = inBar.filter((n) => !DRUM_VOICES[n.drum.voice].up).map(toHit);
    voices.push({ up: true, slots: voiceSlots(upHits, length) });
    if (downHits.length) voices.push({ up: false, slots: voiceSlots(downHits, length) });

    const built = voices.map((v) => {
      const tickables = v.slots.map((s) => {
        const rest = s.hits.length === 0;
        const base = rest ? (s.d === 16 ? 'w' : s.d === 8 ? 'h' : s.d === 4 ? 'q' : s.d === 2 ? '8' : '16') : NOTE_CODES[s.d].replace('d', '');
        const dots = !rest && NOTE_CODES[s.d].endsWith('d') ? 1 : 0;
        const keys = rest ? [v.up ? 'b/4' : 'd/4'] : s.hits.map((h) => `${DRUM_VOICES[h.drum.voice].key}${STYLE_FOR_HEAD[DRUM_VOICES[h.drum.voice].head] ? `/${STYLE_FOR_HEAD[DRUM_VOICES[h.drum.voice].head]}` : ''}`);
        const note = new StaveNote({ keys, duration: base + (rest ? 'r' : ''), dots, clef: 'percussion', stemDirection: v.up ? Stem.UP : Stem.DOWN });
        if (dots) Dot.buildAndAttach([note], { all: true });
        if (!rest) {
          s.hits.forEach((h, k) => {
            const style: DrumStyle = h.drum.style;
            if (style === 'accent') note.addModifier(new Articulation('a>').setPosition(v.up ? 3 : 4), k);
            if (style === 'open') note.addModifier(new Articulation('ah').setPosition(3), k);
            if (style === 'ghost') for (const pos of [Modifier.Position.LEFT, Modifier.Position.RIGHT]) note.addModifier(new Parenthesis(pos), k); // (a ghost note, in brackets)
          });
        }
        return note;
      });
      const voice = new Voice({ numBeats: length, beatValue: 16 }).setMode(Voice.Mode.SOFT);
      voice.addTickables(tickables);
      return { voice, tickables, slots: v.slots };
    });

    const formatter = new Formatter();
    for (const b of built) formatter.joinVoices([b.voice]);
    formatter.format(built.map((b) => b.voice), w - (bi === 0 ? CLEF : 0) - 30);
    const beams = built.flatMap((b) => Beam.generateBeams(b.tickables, { maintainStemDirections: true, beamRests: false }));
    for (const b of built) b.voice.draw(ctx, stave);
    for (const beam of beams) beam.setContext(ctx).draw();

    // Where each moment of the bar is, and a box round the hits at it, for the follow-along.
    const seen = new Set<number>();
    for (const b of built) {
      b.slots.forEach((s, i) => {
        if (!s.hits.length || seen.has(s.at)) return;
        seen.add(s.at);
        const sameTime = built.flatMap((o) => o.slots.map((os, oi) => ({ os, t: o.tickables[oi] }))).filter((e) => e.os.at === s.at && e.os.hits.length);
        const ys = sameTime.flatMap((e) => e.t.getYs());
        const nx = b.tickables[i].getAbsoluteX();
        const u = bar.start + s.at;
        map.push({ u, x: nx });
        const first = s.hits[0];
        notesOut.push({ u, len: Math.max(1, s.d), x: nx - 9, y: Math.min(...ys) - 12, w: 22, h: Math.max(...ys) - Math.min(...ys) + 24, bar: bi, col: first.col });
      });
    }
    x += w;
  });
  const last = bars[bars.length - 1];
  if (last) map.push({ u: last.start + last.length, x: total - 20 });
  map.sort((a, b) => a.u - b.u);
  notesOut.sort((a, b) => a.u - b.u);
  const svg = host.querySelector('svg');
  if (svg) {
    svg.style.overflow = 'visible';
    svg.style.display = 'block';
  }
  return { map, notes: notesOut, width: total, height: ROW };
}

/** Which kit pieces a score uses, for a legend. */
export function voicesUsed(notes: DrumNote[]): DrumVoice[] {
  const order = Object.keys(DRUM_VOICES) as DrumVoice[];
  return order.filter((v) => notes.some((n) => n.drum.voice === v));
}
