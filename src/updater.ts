// The webview's side of in-app updates (the work is in src-tauri/src/updater.rs). Desktop app only.
// The Tauri modules are loaded when needed, so the web app never pulls them in.

/** Whether this install can replace itself: Windows and macOS always, Linux only as an AppImage. */
export async function updateSupported(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('update_supported');
  } catch {
    return false;
  }
}

/** Fetches a release's latest.json and keeps the update if it is newer. Returns its version, or null if there is nothing newer. */
export async function prepareUpdate(endpoint: string): Promise<string | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const info = await invoke<{ version: string } | null>('update_check', { endpoint });
  return info?.version ?? null;
}

/** Downloads and installs the prepared update, then the app restarts (so this normally never returns). */
export async function installUpdate(onProgress: (got: number, total: number) => void): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const off = await listen<[number, number]>('update-progress', (e) => onProgress(e.payload[0], e.payload[1]));
  try {
    await invoke('update_install');
  } finally {
    off();
  }
}
