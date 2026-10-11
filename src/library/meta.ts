// Reading a song's meta.json. The file was written by whichever version of the app saved the song, so it is read defensively: a field
// that is missing gets a sensible default, a field that is the wrong shape is dropped, a field this version has never heard of is
// kept as it is (so saving never loses what a newer version wrote), and a file that is not usable at all gives null, which means
// "skip this one song", never "fail to list the library". See DATA_FORMAT.md for what the fields are and the rules for changing them.

import { DEFAULTS } from '../settings.ts';
import type { LibMeta } from '../library.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The song described by a meta.json, or null if the file isn't usable (not JSON, not an object, or no playable stems). */
export function parseMeta(id: string, raw: string): LibMeta | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  const stems = (Array.isArray(j.stems) ? j.stems : [])
    .filter((s): s is { name: string; scale?: number } => isObj(s) && typeof s.name === 'string' && s.name !== '')
    .map((s) => ({ name: s.name, scale: typeof s.scale === 'number' && s.scale > 0 ? s.scale : 1 }));
  if (!stems.length) return null;

  const out: Record<string, unknown> = { ...j };
  out.id = id; // the folder name is the truth, whatever the file says
  out.title = typeof j.title === 'string' && j.title.trim() ? j.title : 'Untitled';
  out.seconds = Math.max(0, num(j.seconds, 0));
  out.created = num(j.created, 0);
  out.bytes = Math.max(0, num(j.bytes, 0));
  out.stems = stems;
  out.settings = isObj(j.settings) ? { ...DEFAULTS, ...j.settings } : { ...DEFAULTS };
  if (j.kind !== 'separated' && j.kind !== 'multitrack') delete out.kind;
  if (j.took !== undefined && typeof j.took !== 'number') delete out.took;

  const a = j.analysis;
  if (isObj(a) && typeof a.bpm === 'number' && Array.isArray(a.beats) && a.beats.every((b) => typeof b === 'number')) {
    out.analysis = { ...a, downbeat: num(a.downbeat, 0) };
  } else delete out.analysis;

  if (Array.isArray(j.takeGroups)) {
    out.takeGroups = j.takeGroups
      .filter((g): g is Record<string, unknown> => isObj(g) && typeof g.id === 'string' && Array.isArray(g.takes))
      .map((g) => ({ ...g, takes: (g.takes as unknown[]).filter((t): t is Record<string, unknown> => isObj(t) && typeof t.id === 'string').map((t) => ({ ...t, scale: typeof t.scale === 'number' && t.scale > 0 ? t.scale : 1 })) }));
  } else delete out.takeGroups;
  if (out.state !== undefined && !isObj(out.state)) delete out.state;
  return out as unknown as LibMeta;
}
