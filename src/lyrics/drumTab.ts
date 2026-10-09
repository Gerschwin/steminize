// Drum tab: the plain-text grid a drummer writes (one row per kit piece, one column per sixteenth, bars between `|`):
//
//   HH|x-x-x-x-x-x-x-x-|
//   SD|----o-------o---|
//   BD|o-------o-o-----|
//
// turned into the same timed notes and bars the guitar tab gives the follow-along, so the existing timing (taps, tempo, bar
// loops, repeats, scrolling) works on drums without changes. A hit is a note whose "pitch" is its General MIDI drum number.
// What it looks like on a percussion staff is drawn elsewhere (src/ui/drumStaff.ts).

import { barSegments, tabBlocks, type TabBar, type TabNote } from './tabSync.ts';

export type DrumVoice = 'kick' | 'snare' | 'hihat' | 'ride' | 'crash' | 'hightom' | 'midtom' | 'floortom';
/** How a hit is played: from the character written for it. */
export type DrumStyle = 'normal' | 'accent' | 'ghost' | 'open' | 'flam';

export interface DrumInfo {
  name: string;
  /** General MIDI percussion note number. */
  midi: number;
  /** Where it sits on a percussion staff (VexFlow key), by the usual drum-set convention. */
  key: string;
  /** The notehead: an x for cymbals and hi-hat, an ordinary head for drums. */
  head: 'normal' | 'x';
  /** Stem up for what the hands play, down for the foot (kick). */
  up: boolean;
}

export const DRUM_VOICES: Record<DrumVoice, DrumInfo> = {
  crash: { name: 'Crash', midi: 49, key: 'a/5', head: 'x', up: true },
  ride: { name: 'Ride', midi: 51, key: 'f/5', head: 'x', up: true },
  hihat: { name: 'Hi-hat', midi: 42, key: 'g/5', head: 'x', up: true },
  hightom: { name: 'High tom', midi: 50, key: 'e/5', head: 'normal', up: true },
  snare: { name: 'Snare', midi: 38, key: 'c/5', head: 'normal', up: true },
  midtom: { name: 'Mid tom', midi: 47, key: 'd/5', head: 'normal', up: true },
  floortom: { name: 'Floor tom', midi: 43, key: 'a/4', head: 'normal', up: true },
  kick: { name: 'Kick', midi: 36, key: 'f/4', head: 'normal', up: false },
};

/** Open hi-hat has its own General MIDI number. */
export const OPEN_HIHAT_MIDI = 46;

/** The kit piece a row label names, however it is usually abbreviated. */
const LABELS: [RegExp, DrumVoice][] = [
  [/^(cc|cr|cy|c|crash|crsh|c1|c2)$/i, 'crash'],
  [/^(rc|rd|r|ride|rcy)$/i, 'ride'],
  [/^(hh|h|hc|ho|oh|ch|hat|hihat)$/i, 'hihat'],
  [/^(sn|sd|s|snare|sna)$/i, 'snare'],
  [/^(ht|th|t1|hi|hitom)$/i, 'hightom'],
  [/^(mt|tm|t2|mid|midtom)$/i, 'midtom'],
  [/^(ft|lt|tf|t3|fl|floor|lotom)$/i, 'floortom'],
  [/^(bd|kd|k|b|kick|bass|bdr)$/i, 'kick'],
];

export function voiceOfLabel(label: string): DrumVoice | null {
  const l = label.trim();
  for (const [re, v] of LABELS) if (re.test(l)) return v;
  return null;
}

/** What a character in a drum row means as a hit (null = nothing is played). */
export function hitStyle(ch: string, voice: DrumVoice): DrumStyle | null {
  switch (ch) {
    case 'x':
      return 'normal';
    case 'X':
      return 'accent';
    case 'o':
      return voice === 'hihat' ? 'open' : 'normal';
    case 'O':
      return voice === 'hihat' ? 'open' : 'accent';
    case 'g':
    case 'G':
      return 'ghost';
    case 'f':
    case 'F':
      return 'flam';
    case 'd':
    case 'D':
      return 'normal';
    default:
      return null;
  }
}

export interface DrumNote extends TabNote {
  drum: { voice: DrumVoice; style: DrumStyle };
}

/** The General MIDI number a hit sounds at (open hi-hat differs from closed). */
export const drumMidi = (voice: DrumVoice, style: DrumStyle): number => (voice === 'hihat' && style === 'open' ? OPEN_HIHAT_MIDI : DRUM_VOICES[voice].midi);

/** The drum grid as bars and a list of hits with their times, in the same shape `parseScore` gives for a guitar tab. */
export function parseDrums(text: string): { notes: DrumNote[]; bars: TabBar[] } {
  const lines = text.split('\n');
  const blocks = tabBlocks(text);
  const notes: DrumNote[] = [];
  const bars: TabBar[] = [];
  blocks.forEach((b, bi) => {
    const segs = barSegments(b);
    const barBase = bars.length;
    // A time signature line ("4/4") rescales each bar's columns to its real length, so a grid written with eight columns to
    // a bar still lasts a whole bar; without one, every column is a sixteenth note. (Same remapping as the guitar tab.)
    let fixedStart = 0;
    const segFixed = segs.map(([from, to]) => {
      const rawStart = b.cum[from];
      const rawLen = b.cum[to] - rawStart;
      const fixedLen = b.events ? rawLen : (b.timeSig ?? rawLen);
      const seg = { rawStart, fixedStart, scale: rawLen > 0 ? fixedLen / rawLen : 1, fixedLen };
      fixedStart += fixedLen;
      return seg;
    });
    // Rows of the block that name a kit piece; anything else (a counting line, "1 e + a") is skipped.
    const rows: { line: string; voice: DrumVoice; index: number }[] = [];
    for (let r = b.firstRow; r <= b.lastRow; r++) {
      const line = lines[r] ?? '';
      const bar = line.indexOf('|');
      const voice = bar > 0 ? voiceOfLabel(line.slice(0, bar)) : null;
      if (voice) rows.push({ line, voice, index: rows.length });
    }
    const rowLines = rows.map((r) => r.line);
    const repeats = (from: number, to: number) => ({
      ...(rowLines.some((l) => l[from] === '*') ? { repeatStart: true } : {}),
      ...(rowLines.some((l) => l[to - 1] === '*' && to - 1 > from) ? { repeatEnd: true } : {}),
    });
    segs.forEach(([from, to], i) => bars.push({ start: b.start + segFixed[i].fixedStart, length: segFixed[i].fixedLen, ...repeats(from, to) }));
    const found: DrumNote[] = [];
    for (const row of rows) {
      for (let c = b.label; c < row.line.length; c++) {
        if (b.barLine[c]) continue;
        const style = hitStyle(row.line[c], row.voice);
        if (!style) continue;
        const segIdx = segs.findIndex(([from, to]) => c >= from && c < to);
        if (segIdx === -1) continue;
        const sf = segFixed[segIdx];
        const start = b.start + sf.fixedStart + (b.cum[c] - sf.rawStart) * sf.scale;
        found.push({ block: bi, string: row.index, fret: null, midi: drumMidi(row.voice, style), col: c, start, length: 0, bar: barBase + segIdx, drum: { voice: row.voice, style } });
      }
    }
    // How long each hit "lasts" (to the next hit anywhere in the block, or the end of it): what the position highlight uses.
    const starts = [...new Set(found.map((n) => n.start))].sort((x, y) => x - y);
    const blockEnd = bars.length > barBase ? bars[bars.length - 1].start + bars[bars.length - 1].length : b.start + b.width;
    for (const n of found) {
      const next = starts.find((x) => x > n.start);
      n.length = (next ?? blockEnd) - n.start;
    }
    notes.push(...found);
  });
  return { notes: notes.sort((x, y) => x.start - y.start || x.string - y.string), bars };
}
