// Send to DAW: everything a recording program needs to open a song the way it is in Steminize. The stems go in as separate tracks,
// the song's tempo and bar grid become the project's tempo and bars, and the markers and loop come with it. This file is the logic
// (no browser needed); the files are written by the deck. See DAW_EXPORT.md for what each program gets and how to open it.

import { writeMidiTempoMap } from '../encode/midi.ts';

export interface DawTrack {
  /** The name shown in the DAW. */
  name: string;
  /** The audio file for this track, relative to the project. */
  file: string;
  /** A colour like #f0a838. */
  colour: string;
  /** Linear level (1 = unity), pan (-1 left to 1 right), mute and solo as set in Steminize. */
  vol: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

export interface DawProject {
  title: string;
  sampleRate: number;
  /** Length of the audio in seconds (the stems, before any lead-in). */
  seconds: number;
  /** Beats per minute and beats per bar; both are 0 / 4 when the song has no detected tempo. */
  bpm: number;
  perBar: number;
  /** Seconds of silence the stems are placed after, so the song's first bar starts on a bar line. */
  padSec: number;
  tracks: DawTrack[];
  /** Markers, in seconds on the DAW's timeline (the lead-in already added). */
  markers: { name: string; time: number }[];
  /** The loop, in seconds on the DAW's timeline, if one is set. */
  loop?: { start: number; end: number };
}

/**
 * How far to move the stems so the song's first bar lands on a bar line of a steady tempo. `bar1` is when that bar starts in the
 * audio. The stems are put after `padSec` seconds of silence (always less than one bar), and bar numbers in the DAW then match the
 * song's: the song's first bar is a whole number of bars from the project start.
 */
export function barAlignment(bar1: number, bpm: number, perBar: number): { padSec: number; barLen: number; leadBars: number } {
  const barLen = (perBar * 60) / bpm;
  if (!(barLen > 0) || !Number.isFinite(barLen) || !Number.isFinite(bar1) || bar1 < 0) return { padSec: 0, barLen: barLen > 0 && Number.isFinite(barLen) ? barLen : 0, leadBars: 0 };
  const leadBars = Math.ceil(bar1 / barLen - 1e-9);
  const padSec = leadBars * barLen - bar1;
  return { padSec: padSec < 1e-6 ? 0 : padSec, barLen, leadBars };
}

/**
 * The tempo changes that follow the song's real beats, for a song whose tempo drifts. The first `leadBars` bars are at the steady
 * tempo; from the song's first bar on, each beat gets the tempo that makes it last as long as it did in the recording. Each entry is
 * the beat number (counting quarter notes from the project start) where the tempo starts, and the tempo.
 */
export function beatTempos(beats: number[], firstBarBeat: number, bpm: number, perBar: number, leadBars: number): { beat: number; bpm: number }[] {
  const out: { beat: number; bpm: number }[] = [{ beat: 0, bpm }];
  const start = leadBars * perBar;
  let last = bpm;
  for (let i = Math.max(0, firstBarBeat); i + 1 < beats.length; i++) {
    const d = beats[i + 1] - beats[i];
    if (!(d > 0.05 && d < 3)) continue; // not a believable beat length: keep the tempo as it was
    const t = Math.round((60 / d) * 100) / 100;
    if (Math.abs(t - last) >= 0.01) {
      out.push({ beat: start + (i - firstBarBeat), bpm: t });
      last = t;
    }
  }
  return out;
}

const q = (s: string) => `"${s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')}"`;

/** A GUID in the {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} form Reaper uses, made from a seed so the same project gives the same file. */
export function guid(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const hex = (n: number, w: number) => (n >>> 0).toString(16).toUpperCase().padStart(w, '0').slice(-w);
  const a = hex(h1, 8);
  const b = hex(h2, 8);
  const c = hex(Math.imul(h1, 31) ^ h2, 8);
  const d = hex(Math.imul(h2, 17) ^ h1, 8);
  return `{${a}-${b.slice(0, 4)}-${b.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}${d}}`;
}

/** Reaper's colour number for a #rrggbb colour (a 24-bit value with the "custom colour" flag set). */
export function reaperColour(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 0;
  const [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  return 0x1000000 | r | (g << 8) | (b << 16);
}

const num = (n: number, digits = 6) => String(Number(n.toFixed(digits)));

/** A Reaper project (.rpp) next to its audio files: one track per stem, tempo and bars, markers, and the loop as the time selection. */
export function reaperProject(p: DawProject): string {
  const lines: string[] = [];
  const L = (indent: number, s: string) => lines.push(`${'  '.repeat(indent)}${s}`);
  const bpm = p.bpm > 0 ? p.bpm : 120;
  L(0, `<REAPER_PROJECT 0.1 "7.0" 0`);
  L(1, `RIPPLE 0`);
  L(1, `SAMPLERATE ${p.sampleRate} 0 0`);
  L(1, `LOOP ${p.loop ? 1 : 0}`);
  L(1, `TEMPO ${num(bpm, 4)} ${p.perBar} 4`);
  if (p.loop) L(1, `SELECTION ${num(p.loop.start)} ${num(p.loop.end)}`);
  p.markers.forEach((m, i) => L(1, `MARKER ${i + 1} ${num(m.time)} ${q(m.name)} 0 0 1 R ${guid(`marker${i}${m.name}`)} 0`));
  p.tracks.forEach((t, i) => {
    L(1, `<TRACK ${guid(`track${i}${t.name}`)}`);
    L(2, `NAME ${q(t.name)}`);
    L(2, `PEAKCOL ${reaperColour(t.colour)}`);
    L(2, `VOLPAN ${num(t.vol, 4)} ${num(t.pan, 4)} -1 -1 1`);
    L(2, `MUTESOLO ${t.mute ? 1 : 0} ${t.solo ? 1 : 0} 0`);
    L(2, `NCHAN 2`);
    L(2, `<ITEM`);
    L(3, `POSITION ${num(p.padSec)}`);
    L(3, `LENGTH ${num(p.seconds)}`);
    L(3, `NAME ${q(t.name)}`);
    L(3, `IGUID ${guid(`item${i}${t.name}`)}`);
    L(3, `GUID ${guid(`take${i}${t.name}`)}`);
    L(3, `<SOURCE WAVE`);
    L(4, `FILE ${q(t.file)}`);
    L(3, `>`);
    L(2, `>`);
    L(1, `>`);
  });
  L(0, `>`);
  return `${lines.join('\n')}\n`;
}

/**
 * The description the Steminize Player plugin reads (`steminize-song.json`, beside the stems): the song, its tempo and bars, where the
 * stems start on the DAW's timeline, and each stem's file (relative to this description), colour and mixer settings. See plugin/README.md.
 * `files` are the audio file paths as they will be written, in the same order as `p.tracks`.
 */
export function songManifest(p: DawProject, files: string[]): string {
  return `${JSON.stringify(
    {
      format: 1,
      title: p.title,
      sampleRate: p.sampleRate,
      bpm: p.bpm > 0 ? Number(p.bpm.toFixed(4)) : 0,
      perBar: p.perBar,
      leadInSec: Number(p.padSec.toFixed(6)),
      stems: p.tracks.map((t, i) => ({ name: t.name, file: files[i], colour: t.colour, gain: Number(t.vol.toFixed(4)), pan: Number(t.pan.toFixed(4)), mute: t.mute, solo: t.solo })),
      markers: p.markers.map((m) => ({ name: m.name, timeSec: Number(m.time.toFixed(4)) })),
    },
    null,
    2,
  )}\n`;
}

/** The markers as a CSV that Reaper, Pro Tools and most DAWs can import as a marker list: name, start in seconds and bars.beats. */
export function markersCsv(p: DawProject): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const bpm = p.bpm > 0 ? p.bpm : 120;
  const rows = ['#,Name,Start,Start (bar.beat)'];
  const all = [...p.markers.map((m) => ({ name: m.name, time: m.time }))];
  if (p.loop) all.push({ name: 'Loop start', time: p.loop.start }, { name: 'Loop end', time: p.loop.end });
  all.sort((a, b) => a.time - b.time);
  all.forEach((m, i) => {
    const beats = (m.time * bpm) / 60;
    const bar = Math.floor(beats / p.perBar) + 1;
    const beat = Math.floor(beats % p.perBar) + 1;
    rows.push(`M${i + 1},${cell(m.name)},${num(m.time, 3)},${bar}.${beat}`);
  });
  return `${rows.join('\n')}\n`;
}

/** The tempo map as a standard MIDI file: the tempo and bar length, any tempo changes, and the markers. Import it as a tempo map in any DAW. */
export function tempoMapFile(p: DawProject, changes?: { beat: number; bpm: number }[]): Uint8Array {
  return writeMidiTempoMap({ bpm: p.bpm > 0 ? p.bpm : 120, perBar: p.perBar, changes, markers: p.markers, seconds: p.padSec + p.seconds });
}

/** A short README to travel with the files. */
export function dawReadme(p: DawProject, target: string, leadInInFiles = false): string {
  const tempo = p.bpm > 0 ? `${num(p.bpm, 2)} BPM, ${p.perBar}/4` : 'no tempo was detected, so the grid is 120 BPM and will not match the song (open Tempo & key in Steminize first)';
  const lead =
    p.padSec <= 0
      ? 'The stems start at the beginning of the project.'
      : leadInInFiles
        ? `Each audio file begins with ${num(p.padSec, 3)} s of silence (a lead-in), so the song's first bar lines up with a bar line of the grid when you drop the files in at the very start of the project.`
        : `The stems start ${num(p.padSec, 3)} s into the project (a silent lead-in) so the song's first bar lines up with a bar line of the grid.`;
  return [
    `${p.title}`,
    `Sent from Steminize.`,
    ``,
    `Tempo: ${tempo}.`,
    lead,
    `Tracks: ${p.tracks.map((t) => t.name).join(', ')}.`,
    `Mixer levels, pan, mute and solo are as they were in Steminize. EQ is not carried over.`,
    ``,
    target === 'reaper'
      ? `Reaper: open "${p.title}.rpp". The audio files must stay beside it.`
      : target === 'ardour'
        ? `Ardour 8 or later: open the session folder's .ardour file (Session > Open). If you hear nothing, connect the Master outputs to your speakers in Window > Audio Connections.`
        : target === 'dawproject'
        ? `Bitwig Studio, Studio One or Cubase: open "${p.title}.dawproject" (File > Open).`
        : `Other DAWs: make a new project, set the tempo to ${p.bpm > 0 ? num(p.bpm, 2) : '120'} BPM and ${p.perBar}/4, drag the audio files in at the very start of the project, and (optional) import tempo-map.mid as the tempo map and markers.csv for markers.`,
  ].join('\n') + '\n';
}

