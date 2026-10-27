// Turns a track of a Guitar Pro / MusicXML score (read by alphaTab, see loadScore.ts) into the text the Scratchpad's tab editor holds:
// guitar and bass as strings with a rhythm line under each block, drums as the drum grid. The text is the ordinary typed tab, so
// everything that works on a tab you wrote yourself (Follow along, the Staff, bar loops, the full-window view) works on it.
//
// The score's notes are placed exactly: every note's start is worked out in half sixteenths and the rhythm line gives each note
// (and each rest) its length, so a bar adds up to the bar. What the typed format cannot say is written as near as it can (a
// triplet is rounded to the half-sixteenth grid) and counted in `notes`, for the person to be told.
//
// Only what is read here is used from the score, as plain structural types, so the converter can be tested with a score made by hand.

export interface TNote {
  string: number; // 1 = the lowest string
  fret: number;
  isDead: boolean;
  isTieDestination: boolean;
  isPalmMute: boolean;
  vibrato: number; // 0 none
  harmonicType: number; // 1 natural, 2 artificial, 3 pinch
  hammerPullOrigin: TNote | null;
  slideTarget: TNote | null;
  slideOutType: number; // 1 shift, 2 legato
  bendPoints: { offset: number; value: number }[] | null; // value in quarter tones, offset 0..60
  isGhost?: boolean;
  isStaccato?: boolean;
  accentuated?: number;
  percussionArticulation: number;
}
export interface TBeat {
  isRest: boolean;
  graceType: number; // 0 none
  playbackStart: number; // ticks from the start of the bar (960 to a quarter note)
  playbackDuration: number;
  notes: TNote[];
}
export interface TBar {
  voices: { isEmpty?: boolean; beats: TBeat[] }[];
}
export interface TMasterBar {
  isRepeatStart: boolean;
  repeatCount: number;
  alternateEndings: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  calculateDuration(): number;
}
export interface TTrack {
  name: string;
  isPercussion?: boolean;
  percussionArticulations?: { outputMidiNumber: number }[];
  staves: { isPercussion?: boolean; tuning: number[]; bars: TBar[] }[];
}
export interface TScore {
  title?: string;
  tempo: number;
  masterBars: TMasterBar[];
  tracks: TTrack[];
}

export type PartKind = 'guitar' | 'bass' | 'drums';

export interface TrackInfo {
  index: number;
  name: string;
  /** What it can be imported as; null when this cannot (a fretted instrument with a string count the tab editor does not have). */
  part: PartKind | null;
  strings: number;
  bars: number;
}

/** Which tracks a score has, and what each would be imported as. */
export function listTracks(score: TScore): TrackInfo[] {
  return score.tracks.map((t, index) => {
    const staff = t.staves[0];
    const strings = staff?.tuning?.length ?? 0;
    const perc = !!(t.isPercussion || staff?.isPercussion);
    const part: PartKind | null = perc ? 'drums' : strings === 4 ? 'bass' : strings === 6 ? 'guitar' : null;
    return { index, name: t.name || `Track ${index + 1}`, part, strings, bars: staff?.bars.length ?? 0 };
  });
}

export interface Imported {
  part: PartKind;
  text: string;
  /** Character offset of the first note in the text, where the first tap goes. */
  firstNote: number;
  /** Bars written (repeats included: they are written out, so the tab stays level with a recording that plays them). */
  bars: number;
  tempo: number;
  title: string;
  /** Things the typed format could not keep exactly, in words. */
  notes: string[];
}

/** The order the bars are played in, with repeats and numbered endings taken (each bar index once per time it is played). The loader
 * asks alphaTab for this (it knows the jumps and codas too); this plain version is for scores that have only repeats. A bar's
 * `repeatCount` is how many times in all the section plays. */
export function playOrder(masterBars: TMasterBar[]): number[] {
  const order: number[] = [];
  let start = 0;
  let pass = 0;
  for (let i = 0; i < masterBars.length && order.length < 4000; ) {
    const mb = masterBars[i];
    if (mb.isRepeatStart) start = i;
    // A numbered ending (1., 2.) is only played on the passes it is for.
    if (mb.alternateEndings && !(mb.alternateEndings & (1 << pass))) {
      i++;
      continue;
    }
    order.push(i);
    if (mb.repeatCount > 0 && pass + 1 < mb.repeatCount) {
      pass++;
      i = start;
      continue;
    }
    if (mb.repeatCount > 0) {
      pass = 0;
      start = i + 1;
    }
    i++;
  }
  return order;
}

const TICKS_PER_HALF_SIXTEENTH = 120;
/** Lengths (in half sixteenths) the rhythm line can write, longest first, with their letters. */
const LENGTHS: [number, string][] = [
  [32, 'w'],
  [24, 'h.'],
  [16, 'h'],
  [12, 'q.'],
  [8, 'q'],
  [6, 'e.'],
  [4, 'e'],
  [3, 's.'],
  [2, 's'],
  [1, 't'],
];

/** A length as the letters it takes (longest first). */
function pieces(len: number): string[] {
  const out: string[] = [];
  let left = len;
  while (left > 0) {
    const [n, l] = LENGTHS.find(([n]) => n <= left)!;
    out.push(l);
    left -= n;
  }
  return out;
}

interface Event {
  at: number; // half sixteenths from the bar's start
  len: number; // how long it is held, as far as the next event allows
  notes: TNote[];
  reach: number; // the end of the beat, or of the tied notes that carry it on
}

/** The sounding beats of a bar as events on the half-sixteenth grid. */
function barEvents(bar: TBar | undefined, barLen: number, approx: { n: number }): Event[] {
  const voice = bar?.voices.find((v) => v.beats.some((b) => !b.isRest && b.notes.length)) ?? bar?.voices[0];
  const events: Event[] = [];
  for (const b of voice?.beats ?? []) {
    if (b.isRest || !b.notes.length || b.graceType !== 0) continue;
    const exact = b.playbackStart / TICKS_PER_HALF_SIXTEENTH;
    const at = Math.min(barLen - 1, Math.max(0, Math.round(exact)));
    if (Math.abs(exact - at) > 0.01) approx.n++;
    const end = Math.max(at + 1, Math.round((b.playbackStart + b.playbackDuration) / TICKS_PER_HALF_SIXTEENTH));
    const last = events[events.length - 1];
    // Every note is the end of a tie: the sound carries on from before, nothing new is played.
    if (b.notes.every((n) => n.isTieDestination)) {
      if (last) last.reach = Math.max(last.reach, end);
      continue;
    }
    const fresh = b.notes.filter((n) => !n.isTieDestination);
    if (last && last.at === at) {
      last.notes.push(...fresh);
      last.reach = Math.max(last.reach, end);
    } else events.push({ at, len: 0, notes: fresh, reach: end });
  }
  events.forEach((e, i) => {
    const gap = (events[i + 1]?.at ?? barLen) - e.at;
    e.len = Math.max(1, Math.min(gap, e.reach - e.at));
  });
  return events;
}

/** One column of the tab: the text on each string, the rhythm letter(s) at its start and which of its notes are palm muted. */
interface Col {
  cells: string[]; // per string row, top first
  letter: string;
  pm: boolean;
  /** Per string row, the character joining this column to the one before it (h, p, / or \\), or '' for none. */
  link: string[];
}

function fretText(n: TNote): string {
  if (n.isDead) return 'x';
  let t = String(n.fret);
  const bp = n.bendPoints;
  if (bp && bp.length > 1) {
    const peak = Math.max(...bp.map((p) => p.value));
    const first = bp[0].value;
    const last = bp[bp.length - 1].value;
    const up = (v: number) => n.fret + Math.round(v / 2);
    if (peak > 0) {
      if (first >= peak) t = `${n.fret}pb${up(peak)}${last < peak ? `r${up(last)}` : ''}`;
      else t = `${n.fret}b${up(peak)}${last < peak ? `r${up(last)}` : ''}`;
    }
  }
  if (n.harmonicType === 1) t += '(h)';
  else if (n.harmonicType === 2 || n.harmonicType === 3) t += '(ph)';
  if (n.vibrato && !n.slideTarget) t += '~';
  return t;
}

/** The guitar or bass part: blocks of bars as strings, with a rhythm line under each. */
function stringsText(track: TTrack, score: TScore, order: number[], notes: string[]): { text: string; firstNote: number; bars: number } {
  const staff = track.staves[0];
  const strings = staff.tuning.length;
  const labels = strings === 4 ? ['G', 'D', 'A', 'E'] : ['e', 'B', 'G', 'D', 'A', 'E'];
  const approx = { n: 0 };
  const bars: { rows: string[]; pm: string; rhythm: string }[] = [];
  let multiVoice = false;

  for (const bi of order) {
    const mb = score.masterBars[bi];
    const bar = staff.bars[bi];
    if (bar && bar.voices.filter((v) => v.beats.some((b) => !b.isRest && b.notes.length)).length > 1) multiVoice = true;
    const barLen = Math.round(mb.calculateDuration() / TICKS_PER_HALF_SIXTEENTH);
    const events = barEvents(bar, barLen, approx);
    const cols: Col[] = [];
    let cursor = 0;
    const restCol = (len: number) => {
      for (const l of pieces(len)) {
        cols.push({ cells: labels.map(() => '--'), letter: l.toUpperCase(), pm: false, link: labels.map(() => '') });
        cursor += LENGTHS.find(([, x]) => x === l)![0];
      }
    };
    let before: TNote[] = []; // the notes of the event just written
    for (const e of events) {
      if (e.at > cursor) restCol(e.at - cursor);
      const cells = labels.map(() => '');
      const link = labels.map(() => '');
      for (const n of e.notes) {
        const row = strings - n.string;
        if (row < 0 || row >= strings) continue;
        cells[row] = fretText(n);
        // joined to the note before it on this string?
        for (const m of before) {
          if (m.string !== n.string) continue;
          if (n.hammerPullOrigin === m) link[row] = n.fret > m.fret ? 'h' : 'p';
          else if (m.slideTarget === n) link[row] = n.fret > m.fret ? '/' : '\\';
        }
      }
      const [first, ...rest] = pieces(e.len);
      const width = Math.max(...cells.map((c) => c.length));
      cols.push({ cells: cells.map((c) => c.padEnd(width, '-')), letter: first, pm: e.notes.some((n) => n.isPalmMute), link });
      cursor += LENGTHS.find(([, x]) => x === first)![0];
      if (rest.length) restCol(rest.reduce((a, l) => a + LENGTHS.find(([, x]) => x === l)![0], 0));
      before = e.notes;
    }
    if (cursor < barLen) restCol(barLen - cursor);

    // put the columns together: a dash before the first, two between (one where a link character goes), one after the last
    const rows = labels.map(() => '-');
    let rhythm = ' ';
    let pm = ' ';
    let pmOn = false;
    cols.forEach((c, ci) => {
      if (ci > 0) {
        // two dashes between columns; where a hammer, pull or slide joins two notes, the link character is the only thing between
        const linked = c.link.some(Boolean);
        for (let r = 0; r < labels.length; r++) rows[r] += linked ? c.link[r] || '-' : '--';
      }
      const at = rows[0].length;
      for (let r = 0; r < labels.length; r++) rows[r] += c.cells[r];
      const w = c.cells[0].length;
      rhythm = rhythm.padEnd(at) + c.letter;
      if (c.pm) {
        // a palm-mute run: PM at its first note, then dashes for as long as the muted notes carry on
        pm = pmOn ? pm.padEnd(at, '-') + '-'.repeat(w) : pm.padEnd(at, ' ') + 'PM'.padEnd(w, '-');
        pmOn = true;
      } else pmOn = false;
    });
    for (let r = 0; r < labels.length; r++) rows[r] += '-';
    rhythm += ' ';
    pm += ' ';
    bars.push({ rows, pm: pm.trimEnd(), rhythm: rhythm });
  }

  // blocks: as many bars on a line as fit
  const WIDTH = 100;
  const blocks: { rows: string[]; pm: string; rhythm: string; first: number }[] = [];
  let cur: { rows: string[]; pm: string; rhythm: string; first: number } | null = null;
  bars.forEach((b, i) => {
    const w = b.rows[0].length + 1;
    if (!cur || cur.rows[0].length + w > WIDTH) {
      cur = { rows: labels.map((l) => `${l}|`), pm: '  ', rhythm: '  ', first: i };
      blocks.push(cur);
    }
    for (let r = 0; r < labels.length; r++) cur.rows[r] += b.rows[r] + '|';
    cur.pm += b.pm.padEnd(b.rows[0].length, ' ') + ' ';
    cur.rhythm += b.rhythm.padEnd(b.rows[0].length, ' ') + ' ';
  });
  const text = blocks.map((blk) => [...(/PM/.test(blk.pm) ? [blk.pm.trimEnd()] : []), ...blk.rows, blk.rhythm.trimEnd()].join('\n')).join('\n\n');
  if (approx.n) notes.push(`${approx.n} note${approx.n === 1 ? '' : 's'} that don't sit on a sixteenth (triplets, say) were put on the nearest half sixteenth`);
  if (multiVoice) notes.push('some bars have a second voice, which was left out');
  return { text, firstNote: firstNoteOffset(text), bars: bars.length };
}

/** Where the first note is written in a finished tab: the earliest fret (or drum hit) in the first block that has one. */
export function firstNoteOffset(text: string): number {
  let at = 0;
  let best = -1;
  let bestCol = Infinity;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      if (best >= 0) return best;
    } else {
      const label = line.indexOf('|');
      if (label >= 1 && label <= 3 && /^[A-Za-z]+$/.test(line.slice(0, label))) {
        const m = /[0-9xXog]/.exec(line.slice(label + 1));
        const col = m ? label + 1 + m.index : -1;
        if (col >= 0 && col < bestCol) {
          bestCol = col;
          best = at + col;
        }
      }
    }
    at += line.length + 1;
  }
  return Math.max(0, best);
}

// ---------------------------------------------------------------- drums

/** The kit piece (a row of the drum grid) for a General MIDI percussion number, and whether it is an open hi-hat. */
function drumRow(midi: number): { row: string; open?: boolean } | null {
  if ([35, 36].includes(midi)) return { row: 'BD' };
  if ([37, 38, 40].includes(midi)) return { row: 'SD' };
  if ([42, 44].includes(midi)) return { row: 'HH' };
  if (midi === 46) return { row: 'HH', open: true };
  if ([49, 52, 55, 57].includes(midi)) return { row: 'CC' };
  if ([51, 53, 59].includes(midi)) return { row: 'RC' };
  if ([48, 50].includes(midi)) return { row: 'HT' };
  if ([45, 47].includes(midi)) return { row: 'MT' };
  if ([41, 43].includes(midi)) return { row: 'FT' };
  return null;
}
const DRUM_ROWS = ['CC', 'RC', 'HH', 'SD', 'HT', 'MT', 'FT', 'BD'];

function drumsText(track: TTrack, score: TScore, order: number[], notes: string[]): { text: string; firstNote: number; bars: number } {
  const staff = track.staves[0];
  const bars: { sig: string; cols: number; cells: Map<string, string[]> }[] = [];
  let lost = 0;
  let off = 0;
  for (const bi of order) {
    const mb = score.masterBars[bi];
    const cols = Math.max(1, Math.round(mb.calculateDuration() / 240));
    const cells = new Map<string, string[]>();
    for (const r of DRUM_ROWS) cells.set(r, Array(cols).fill('-'));
    const voice = staff.bars[bi]?.voices.find((v) => v.beats.some((b) => !b.isRest && b.notes.length));
    for (const b of voice?.beats ?? []) {
      if (b.isRest || b.graceType !== 0) continue;
      const exact = b.playbackStart / 240;
      const c = Math.min(cols - 1, Math.max(0, Math.round(exact)));
      if (Math.abs(exact - c) > 0.01) off++;
      for (const n of b.notes) {
        const art = track.percussionArticulations?.[n.percussionArticulation];
        const midi = art ? art.outputMidiNumber : n.percussionArticulation;
        const d = drumRow(midi);
        if (!d) {
          lost++;
          continue;
        }
        const ch = d.open ? 'o' : n.isGhost ? 'g' : n.accentuated ? 'X' : 'x';
        cells.get(d.row)![c] = ch;
      }
    }
    bars.push({ sig: `${mb.timeSignatureNumerator}/${mb.timeSignatureDenominator}`, cols, cells });
  }
  // blocks of up to four bars with the same time signature (the line above the grid fixes each bar's length)
  const used = DRUM_ROWS.filter((r) => bars.some((b) => b.cells.get(r)!.some((c) => c !== '-')));
  const rowsOut = used.length ? used : ['HH', 'SD', 'BD'];
  let text = '';
  for (let i = 0; i < bars.length; ) {
    let j = i;
    while (j < bars.length && j - i < 4 && bars[j].sig === bars[i].sig) j++;
    const lines = [bars[i].sig, ...rowsOut.map((r) => `${r}|${bars.slice(i, j).map((b) => (b.cells.get(r) ?? Array(b.cols).fill('-')).join('')).join('|')}|`)];
    text += lines.join('\n') + '\n\n';
    i = j;
  }
  text = text.trimEnd();
  if (lost) notes.push(`${lost} hit${lost === 1 ? '' : 's'} on instruments the drum grid doesn't have were left out`);
  if (off) notes.push(`${off} hit${off === 1 ? '' : 's'} not on a sixteenth were moved to the nearest one`);
  return { text, firstNote: firstNoteOffset(text), bars: bars.length };
}

/** The tab text for one track of a score. */
export function scoreToTab(score: TScore, trackIndex: number, order: number[] = playOrder(score.masterBars)): Imported {
  const info = listTracks(score)[trackIndex];
  if (!info) throw new Error('That track is not in the file.');
  if (!info.part) throw new Error(`"${info.name}" has ${info.strings} strings: the tab editor takes 4 (bass) or 6 (guitar) strings, or drums.`);
  const notes: string[] = [];
  const out = info.part === 'drums' ? drumsText(score.tracks[trackIndex], score, order, notes) : stringsText(score.tracks[trackIndex], score, order, notes);
  if (!out.text.trim()) throw new Error(`"${info.name}" has no notes.`);
  return { part: info.part, text: out.text, firstNote: out.firstNote, bars: out.bars, tempo: score.tempo, title: score.title ?? '', notes };
}
