// "From YouTube" import: search + download a track to run separation on.
// Desktop-only — see src-tauri/src/ytdlp.rs for why (a browser tab can't run yt-dlp itself).
import { safeName } from './platform.ts';

export interface YtResult {
  id: string;
  title: string;
  uploader: string;
  duration?: number; // seconds
  thumbnail?: string;
}

export async function searchYoutube(query: string): Promise<YtResult[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<YtResult[]>('ytdlp_search', { query });
}

/** Downloads the audio, reports progress (0-1), and returns it ready to hand to `addFiles`. */
export async function downloadYoutube(id: string, title: string, onProgress: (frac: number) => void): Promise<File> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<number>('ytdlp-progress', (e) => onProgress(e.payload));
  let path: string | undefined;
  try {
    path = await invoke<string>('ytdlp_download', { id });
    // Read through our own command: the webview has no fs scope for the temp dir.
    const bytes = await invoke<ArrayBuffer>('ytdlp_read', { path });
    const ext = path.slice(path.lastIndexOf('.') + 1) || 'm4a';
    return new File([bytes as BlobPart], `${safeName(title)}.${ext}`);
  } finally {
    unlisten();
    if (path) void invoke('ytdlp_cleanup', { path }).catch(() => {});
  }
}
