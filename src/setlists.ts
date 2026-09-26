// Setlists: named, ordered lists of library songs for a rehearsal or gig. Only the order and two playback
// choices live here; each song keeps its own tempo, pitch, loop, mixer and lyrics in the library, and
// reopening it restores them.

export interface Setlist {
  id: string;
  name: string;
  /** Library song ids, in playing order. */
  songs: string[];
  /** Move on to the next song by itself when one finishes. */
  auto: boolean;
  /** Seconds of silence between songs when moving on automatically. */
  gap: number;
}

export const GAPS = [0, 2, 5, 10];
const KEY = 'steminize.setlists.v1';

/** Tolerant of anything that has been in storage: drops what isn't a usable setlist instead of throwing. */
export function parseSetlists(json: string | null): Setlist[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Setlist[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.songs)) continue;
    out.push({
      id: r.id,
      name: r.name.slice(0, 80) || 'Setlist',
      songs: [...new Set(r.songs.filter((s): s is string => typeof s === 'string'))],
      auto: r.auto !== false,
      gap: GAPS.includes(r.gap as number) ? (r.gap as number) : 2,
    });
  }
  return out;
}

export function loadSetlists(): Setlist[] {
  try {
    return parseSetlists(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function saveSetlists(lists: Setlist[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lists));
  } catch {
    /* storage unavailable: the setlist just won't outlive this session */
  }
}

export function newSetlist(name: string): Setlist {
  return { id: Math.random().toString(36).slice(2, 10), name, songs: [], auto: true, gap: 2 };
}

/** "Setlist", then "Setlist 2", "Setlist 3"... skipping names already used. */
export function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** A copy of `items` with the entry at `from` moved to `to`. Out-of-range moves change nothing. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items.slice();
  const out = items.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/** The index after `i`, or null when `i` is the last song. */
export const nextSong = (i: number, length: number): number | null => (i >= 0 && i + 1 < length ? i + 1 : null);

/** The index before `i` (staying on the first song at the start). */
export const prevSong = (i: number): number => Math.max(0, i - 1);

/** Drops songs that are no longer in the library. Returns the same object when nothing changed. */
export function pruneSongs(list: Setlist, existing: ReadonlySet<string>): Setlist {
  const songs = list.songs.filter((id) => existing.has(id));
  return songs.length === list.songs.length ? list : { ...list, songs };
}

export function totalSeconds(list: Setlist, seconds: (id: string) => number | undefined): number {
  return list.songs.reduce((sum, id) => sum + (seconds(id) ?? 0), 0);
}
