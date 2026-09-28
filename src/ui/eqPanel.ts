import { FLAT, PRESETS, isFlat, responseDb, sameEq, type EqParams } from '../player/eq.ts';
import { fitCanvas, h, pressed } from './dom.ts';

const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);
const logMap = (v: number, lo: number, hi: number) => lo * (hi / lo) ** v;
const logInv = (f: number, lo: number, hi: number) => Math.log(f / lo) / Math.log(hi / lo);

// Slider positions (0-100) <-> values. Low cut: 0 = off. High cut: 100 = off.
const LC = [20, 10000];
const HC = [50, 20000];
const FF = [40, 12000];
const QN = [6, 0.4]; // narrow ... wide
const lcFrom = (v: number) => (v <= 0 ? 0 : Math.round(logMap((v - 1) / 99, LC[0], LC[1])));
const lcTo = (f: number) => (f ? 1 + Math.round(99 * logInv(f, LC[0], LC[1])) : 0);
const hcFrom = (v: number) => (v >= 100 ? 0 : Math.round(logMap(v / 99, HC[0], HC[1])));
const hcTo = (f: number) => (f ? Math.round(99 * logInv(f, HC[0], HC[1])) : 100);
const ffFrom = (v: number) => Math.round(logMap(v / 100, FF[0], FF[1]));
const ffTo = (f: number) => Math.round(100 * logInv(f, FF[0], FF[1]));
const qFrom = (v: number) => +logMap(v / 100, QN[0], QN[1]).toFixed(2);
const qTo = (q: number) => Math.round(100 * logInv(q, QN[0], QN[1]));

export interface EqPanel {
  el: HTMLElement;
  set(e: EqParams): void;
  redraw(): void;
}

/** onChange fires live as sliders move (for playback); onCommit fires once per finished gesture
 * (drag release, keypress, preset click, double-click reset) with the before/after EQ, for undo. */
export function eqPanel(colour: string, onChange: (e: EqParams) => void, onCommit?: (before: EqParams, after: EqParams) => void): EqPanel {
  let eq: EqParams = { ...FLAT };
  let commitBase: EqParams = { ...eq };
  const curve = h('canvas', { class: 'eq-curve' });

  const chip = (name: string, hint: string, value: EqParams) => {
    const b = h('button', { class: 'eq-chip', type: 'button', title: hint }, name);
    b.onclick = () => applyAndCommit({ ...value });
    return { b, value };
  };
  const chips = [chip('Flat', 'No EQ', FLAT), ...PRESETS.map((p) => chip(p.name, p.hint, p.eq))];

  const slider = (label: string, min: number, max: number, step = 1) => {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    const out = h('output');
    const row = h('label', { class: 'eq-row' }, h('span', {}, label), input, out);
    return { input, out, row };
  };
  const lc = slider('Low cut', 0, 100);
  const hc = slider('High cut', 0, 100);
  const ff = slider('Focus', 0, 100);
  const fg = slider('Boost / cut', -24, 12);
  const fq = slider('Width', 0, 100);

  const el = h(
    'div',
    { class: 'eq-panel', style: `--c:${colour}` },
    h('div', { class: 'eq-presets' }, ...chips.map((c) => c.b)),
    h('div', { class: 'eq-body' }, h('div', { class: 'eq-graph' }, curve), h('div', { class: 'eq-sliders' }, lc.row, hc.row, ff.row, fg.row, fq.row)),
  );

  function sync() {
    lc.input.value = String(lcTo(eq.lowCut));
    hc.input.value = String(hcTo(eq.highCut));
    ff.input.value = String(ffTo(eq.freq));
    fg.input.value = String(eq.gain);
    fq.input.value = String(qTo(eq.q));
    lc.out.textContent = eq.lowCut ? fmtHz(eq.lowCut) : 'Off';
    hc.out.textContent = eq.highCut ? fmtHz(eq.highCut) : 'Off';
    ff.out.textContent = fmtHz(eq.freq);
    fg.out.textContent = eq.gain ? `${eq.gain > 0 ? '+' : ''}${eq.gain} dB` : 'Off';
    fq.out.textContent = eq.q >= 2.5 ? 'Narrow' : eq.q <= 0.8 ? 'Wide' : 'Medium';
    for (const c of chips) pressed(c.b, sameEq(c.value, eq) || (c.value === FLAT && isFlat(eq)));
    draw();
  }

  function apply(next: EqParams) {
    eq = next;
    sync();
    onChange({ ...eq });
  }
  /** A whole gesture in one step (preset click, double-click reset): commits immediately. */
  function applyAndCommit(next: EqParams) {
    const before = { ...eq };
    apply(next);
    onCommit?.(before, { ...eq });
    commitBase = { ...eq };
  }
  /** Marks where a drag/keyboard gesture on a slider started, so its eventual 'change' can commit
   * one undo step for the whole gesture instead of one per 'input' event. */
  const markGestureStart = () => (commitBase = { ...eq });
  const commitGesture = () => {
    if (!sameEq(commitBase, eq)) onCommit?.(commitBase, { ...eq });
    commitBase = { ...eq };
  };

  lc.input.oninput = () => apply({ ...eq, lowCut: lcFrom(+lc.input.value) });
  hc.input.oninput = () => apply({ ...eq, highCut: hcFrom(+hc.input.value) });
  ff.input.oninput = () => apply({ ...eq, freq: ffFrom(+ff.input.value) });
  fg.input.oninput = () => apply({ ...eq, gain: +fg.input.value });
  fq.input.oninput = () => apply({ ...eq, q: qFrom(+fq.input.value) });
  for (const s of [lc, hc, ff, fg, fq]) {
    s.input.addEventListener('focus', markGestureStart);
    s.input.addEventListener('change', commitGesture);
    s.input.ondblclick = () => applyAndCommit({ ...eq, ...resetFor(s) });
  }
  function resetFor(s: typeof lc): Partial<EqParams> {
    if (s === lc) return { lowCut: 0 };
    if (s === hc) return { highCut: 0 };
    if (s === fg) return { gain: 0 };
    if (s === fq) return { q: 1 };
    return { freq: 1000 };
  }

  function draw() {
    if (!curve.isConnected || !curve.clientWidth) return;
    const g = fitCanvas(curve);
    const { width: w, height: hh } = curve;
    const dpr = w / curve.clientWidth;
    g.clearRect(0, 0, w, hh);
    const [lo, hi, top, bottom] = [20, 20000, 15, -30];
    const x = (f: number) => (Math.log(f / lo) / Math.log(hi / lo)) * w;
    const y = (db: number) => ((top - Math.max(bottom, Math.min(top, db))) / (top - bottom)) * hh;
    const muted = getComputedStyle(curve).color;
    g.strokeStyle = muted;
    g.globalAlpha = 0.25;
    g.lineWidth = dpr;
    for (const f of [100, 1000, 10000]) {
      g.beginPath();
      g.moveTo(x(f), 0);
      g.lineTo(x(f), hh);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(0, y(0));
    g.lineTo(w, y(0));
    g.stroke();
    g.globalAlpha = 0.7;
    g.fillStyle = muted;
    g.font = `${10 * dpr}px system-ui, sans-serif`;
    for (const [f, t] of [[100, '100'], [1000, '1k'], [10000, '10k']] as const) g.fillText(t, x(f) + 3 * dpr, hh - 4 * dpr);
    g.globalAlpha = 1;
    const n = 160;
    const freqs = Array.from({ length: n }, (_, i) => lo * (hi / lo) ** (i / (n - 1)));
    const db = responseDb(eq, freqs);
    g.strokeStyle = colour;
    g.lineWidth = 2 * dpr;
    g.beginPath();
    freqs.forEach((f, i) => (i ? g.lineTo(x(f), y(db[i])) : g.moveTo(x(f), y(db[i]))));
    g.stroke();
  }

  sync();
  return {
    el,
    set(e) {
      eq = { ...e };
      sync();
    },
    redraw: draw,
  };
}
