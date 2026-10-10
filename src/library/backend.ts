// What library.ts needs from wherever songs actually live: OPFS in the browser (src/library/opfsBackend.ts)
// or plain files via Tauri on the Linux desktop app (src/library/nativeBackend.ts). Everything above this
// (save/add-take/remove-take/export/import) is backend-agnostic and lives in library.ts itself.
export interface LibraryBackend {
  /** Every song's raw meta.json text, with its id (the folder name). Also cleans up any folder that's
   * missing one (an interrupted save: see the ordering note on writeMeta). */
  list(): Promise<{ id: string; meta: string }[]>;
  writeMeta(id: string, meta: string): Promise<void>;
  /** Writes one file (already-encoded stem/take audio); returns the byte count written. */
  writeFile(id: string, name: string, bytes: Uint8Array): Promise<number>;
  readFile(id: string, name: string): Promise<Uint8Array>;
  /** Every file in a song's folder, including meta.json (for building a backup zip). */
  listFiles(id: string): Promise<string[]>;
  /** Removes one file; not an error if it's already gone. */
  removeFile(id: string, name: string): Promise<void>;
  deleteSong(id: string): Promise<void>;
  /** Free bytes where songs are stored, or null when that can't be known. */
  freeSpace(): Promise<number | null>;
}
