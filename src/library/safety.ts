// Small rules that keep a library safe: not starting to save a song to a full disk, and reminding you to back up. Pure, so they
// can be tested.

/** About how much disk a song's stems need once stored (16-bit FLAC): the audio's size times a safety margin. */
export function spaceNeeded(seconds: number, stems: number): number {
  return Math.round(seconds * 44100 * 2 * stems * 1.3);
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** 'ok', 'low' (will fit, but not by much: say so) or 'full' (will not fit: don't start). `free` null means unknown, which is fine. */
export function spaceStatus(free: number | null, needed: number): 'ok' | 'low' | 'full' {
  if (free === null) return 'ok';
  if (free < needed + 100 * MB) return 'full';
  if (free < needed * 2 + 1 * GB) return 'low';
  return 'ok';
}

export function fmtBytes(n: number): string {
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(n / MB))} MB`;
}

const DAY = 24 * 60 * 60 * 1000;

/** The line shown under the library: when it was last backed up, and whether that is worth a nudge. `last` is a time in ms, or null if never. */
export function backupNote(last: number | null, now: number, songs: number): { text: string; stale: boolean } | null {
  if (songs === 0) return null;
  if (last === null) return { text: 'Not backed up yet: Back up… saves everything to one file.', stale: true };
  const days = Math.floor((now - last) / DAY);
  if (days <= 0) return { text: 'Backed up today.', stale: false };
  if (days === 1) return { text: 'Last backed up yesterday.', stale: false };
  return { text: `Last backed up ${days} days ago.`, stale: days >= 30 };
}
