// The logic behind the scrolling chord timeline (the row of beat boxes that moves with the music): which chord sits in which beat,
// where in the beat the playhead is, and the plain major / minor form of a chord for beginners. No drawing here, so it can be tested.

import { chordName, type Chord, type Quality } from './chords.ts';

const MINOR_QUALITIES = new Set<Quality>(['m', 'm7', 'm6', 'dim']);

/**
 * The plain form of a chord: major or minor only. Sevenths, sixths, suspensions, added notes, power chords and augmented chords become
 * the plain major chord, minor sevenths and sixths and diminished chords become minor, and a slash bass note is dropped. This is
 * what a beginner wants to play, and it also hides the fine detail the detector is least sure of.
 */
export function simplifyChord(c: Chord): Chord {
  if (c.root < 0) return c;
  const { bass: _bass, ...rest } = c;
  return { ...rest, q: MINOR_QUALITIES.has(c.q) ? 'm' : '' };
}

/** The name to show for a chord: as you hear it (with any pitch shift), optionally in its plain form. */
export function displayName(c: Chord | undefined, shift: number, sharps: boolean, simple: boolean): string {
  if (!c) return '';
  return chordName(simple ? simplifyChord(c) : c, shift, sharps);
}

/** One beat of the song: its time span, the chord sounding in it (an index into the chord list, -1 for none) and where it is in its bar. */
export interface BeatCell {
  i: number;
  t0: number;
  t1: number;
  chord: number;
  /** Bar number counting from 1 at the downbeat; 0 or below before the first full bar. */
  bar: number;
  /** 0 for the first beat of a bar. */
  beat: number;
}

/** Puts each beat of the song with the chord that covers its middle. `beats` are in seconds; `downbeat` is the index of a bar's first beat. */
export function beatCells(chords: Chord[], beats: number[], downbeat: number, perBar: number): BeatCell[] {
  const per = Math.max(1, Math.round(perBar));
  const out: BeatCell[] = [];
  let k = 0;
  for (let i = 0; i < beats.length; i++) {
    const t0 = beats[i];
    const t1 = i + 1 < beats.length ? beats[i + 1] : t0 + (i > 0 ? t0 - beats[i - 1] : 0.5);
    const mid = (t0 + t1) / 2;
    while (k < chords.length && chords[k].end <= mid) k++;
    const chord = k < chords.length && chords[k].start <= mid ? k : -1;
    const rel = i - downbeat;
    out.push({ i, t0, t1, chord, bar: Math.floor(rel / per) + 1, beat: ((rel % per) + per) % per });
  }
  return out;
}

/** Where `t` (seconds) falls among the beats, as a fractional beat index (2.5 is halfway through the third beat); extended past either end at the nearest tempo. */
export function beatPositionAt(beats: number[], t: number): number {
  const n = beats.length;
  if (n === 0) return 0;
  if (n === 1) return (t - beats[0]) / 0.5;
  if (t <= beats[0]) return (t - beats[0]) / (beats[1] - beats[0]);
  if (t >= beats[n - 1]) return n - 1 + (t - beats[n - 1]) / (beats[n - 1] - beats[n - 2]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - beats[lo]) / (beats[hi] - beats[lo]);
}

/** The time (seconds) at a fractional beat index: the inverse of beatPositionAt. */
export function timeAtBeat(beats: number[], pos: number): number {
  const n = beats.length;
  if (n === 0) return 0;
  if (n === 1) return beats[0] + pos * 0.5;
  if (pos <= 0) return beats[0] + pos * (beats[1] - beats[0]);
  if (pos >= n - 1) return beats[n - 1] + (pos - (n - 1)) * (beats[n - 1] - beats[n - 2]);
  const i = Math.floor(pos);
  return beats[i] + (pos - i) * (beats[i + 1] - beats[i]);
}
