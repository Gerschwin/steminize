// Draws a chord diagram as a small SVG: a fretboard with finger dots for the guitar and ukulele, a two-octave keyboard for the piano.
// Colours come from the page (currentColor and the accent), so it follows the theme. The shapes themselves are in analysis/chordShapes.ts.

import { fretShape, pianoKeys, type Instrument } from '../analysis/chordShapes.ts';
import type { Quality } from '../analysis/chords.ts';

const NS = 'http://www.w3.org/2000/svg';
const ACCENT = '#8b7cf6';

function el(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

const FRETS = 5;

/** A fretboard diagram: strings run up and down (lowest on the left), frets across, an X above a string that is not played and an O above an open one. */
function fretboard(frets: number[], base: number, barre: { fret: number; from: number; to: number } | undefined): SVGElement {
  const n = frets.length;
  const gap = n === 6 ? 11 : 14;
  const left = 16;
  const top = 20;
  const row = 13;
  const w = left + (n - 1) * gap + 14;
  const h = top + FRETS * row + 8;
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'chord-svg', role: 'img' });
  const x = (i: number) => left + i * gap;
  const line = { stroke: 'currentColor', 'stroke-opacity': 0.55, 'stroke-width': 1 };
  for (let i = 0; i < n; i++) svg.append(el('line', { x1: x(i), y1: top, x2: x(i), y2: top + FRETS * row, ...line }));
  for (let j = 0; j <= FRETS; j++) svg.append(el('line', { x1: x(0), y1: top + j * row, x2: x(n - 1), y2: top + j * row, ...line, ...(j === 0 && base === 1 ? { 'stroke-width': 3, 'stroke-opacity': 0.9 } : {}) }));
  if (base > 1) svg.append(el('text', { x: 1, y: top + row * 0.5 + 4, 'font-size': 10, fill: 'currentColor', 'fill-opacity': 0.8 }, `${base}`));
  const yOf = (f: number) => top + (f - base) * row + row / 2;
  if (barre) svg.append(el('rect', { x: x(barre.from) - 4.5, y: yOf(barre.fret) - 4.5, width: x(barre.to) - x(barre.from) + 9, height: 9, rx: 4.5, fill: ACCENT }));
  frets.forEach((f, i) => {
    if (f < 0) svg.append(el('text', { x: x(i), y: top - 6, 'text-anchor': 'middle', 'font-size': 10, fill: 'currentColor', 'fill-opacity': 0.7 }, '×'));
    else if (f === 0) svg.append(el('circle', { cx: x(i), cy: top - 8, r: 3, fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.7 }));
    else svg.append(el('circle', { cx: x(i), cy: yOf(f), r: 4.5, fill: ACCENT }));
  });
  return svg;
}

const WHITE = [0, 2, 4, 5, 7, 9, 11];

/** A two-octave keyboard with the keys of the chord filled in, and the lowest one a little darker. */
function keyboard(keys: number[]): SVGElement {
  const kw = 10;
  const kh = 44;
  const w = kw * 14 + 2;
  const svg = el('svg', { viewBox: `0 0 ${w} ${kh + 4}`, width: w, height: kh + 4, class: 'chord-svg', role: 'img' });
  const on = new Set(keys);
  const lowest = Math.min(...keys);
  const fill = (k: number) => (k === lowest ? '#6a58e8' : on.has(k) ? ACCENT : null);
  for (let i = 0; i < 14; i++) {
    const k = WHITE[i % 7] + 12 * Math.floor(i / 7);
    svg.append(el('rect', { x: 1 + i * kw, y: 1, width: kw, height: kh, fill: fill(k) ?? '#f3f3f6', stroke: '#555' }));
  }
  for (let i = 0; i < 13; i++) {
    const pos = i % 7;
    if (pos === 2 || pos === 6) continue; // no black key between E and F, or between B and C
    const k = WHITE[pos] + 1 + 12 * Math.floor(i / 7);
    svg.append(el('rect', { x: 1 + (i + 1) * kw - 3, y: 1, width: 6, height: kh * 0.6, fill: fill(k) ?? '#23232b', stroke: '#111' }));
  }
  return svg;
}

/** The diagram for a chord on an instrument, or null for a chord with no notes (no chord detected). `root` and `bass` are note numbers, 0 = C, already shifted. */
export function chordDiagram(instrument: Instrument, root: number, q: Quality, bass?: number): SVGElement | null {
  if (root < 0) return null;
  if (instrument === 'piano') return keyboard(pianoKeys(root, q));
  const sh = fretShape(instrument, root, q, bass);
  if (!sh) return null;
  return fretboard(sh.frets, sh.base, sh.barre);
}
