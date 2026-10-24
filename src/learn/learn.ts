// Learn mode: the practice method of "checkpoints, chunks and clean passes". A song is split into sections (your markers), a section
// into chunks (a bar or a few bars), and each chunk is looped until it has been played cleanly a set number of times in a row, then
// the next one is started. This file is the logic and the saved progress, with no screen or player in it, so it can be tested.

/** A stretch of the song, in sample frames. */
export interface Span {
  a: number;
  b: number;
}

export interface Section extends Span {
  name: string;
}

/** How many bars make a chunk; 0 means the whole section. */
export type ChunkSize = 1 | 2 | 4 | 0;

/**
 * The song's sections from its markers: each marker starts a section that runs to the next one (the last runs to the end). Anything
 * before the first marker is a section of its own called "Start", when it is long enough to be worth practising.
 */
export function sectionsFromMarkers(markers: { name: string; pos: number }[], length: number, sr: number): Section[] {
  const sorted = [...markers].filter((m) => m.pos >= 0 && m.pos < length).sort((a, b) => a.pos - b.pos);
  const out: Section[] = [];
  if (!sorted.length || sorted[0].pos > sr * 2) out.push({ name: sorted.length ? 'Start' : 'Whole song', a: 0, b: sorted[0]?.pos ?? length });
  sorted.forEach((m, i) => out.push({ name: m.name, a: m.pos, b: sorted[i + 1]?.pos ?? length }));
  return out.filter((s) => s.b - s.a > sr / 4);
}

/**
 * The frames where each bar of the song starts, from the beat grid (beat times in seconds, `downbeat` the index of the first bar's
 * beat, `perBar` beats to a bar). Empty when there is no tempo.
 */
export function barStarts(beats: number[], downbeat: number, perBar: number, sr: number): number[] {
  if (!beats.length || perBar < 1) return [];
  const out: number[] = [];
  for (let i = Math.max(0, downbeat); i < beats.length; i += perBar) out.push(Math.round(beats[i] * sr));
  return out;
}

/**
 * The chunks of a section: pieces of `size` bars that start on bar lines. With no bar grid, a bar is taken as 2 seconds. A short piece
 * left at the end (under half a chunk) joins the one before it rather than being a sliver to practise on its own.
 */
export function chunksOf(section: Section, size: ChunkSize, bars: number[], sr: number): Span[] {
  const whole = [{ a: section.a, b: section.b }];
  if (size === 0) return whole;
  const tol = sr / 8;
  let edges: number[];
  const inside = bars.filter((x) => x >= section.a - tol && x < section.b - tol);
  if (inside.length >= 2) {
    edges = [section.a];
    for (let i = size; i < inside.length; i += size) edges.push(inside[i]);
  } else {
    const step = size * 2 * sr;
    edges = [];
    for (let t = section.a; t < section.b - tol; t += step) edges.push(t);
  }
  edges = edges.filter((e, i) => i === 0 || e > edges[i - 1] + tol);
  const spans = edges.map((a, i) => ({ a, b: edges[i + 1] ?? section.b }));
  if (spans.length > 1) {
    const last = spans[spans.length - 1];
    const prev = spans[spans.length - 2];
    if (last.b - last.a < (prev.b - prev.a) / 2) {
      prev.b = last.b;
      spans.pop();
    }
  }
  return spans.length ? spans : whole;
}

/** One chunk from `from` to `to` (inclusive) joined together: the "stitch" of several chunks back into one. */
export function stitch(chunks: Span[], from: number, to: number): Span {
  const i = Math.max(0, Math.min(from, to));
  const j = Math.min(chunks.length - 1, Math.max(from, to));
  return { a: chunks[i].a, b: chunks[j].b };
}

/** A key for a stretch of the song, steady against tiny differences: its start and end to the nearest quarter second. */
export const spanKey = (s: Span, sr: number) => `${Math.round((s.a / sr) * 4)}-${Math.round((s.b / sr) * 4)}`;

/** True when two stretches are the same one, allowing for the loop having been set a few samples off. */
export const sameSpan = (x: Span, y: Span, sr: number) => Math.abs(x.a - y.a) < sr / 10 && Math.abs(x.b - y.b) < sr / 10;

/** How one chunk (or stitched stretch) is going. */
export interface Progress {
  /** Times it has been played through in its loop. */
  passes: number;
  /** Clean passes in a row right now, and the best run so far. */
  streak: number;
  best: number;
  /** Reached the target run. */
  done: boolean;
}

export const newProgress = (): Progress => ({ passes: 0, streak: 0, best: 0, done: false });

/** A pass was played (clean or not): counts it. */
export const addPass = (p: Progress): Progress => ({ ...p, passes: p.passes + 1 });

/** A clean pass: the run grows, and reaching `target` marks the chunk done. `reached` is true only on the pass that does it. */
export function addClean(p: Progress, target: number): { progress: Progress; reached: boolean } {
  const streak = p.streak + 1;
  const done = p.done || streak >= Math.max(1, target);
  return { progress: { ...p, streak, best: Math.max(p.best, streak), done }, reached: done && !p.done };
}

/** A missed pass: the run starts again from nothing (a chunk already done stays done). */
export const addMiss = (p: Progress): Progress => ({ ...p, streak: 0 });

export type Status = 'new' | 'learning' | 'solid';

/**
 * How a section is going: solid when every one of its chunks is done (or you said so), learning once any has been played, else new.
 * `progress` is keyed by `spanKey`.
 */
export function sectionStatus(chunks: Span[], progress: Record<string, Progress>, sr: number, markedSolid = false): Status {
  if (markedSolid) return 'solid';
  const ps = chunks.map((c) => progress[spanKey(c, sr)]);
  if (ps.length && ps.every((p) => p?.done)) return 'solid';
  return ps.some((p) => p && (p.passes > 0 || p.streak > 0 || p.done)) ? 'learning' : 'new';
}

/** What is saved with a song. */
export interface LearnState {
  size: ChunkSize;
  /** Clean passes in a row that finish a chunk. */
  target: number;
  /** Let the tab Trainer's score decide whether a pass was clean. */
  auto: boolean;
  /** Go to the next chunk by itself when one is finished. */
  advance: boolean;
  progress: Record<string, Progress>;
  /** Sections marked solid by hand, by the section start's key. */
  solid: Record<string, true>;
}

export const DEFAULT_LEARN: LearnState = { size: 2, target: 20, auto: true, advance: true, progress: {}, solid: {} };

/** Reads saved Learn state, tolerating anything: missing, old or wrongly typed fields fall back to the defaults. */
export function readLearn(raw: unknown): LearnState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
  const progress: Record<string, Progress> = {};
  if (typeof r.progress === 'object' && r.progress !== null) {
    for (const [k, v] of Object.entries(r.progress as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue;
      const p = v as Record<string, unknown>;
      progress[k] = { passes: num(p.passes, 0, 0, 1e6), streak: num(p.streak, 0, 0, 1e6), best: num(p.best, 0, 0, 1e6), done: p.done === true };
    }
  }
  const solid: Record<string, true> = {};
  if (typeof r.solid === 'object' && r.solid !== null) for (const [k, v] of Object.entries(r.solid as Record<string, unknown>)) if (v === true) solid[k] = true;
  const size = r.size === 1 || r.size === 2 || r.size === 4 || r.size === 0 ? r.size : DEFAULT_LEARN.size;
  return { size, target: num(r.target, DEFAULT_LEARN.target, 1, 200), auto: r.auto !== false, advance: r.advance !== false, progress, solid };
}

/** The first chunk of a section that is not done yet, or 0 if all are (so there is always one to start on). */
export function firstUnfinished(chunks: Span[], progress: Record<string, Progress>, sr: number): number {
  const i = chunks.findIndex((c) => !progress[spanKey(c, sr)]?.done);
  return i < 0 ? 0 : i;
}

/**
 * Markers after adding suggested sections: the suggestions replace yours, or are added alongside, skipping any that fall within half a
 * second of a marker you already have (your own placement and name win). Sorted by position, in frames.
 */
export function mergeMarkers(existing: { name: string; pos: number }[], suggested: { name: string; pos: number }[], replace: boolean, sr: number): { name: string; pos: number }[] {
  const base = replace ? [] : existing.map((m) => ({ ...m }));
  for (const s of suggested) if (!base.some((m) => Math.abs(m.pos - s.pos) < sr / 2)) base.push({ name: s.name, pos: s.pos });
  return base.sort((a, b) => a.pos - b.pos);
}
