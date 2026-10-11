// Library storage backed by the browser's private file storage (OPFS). Reads happen right here on the
// main thread (matching how they always have); writes go through the background encode worker, since
// OPFS's fast write path (sync access handles) only works inside a worker in every browser this app
// supports (see the comment on writeFile in encode/worker.ts).
import { background as encoder } from '../encode/client.ts';
import type { LibraryBackend } from './backend.ts';
import { canCleanIncompleteSong } from './safety.ts';

export const opfsAvailable = () => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

async function libRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('library', { create: true });
}

async function songDir(id: string, create = false) {
  return (await libRoot()).getDirectoryHandle(id, { create });
}

export const opfsBackend: LibraryBackend = {
  async list() {
    const lib = await libRoot();
    const out: { id: string; meta: string }[] = [];
    for await (const [name, handle] of (lib as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (handle.kind !== 'directory') continue;
      const dir = handle as FileSystemDirectoryHandle;
      try {
        const f = await (await dir.getFileHandle('meta.json')).getFile();
        out.push({ id: name, meta: await f.text() });
      } catch (e) {
        // No meta.json: normally an interrupted save (see the ordering note on writeMeta), but never delete on a hunch. It is only
        // cleaned up when the file is definitely missing and the folder has sat untouched for a day; an unreadable file, or a save in
        // progress right now, is left alone (and simply not listed).
        const missing = (e as DOMException)?.name === 'NotFoundError';
        let newest: number | null = null;
        if (missing) {
          try {
            for await (const [, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
              if (h.kind !== 'file') continue;
              const t = (await (h as FileSystemFileHandle).getFile()).lastModified;
              newest = newest == null ? t : Math.max(newest, t);
            }
          } catch {
            newest = null;
          }
        }
        if (canCleanIncompleteSong(missing ? 'missing' : 'unreadable', newest, Date.now())) await lib.removeEntry(name, { recursive: true }).catch(() => {});
      }
    }
    return out;
  },

  async writeMeta(id, meta) {
    await encoder.run({ type: 'opfs-write', dir: id, name: 'meta.json', bytes: new TextEncoder().encode(meta) });
  },

  writeFile(id, name, bytes) {
    return encoder.run<number>({ type: 'opfs-write', dir: id, name, bytes });
  },

  async readFile(id, name) {
    const file = await (await (await songDir(id)).getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  },

  async listFiles(id) {
    const dir = await songDir(id);
    const out: string[] = [];
    for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) if (h.kind === 'file') out.push(name);
    return out;
  },

  async removeFile(id, name) {
    await (await songDir(id)).removeEntry(name).catch(() => {});
  },

  async deleteSong(id) {
    await (await libRoot()).removeEntry(id, { recursive: true });
  },

  async freeSpace() {
    try {
      const e = await navigator.storage?.estimate?.();
      return e?.quota !== undefined && e.usage !== undefined ? Math.max(0, e.quota - e.usage) : null;
    } catch {
      return null;
    }
  },
};
