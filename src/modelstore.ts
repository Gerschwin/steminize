// Stores downloaded model files in the browser's Cache Storage so the app
// works offline after the first download. Falls back to memory if the
// Cache API is unavailable (e.g. some private-browsing modes).

import { downloadResumable, keptBytes, type PartStore } from './modelDownload.ts';
import type { ModelFile } from './models.ts';

const CACHE = 'steminize-models-v1';
const memory = new Map<string, ArrayBuffer>();
const hasCaches = () => typeof caches !== 'undefined';

async function open() {
  return caches.open(CACHE);
}

export async function hasModel(f: ModelFile): Promise<boolean> {
  if (memory.has(f.key)) return true;
  if (!hasCaches()) return false;
  try {
    return !!(await (await open()).match(f.url));
  } catch {
    return false;
  }
}

export async function getModelBytes(f: ModelFile): Promise<ArrayBuffer | null> {
  const m = memory.get(f.key);
  if (m) return m.slice(0);
  if (!hasCaches()) return null;
  const res = await (await open()).match(f.url);
  return res ? res.arrayBuffer() : null;
}

async function store(f: ModelFile, body: ReadableStream<Uint8Array> | Blob, size: number) {
  if (hasCaches()) {
    try {
      const res = new Response(body, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
      });
      await (await open()).put(f.url, res);
      requestPersistence();
      return;
    } catch (e) {
      if (!(body instanceof Blob)) throw e;
    }
  }
  memory.set(f.key, await new Response(body).arrayBuffer());
}

/** Where the unfinished parts of a model download are kept: next to the finished models, under part keys. */
function partStore(f: ModelFile): PartStore {
  // A query string, not a #fragment: Cache Storage ignores fragments when matching, so every part would match the first.
  const key = (i: number) => `${f.url}${f.url.includes('?') ? '&' : '?'}steminize-part=${String(i).padStart(4, '0')}`;
  return {
    async sizes() {
      const c = await open();
      const out: number[] = [];
      for (let i = 0; ; i++) {
        const r = await c.match(key(i));
        if (!r) return out;
        out.push(Number(r.headers.get('content-length')) || (await r.blob()).size);
      }
    },
    async put(i, data) {
      await (await open()).put(key(i), new Response(data, { headers: { 'content-length': String(data.size) } }));
    },
    async blobs() {
      const c = await open();
      const out: Blob[] = [];
      for (let i = 0; ; i++) {
        const r = await c.match(key(i));
        if (!r) return out;
        out.push(await r.blob());
      }
    },
    async clear() {
      const c = await open();
      for (let i = 0; await c.delete(key(i)); i++);
    },
  };
}

/** How much of this file has been downloaded but not finished (kept so the download can carry on). */
export async function partialBytes(f: ModelFile): Promise<number> {
  if (!hasCaches()) return 0;
  try {
    return await keptBytes(partStore(f));
  } catch {
    return 0;
  }
}

/**
 * Downloads a model file. A stop or a lost connection keeps what has arrived, and the next call carries on from there. The
 * progress it reports counts the bytes already kept. Without Cache Storage it can't keep parts, so it just downloads in memory.
 */
export async function downloadModel(
  f: ModelFile,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
) {
  if (!hasCaches()) {
    const res = await fetch(f.url, { signal, mode: 'cors' });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${f.key}`);
    const total = Number(res.headers.get('content-length')) || f.bytes;
    let loaded = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        loaded += chunk.byteLength;
        onProgress(loaded, total);
        ctl.enqueue(chunk);
      },
    });
    memory.set(f.key, await new Response(res.body.pipeThrough(counter)).arrayBuffer());
    return;
  }
  const parts = partStore(f);
  try {
    const blob = await downloadResumable({ url: f.url, parts, expected: f.bytes, onProgress, signal });
    await store(f, blob, blob.size);
    await parts.clear();
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(`${(e as Error).message} (${f.key}). What arrived is kept, so trying again carries on from there.`);
  }
}

/** Use a model file the user downloaded manually. */
export async function importModel(f: ModelFile, file: File) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (file.size < 1024 * 1024 || head[0] !== 0x08) throw new Error(`${file.name} does not look like an ONNX model`);
  await store(f, file, file.size);
}

export async function deleteModel(f: ModelFile) {
  memory.delete(f.key);
  if (hasCaches()) {
    await (await open()).delete(f.url);
    await partStore(f).clear();
  }
}

let persistAsked = false;
function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}
