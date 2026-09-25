// Song library: separated stems kept in the browser's private file storage
// (OPFS), so songs reopen without separating them again.
// Layout: library/<id>/meta.json + library/<id>/<stem>.flac (16-bit FLAC).

import { background as encoder } from './encode/client.ts';
import type { Stereo } from './engine/separate.ts';
import type { Settings } from './settings.ts';
import type { KeyResult } from './analysis/key.ts';

export interface Analysis {
  bpm: number;
  beats: number[]; // seconds
  downbeat: number;
  key?: KeyResult;
}

export interface TakeMeta {
  id: string; // display id within its group, e.g. "take-1" — not unique across groups on its own
  scale: number;
  note?: string;
}

/** One recorded source (e.g. "Bass", "Guitar") and every take made for it. `id` is an internal,
 * stable, never-shown key: takes are stored as `<groupId>-<takeId>.flac`, since two groups could
 * otherwise both produce a "take-1" and collide in the same song folder. The group's own display
 * name is just its lane's `label`, saved the same way any other track's rename already is. */
export interface TakeGroupMeta {
  id: string;
  takes: TakeMeta[];
  activeTake?: string;
}

export interface LibMeta {
  id: string;
  title: string;
  seconds: number;
  took?: number;
  created: number;
  settings: Settings;
  kind?: 'separated' | 'multitrack';
  stems: { name: string; scale: number }[];
  bytes: number;
  analysis?: Analysis;
  state?: unknown; // player state (mixer, EQ, loop, practice), owned by the deck
  /** Live-recorded takes (see the Live input drawer), saved as extra files alongside the stems. */
  takeGroups?: TakeGroupMeta[];
}

export const libraryAvailable = () => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

async function libRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('library', { create: true });
}

export async function listSongs(): Promise<LibMeta[]> {
  if (!libraryAvailable()) return [];
  const out: LibMeta[] = [];
  const lib = await libRoot();
  for await (const [name, handle] of (lib as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (handle.kind !== 'directory') continue;
    try {
      const f = await (await (handle as FileSystemDirectoryHandle).getFileHandle('meta.json')).getFile();
      out.push({ ...JSON.parse(await f.text()), id: name });
    } catch {
      // No meta.json: an interrupted save. Clean it up.
      await lib.removeEntry(name, { recursive: true }).catch(() => {});
    }
  }
  return out.sort((a, b) => b.created - a.created);
}

/** Track names become file names in the library, so keep them safe and unique. */
function safeStemNames<T extends { name: string }>(stems: T[]): T[] {
  const seen = new Map<string, number>();
  return stems.map((s) => {
    let name = s.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'track';
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) name = `${name} (${n})`;
    return { ...s, name };
  });
}

export async function saveSong(meta: Omit<LibMeta, 'bytes' | 'stems' | 'id'>, stems: { name: string; data: Stereo }[], onProgress?: (done: number, total: number) => void): Promise<LibMeta> {
  const id = `${new Date(meta.created).toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  // 16-bit storage: scale down any stem that peaks above full scale, and undo it on load.
  const withScale = safeStemNames(stems).map((s) => {
    let peak = 0;
    for (const c of s.data) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
    return { ...s, scale: peak > 0.999 ? 0.999 / peak : 1 };
  });
  const full: LibMeta = { ...meta, id, bytes: 0, stems: withScale.map((s) => ({ name: s.name, scale: s.scale })) };
  full.bytes = await encoder.run<number>({ type: 'lib-save', dir: id, meta: JSON.stringify(full), stems: withScale }, undefined, onProgress);
  return full;
}

export async function writeMeta(meta: LibMeta) {
  await encoder.run({ type: 'lib-meta', dir: meta.id, meta: JSON.stringify(meta) });
}

export async function loadStems(meta: LibMeta): Promise<{ name: string; data: Stereo }[]> {
  const dir = await (await libRoot()).getDirectoryHandle(meta.id);
  const ctx = new OfflineAudioContext(2, 1, 44100);
  const out: { name: string; data: Stereo }[] = [];
  for (const s of meta.stems) {
    const file = await (await dir.getFileHandle(`${s.name}.flac`)).getFile();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const k = 1 / s.scale;
    const ch = (i: number) => {
      const a = buf.getChannelData(Math.min(i, buf.numberOfChannels - 1)).slice();
      if (k !== 1) for (let j = 0; j < a.length; j++) a[j] *= k;
      return a;
    };
    out.push({ name: s.name, data: [ch(0), ch(1)] });
  }
  return out;
}

export async function deleteSong(id: string) {
  await (await libRoot()).removeEntry(id, { recursive: true });
}

/** Adds one take's audio as a new file in an already-saved song's folder, and updates its meta.json (bumping `meta.takeGroups` first is the caller's job, same as the rest of LibMeta). */
export async function addTake(meta: LibMeta, groupId: string, take: { id: string; data: Stereo; note?: string }): Promise<TakeMeta> {
  let peak = 0;
  for (const c of take.data) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  const scale = peak > 0.999 ? 0.999 / peak : 1;
  await encoder.run({ type: 'lib-add-file', dir: meta.id, name: `${groupId}-${take.id}`, data: take.data, scale, meta: JSON.stringify(meta) });
  return { id: take.id, scale, note: take.note };
}

/** Removes one take's audio file from a song's folder. Caller updates `meta.takeGroups` first. */
export async function removeTake(meta: LibMeta, groupId: string, takeId: string) {
  await encoder.run({ type: 'lib-remove-file', dir: meta.id, name: `${groupId}-${takeId}`, meta: JSON.stringify(meta) });
}

export async function loadTake(songId: string, groupId: string, take: TakeMeta): Promise<Stereo> {
  const dir = await (await libRoot()).getDirectoryHandle(songId);
  const ctx = new OfflineAudioContext(2, 1, 44100);
  const file = await (await dir.getFileHandle(`${groupId}-${take.id}.flac`)).getFile();
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  const k = 1 / take.scale;
  const ch = (i: number) => {
    const a = buf.getChannelData(Math.min(i, buf.numberOfChannels - 1)).slice();
    if (k !== 1) for (let j = 0; j < a.length; j++) a[j] *= k;
    return a;
  };
  return [ch(0), ch(1)];
}

/** Zips the whole library (as stored: FLAC stems + meta.json per song) for backup. */
export function exportLibrary(onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  return encoder.run<Uint8Array>({ type: 'lib-export' }, undefined, onProgress);
}

/** Restores songs from a backup zip. Songs already in the library (same id) are left alone. */
export function importLibrary(zip: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<{ imported: number; skipped: number }> {
  return encoder.run<{ imported: number; skipped: number }>({ type: 'lib-import', zip }, undefined, onProgress);
}
