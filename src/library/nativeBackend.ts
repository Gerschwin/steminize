// Library storage for the desktop app: plain files under the OS's app-data directory, written through
// Rust (src-tauri/src/library.rs), since WebKitGTK (the Linux webview) doesn't support OPFS's write API.
// Stem/take audio goes over Tauri's raw-body IPC (id/name as headers, bytes as the body) rather than as
// JSON, the same pattern already used by ytdlp_read/open_link, since a song's FLAC stems can be several
// MB each. Everything else is a normal invoke() with plain arguments.
import type { LibraryBackend } from './backend.ts';

async function inv() {
  return (await import('@tauri-apps/api/core')).invoke;
}

export const nativeBackend: LibraryBackend = {
  async list() {
    const invoke = await inv();
    return invoke<{ id: string; meta: string }[]>('lib_list');
  },

  async writeMeta(id, meta) {
    const invoke = await inv();
    await invoke('lib_write_meta', { id, meta });
  },

  async writeFile(id, name, bytes) {
    const invoke = await inv();
    return invoke<number>('lib_write_file', bytes, { headers: { 'x-song-id': id, 'x-file-name': name } });
  },

  async readFile(id, name) {
    const invoke = await inv();
    return new Uint8Array(await invoke<ArrayBuffer>('lib_read_file', { id, name }));
  },

  async listFiles(id) {
    const invoke = await inv();
    return invoke<string[]>('lib_list_files', { id });
  },

  async removeFile(id, name) {
    const invoke = await inv();
    await invoke('lib_remove_file', { id, name });
  },

  async deleteSong(id) {
    const invoke = await inv();
    await invoke('lib_delete', { id });
  },
};
