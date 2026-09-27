/// <reference lib="webworker" />
// Background worker for everything heavy that isn't the model: encoding
// stems and mixes, saving songs to the library, and tempo/beat analysis.

import { zipSync, unzipSync } from 'fflate';
import { encodeAudio, type OutputOptions } from './index.ts';
import { encodeFlac } from './flac.ts';
import { renderMix, type Stereo } from '../player/mixcore.ts';
import type { EqParams } from '../player/eq.ts';
import { analyse } from '../analysis/beats.ts';
import { detectKey, rankKeys } from '../analysis/key.ts';
import { cqt } from '../analysis/cqt.ts';

export type EncodeReq =
  | { type: 'stems'; id: number; stems: { name: string; data: Stereo }[]; out: OutputOptions }
  | {
      type: 'mix';
      id: number;
      name: string;
      stems: Stereo[];
      gains: number[];
      pans?: number[];
      eqs?: (EqParams | undefined)[];
      start: number;
      end: number;
      tempo: number;
      pitch: number;
      out: OutputOptions;
    }
  /** Peak-scales and FLAC-encodes stems for the library (either backend): posted back one 'file' at a
   * time as each finishes, same as 'stems', but 16-bit with the library's own scale-to-fit step. */
  | { type: 'lib-encode'; id: number; stems: { name: string; data: Stereo; scale: number }[] }
  /** Writes one file into the OPFS library (the write path needs a worker: see writeFile below).
   * The native (Tauri) library backend writes directly from the main thread instead — see
   * src/library/nativeBackend.ts — since a worker has no access to Tauri's IPC bridge. */
  | { type: 'opfs-write'; id: number; dir: string; name: string; bytes: Uint8Array }
  /** Zips a flat {path: bytes} map (backup export); level 0 since the audio inside is already compressed. */
  | { type: 'zip'; id: number; files: Record<string, Uint8Array> }
  /** The reverse of 'zip', for restoring a backup. */
  | { type: 'unzip'; id: number; zip: Uint8Array }
  | { type: 'beats'; id: number; mono: Float32Array; harmonic?: Float32Array }
  | { type: 'keys'; id: number; harmonic: Float32Array }
  /** Note energy per semitone over time, for the note view and chords. */
  | { type: 'cqt'; id: number; mono: Float32Array };

export type EncodeRes =
  | { id: number; type: 'file'; name: string; bytes: Uint8Array }
  | { id: number; type: 'progress'; done: number; total: number }
  | { id: number; type: 'result'; value: unknown }
  | { id: number; type: 'done' }
  | { id: number; type: 'error'; message: string };

const post = (m: EncodeRes, t: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, t);

async function libDir(name: string) {
  const root = await navigator.storage.getDirectory();
  const lib = await root.getDirectoryHandle('library', { create: true });
  return lib.getDirectoryHandle(name, { create: true });
}

/** Writes one file into OPFS. This has to run in a worker: sync access handles (the fast path
 * below) are worker-only in every browser this app supports. */
async function writeFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) {
  const fh = await dir.getFileHandle(name, { create: true });
  // Sync access handles work in every browser with OPFS (Safari has no createWritable).
  if ('createSyncAccessHandle' in fh) {
    const h = await (fh as any).createSyncAccessHandle();
    try {
      h.truncate(0);
      h.write(bytes, { at: 0 });
      h.flush();
    } finally {
      h.close();
    }
  } else {
    const w = await (fh as any).createWritable();
    await w.write(bytes);
    await w.close();
  }
  return bytes.length;
}

async function handle(m: EncodeReq) {
  if (m.type === 'stems') {
    for (const s of m.stems) {
      const bytes = encodeAudio(s.data, m.out);
      post({ id: m.id, type: 'file', name: s.name, bytes }, [bytes.buffer as ArrayBuffer]);
    }
  } else if (m.type === 'mix') {
    const mix = renderMix(m.stems, m.gains, m.start, m.end, m.tempo, m.pitch, m.pans, m.eqs);
    const bytes = encodeAudio(mix, m.out);
    post({ id: m.id, type: 'file', name: m.name, bytes }, [bytes.buffer as ArrayBuffer]);
  } else if (m.type === 'lib-encode') {
    for (let i = 0; i < m.stems.length; i++) {
      const s = m.stems[i];
      const scaled: Stereo = s.scale === 1 ? s.data : [s.data[0].map((v) => v * s.scale), s.data[1].map((v) => v * s.scale)];
      const bytes = encodeFlac(scaled, 16, 44100);
      post({ id: m.id, type: 'file', name: s.name, bytes }, [bytes.buffer as ArrayBuffer]);
      post({ id: m.id, type: 'progress', done: i + 1, total: m.stems.length });
    }
  } else if (m.type === 'opfs-write') {
    const total = await writeFile(await libDir(m.dir), m.name, m.bytes);
    post({ id: m.id, type: 'result', value: total });
  } else if (m.type === 'zip') {
    const zipped = zipSync(m.files, { level: 0 });
    post({ id: m.id, type: 'result', value: zipped }, [zipped.buffer as ArrayBuffer]);
  } else if (m.type === 'unzip') {
    post({ id: m.id, type: 'result', value: unzipSync(m.zip) });
  } else if (m.type === 'cqt') {
    const c = cqt(m.mono);
    post({ id: m.id, type: 'result', value: c }, [c.data.buffer as ArrayBuffer]);
  } else if (m.type === 'keys') {
    post({ id: m.id, type: 'result', value: rankKeys(m.harmonic).slice(0, 6) });
  } else if (m.type === 'beats') {
    const a = analyse(m.mono);
    const key = m.harmonic ? detectKey(m.harmonic) : undefined;
    post({ id: m.id, type: 'result', value: { bpm: a.bpm, beats: a.beats, downbeat: a.downbeat, key, env: a.env, low: a.low } }, [
      a.env.buffer as ArrayBuffer,
      a.low.buffer as ArrayBuffer,
    ]);
  }
}

// Requests run one at a time, in order.
let chain = Promise.resolve();
self.onmessage = (e: MessageEvent<EncodeReq>) => {
  const m = e.data;
  chain = chain.then(async () => {
    try {
      await handle(m);
      post({ id: m.id, type: 'done' });
    } catch (err) {
      post({ id: m.id, type: 'error', message: String((err as Error)?.message ?? err) });
    }
  });
};
