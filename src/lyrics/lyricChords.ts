// Chords over synced lyrics: where in a line of words each chord change falls. Lyrics are timed by line, not by word, so a chord's place
// in the line is worked out from its time: how far through the line's singing it falls, snapped to the start of the nearest word.
// Pure functions, no browser needed.

/** A chord (already named for display) starting at a time, in seconds. */
export interface ChordMark {
  t: number;
  name: string;
}

/** A piece of a lyric line: some words, with the chord (if any) that starts over them. */
export interface Segment {
  chord?: string;
  /** When the chord starts (seconds), to highlight it while it sounds. */
  t?: number;
  text: string;
}

/**
 * About how long a line takes to sing. A line followed by a short gap is taken to be sung across all of it (songs run on from line to
 * line); after a long gap (an instrumental break) it is sung at about six characters a second and the rest is the break.
 */
export function sungSeconds(text: string, gap: number): number {
  return gap <= 7 ? gap : Math.min(gap, Math.max(2, text.length * 0.15));
}

/** The start of the word nearest to `idx` (an earlier word start wins a tie); 0 or the text's length stay as they are. */
export function snapToWord(text: string, idx: number): number {
  if (idx <= 0) return 0;
  if (idx >= text.length) return text.length;
  if (text[idx - 1] === ' ') return idx;
  const prev = text.lastIndexOf(' ', idx - 1) + 1;
  const nextSpace = text.indexOf(' ', idx);
  const next = nextSpace < 0 ? text.length : nextSpace + 1;
  return idx - prev <= next - idx ? prev : next;
}

/**
 * Splits one lyric line into segments with the chords placed over the words. `t0` is when the line starts and `next` when the following
 * line does (Infinity for the last); `marks` are the chords that apply during the line, including the one already sounding at `t0`.
 * Two chords landing on the same word are shown together; a chord repeated straight after itself is shown once.
 */
export function segmentsFor(text: string, t0: number, next: number, marks: ChordMark[]): Segment[] {
  const sung = sungSeconds(text, next - t0);
  const t1 = t0 + Math.max(0.5, sung);
  const placed: { idx: number; names: string[]; t: number }[] = [];
  let last = '';
  for (const m of [...marks].sort((a, b) => a.t - b.t)) {
    if (m.t >= next || m.name === last) continue;
    last = m.name;
    const frac = Math.max(0, Math.min(1, (m.t - t0) / (t1 - t0)));
    const idx = snapToWord(text, Math.round(frac * text.length));
    const at = placed[placed.length - 1];
    if (at && at.idx === idx) at.names.push(m.name);
    else placed.push({ idx, names: [m.name], t: m.t });
  }
  if (!placed.length) return [{ text }];
  const out: Segment[] = [];
  if (placed[0].idx > 0) out.push({ text: text.slice(0, placed[0].idx) });
  placed.forEach((p, i) => {
    const end = i + 1 < placed.length ? placed[i + 1].idx : text.length;
    out.push({ chord: p.names.join(' '), t: p.t, text: text.slice(p.idx, end) });
  });
  return out;
}
