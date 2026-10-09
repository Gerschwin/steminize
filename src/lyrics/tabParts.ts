// Scratchpad parts: a song's tabs are kept per instrument (Guitar, Bass, Drums), each linked to the track it is the music for.
// This holds the logic that needs no browser: which track a part is linked to by default, and which part an old single tab belongs to.

import { tabBlocks } from './tabSync.ts';

/** 'guitar', 'bass' and 'drums' are always there; any others are parts the user added (second guitar, keys, …). */
export type PartId = string;
/** The parts that use the engraved-tab editor: everything except the drums, which keeps its own plain-text grid. */
export type TabPartId = string;

export const PART_IDS: PartId[] = ['guitar', 'bass', 'drums'];
export const DEFAULT_PART_NAMES: Record<string, string> = { guitar: 'Guitar', bass: 'Bass', drums: 'Drums' };

/** A part the user added. */
export interface ExtraPart {
  id: string;
  name: string;
}

export const isBuiltinPart = (id: PartId) => PART_IDS.includes(id);
export const partKind = (id: PartId): 'tab' | 'drums' => (id === 'drums' ? 'drums' : 'tab');

/** An id for a new part that no part has yet. */
export function newPartId(existing: ExtraPart[]): string {
  let n = existing.length + 1;
  while (existing.some((p) => p.id === `part${n}`)) n++;
  return `part${n}`;
}

/** The ScratchState fields that belong to whichever tab part is open: swapped in and out when you change part. */
export const TAB_FIELDS = ['tab', 'tabAnchors', 'tabFollow', 'tabStaff', 'tabTrainer', 'tabEar', 'tabBarScores'] as const;

/**
 * The track a part is linked to when nothing was chosen, matched by name: multitrack files are named after their parts
 * ("Lead Guitar", "Bass DI"), and a Demucs split has no guitar track of its own (guitar ends up in "other", unless it
 * is the 6-stem model, which has one). Returns the track's name, or undefined when nothing fits.
 */
export function defaultTrack(part: PartId, trackNames: string[], partName = ''): string | undefined {
  // A part the user added links only to a track that has exactly its name (a part called "Piano" and a track called "piano");
  // guessing further would link a second guitar to the first one's track.
  if (!isBuiltinPart(part)) return trackNames.find((n) => partName.trim() !== '' && n.trim().toLowerCase() === partName.trim().toLowerCase());
  const find = (want: RegExp, not?: RegExp) => trackNames.find((n) => want.test(n) && !(not && not.test(n)));
  if (part === 'bass') return find(/bass/i, /drum/i);
  if (part === 'drums') return find(/drum|kit|perc/i);
  return find(/guitar|gtr/i) ?? trackNames.find((n) => n.trim().toLowerCase() === 'other');
}

/** How many strings the first tab in the text has (0 when there is none). */
export function stringCount(text: string): number {
  const b = tabBlocks(text)[0];
  const n = b ? b.stringLast - b.stringFirst + 1 : 0;
  return n >= 2 ? n : 0; // a lone line of text isn't a tab
}

/** Which part an existing single tab (from before parts existed) belongs to: a four-string tab is a bass line, anything else guitar. */
export function legacyTabPart(text: string | undefined): TabPartId {
  return text && stringCount(text) === 4 ? 'bass' : 'guitar';
}
