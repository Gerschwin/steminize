// Saving files: native dialogs in the desktop app, downloads / folder picker on the web.
import { zipSync } from 'fflate';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface Sink {
  write(name: string, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

function download(name: string, bytes: Uint8Array | Blob, mime = 'application/octet-stream') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Save one file. Returns false if the user cancelled. */
export async function saveFile(name: string, bytes: Uint8Array, mime: string): Promise<boolean> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: name });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  download(name, bytes, mime);
  return true;
}

/**
 * Where to put several files. Call straight from a click handler: the folder
 * picker needs the user gesture. Falls back to a ZIP download.
 */
export async function openSink(zipName: string): Promise<Sink | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const { join } = await import('@tauri-apps/api/path');
    const dir = await open({ directory: true, title: 'Choose a folder for the stems' });
    if (!dir || Array.isArray(dir)) return null;
    return { write: async (n, b) => writeFile(await join(dir, n), b), close: async () => {} };
  }
  const picker = (window as any).showDirectoryPicker;
  if (picker) {
    try {
      const dir = await picker({ mode: 'readwrite', id: 'steminize' });
      return {
        async write(n, b) {
          const fh = await dir.getFileHandle(n, { create: true });
          const w = await fh.createWritable();
          await w.write(b);
          await w.close();
        },
        close: async () => {},
      };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
    }
  }
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  return {
    write: async (n, b) => void (files[n] = [b, { level: 0 }]),
    close: async () => download(zipName, zipSync(files), 'application/zip'),
  };
}

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'track';

/**
 * Native folder picker for the desktop app: WebKitGTK (the Linux webview) doesn't support
 * the HTML `webkitdirectory` picker, so "Open folder…" needs Tauri's own dialog + fs plugins
 * instead. Returns every file found (recursively), with `webkitRelativePath` set so callers
 * can treat them the same as an `<input webkitdirectory>` selection; null if cancelled.
 */
export async function pickFolderFiles(): Promise<File[] | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const { readDir, readFile } = await import('@tauri-apps/plugin-fs');
  const { join, basename } = await import('@tauri-apps/api/path');
  const root = await open({ directory: true, title: 'Choose a folder of audio files' });
  if (!root || Array.isArray(root)) return null;
  const rootName = await basename(root);
  const files: File[] = [];
  async function walk(dir: string, rel: string) {
    for (const entry of await readDir(dir)) {
      const full = await join(dir, entry.name!);
      const relPath = `${rel}/${entry.name}`;
      if (entry.isDirectory) await walk(full, relPath);
      else {
        const bytes = await readFile(full);
        const file = new File([bytes as BlobPart], entry.name!);
        Object.defineProperty(file, 'webkitRelativePath', { value: relPath });
        files.push(file);
      }
    }
  }
  await walk(root, rootName);
  return files;
}
