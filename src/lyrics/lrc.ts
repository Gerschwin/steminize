// Synced lyrics in the common LRC format: "[mm:ss.xx] words", one or more timestamps per line, plus
// optional tags such as [ti:...] or [offset:+500]. Pure functions, no browser needed.

export interface LrcLine {
  /** Seconds into the song. */
  t: number;
  text: string;
}

export interface Lrc {
  lines: LrcLine[];
}

/** Fewer timed lines than this and the text is treated as plain lyrics that happen to contain brackets. */
const MIN_TIMED_LINES = 3;

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] (also "mm:ss:xx" in the wild) and [h:mm:ss.xx].
const STAMP = /\[(?:(\d+):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/im;
// Word-level ("enhanced") timing: <mm:ss.xx> inside a line. We follow lines, not words, so drop them.
const WORD_STAMP = /<\d+:\d{2}(?:[.:]\d{1,3})?>/g;

function seconds(h: string | undefined, m: string, s: string, frac: string | undefined): number {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0);
}

/** Parses LRC text, or returns null if it doesn't have enough timestamped lines to be one. */
export function parseLrc(text: string): Lrc | null {
  // A positive [offset:] means the lyrics should show that much sooner.
  const offset = Number(OFFSET.exec(text)?.[1] ?? 0) / 1000;
  const lines: LrcLine[] = [];
  let timed = 0;
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(STAMP)];
    if (!stamps.length) continue;
    const words = raw.replace(STAMP, '').replace(WORD_STAMP, '').trim();
    timed++;
    for (const m of stamps) lines.push({ t: Math.max(0, seconds(m[1], m[2], m[3], m[4]) - offset), text: words });
  }
  if (timed < MIN_TIMED_LINES) return null;
  // A line with several timestamps (a repeated chorus) appears at each; keep equal times in file order.
  return { lines: lines.map((l, i) => ({ l, i })).sort((a, b) => a.l.t - b.l.t || a.i - b.i).map((x) => x.l) };
}

/** Index of the line being sung at time `t` (the last one that has started), or -1 before the first. */
export function lineAt(lines: LrcLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
