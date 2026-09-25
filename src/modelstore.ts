// Stores downloaded model files in the browser's Cache Storage so the app
// works offline after the first download. Falls back to memory if the
// Cache API is unavailable (e.g. some private-browsing modes).

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

export async function downloadModel(
  f: ModelFile,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
) {
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
  const body = res.body.pipeThrough(counter);
  if (hasCaches()) await store(f, body, total);
  else memory.set(f.key, await new Response(body).arrayBuffer());
  if (loaded < 1024 * 1024) {
    await deleteModel(f);
    throw new Error(`Download of ${f.key} looks incomplete`);
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
  if (hasCaches()) await (await open()).delete(f.url);
}

let persistAsked = false;
function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}
