import type { ModelId, Precision } from './models.ts';

export type OutputFormat = 'wav' | 'flac' | 'mp3';
export type WavDepth = '16' | '24' | '32f';
export type ClipMode = 'rescale' | 'clamp' | 'none';
export type Device = 'auto' | 'gpu' | 'cpu';

export interface Settings {
  model: ModelId;
  precision: Precision;
  /** '' = all stems, otherwise the stem to isolate against everything else. */
  twoStems: string;
  /** Stems to keep when not in two-stem mode ('' entries ignored). Empty = all. */
  skipStems: string[];
  shifts: number;
  overlap: number;
  device: Device;
  format: OutputFormat;
  wavDepth: WavDepth;
  flacDepth: '16' | '24';
  mp3Bitrate: number;
  clip: ClipMode;
}

export const DEFAULTS: Settings = {
  model: 'htdemucs_6s',
  precision: 'compact',
  twoStems: '',
  skipStems: [],
  shifts: 1,
  overlap: 0.25,
  device: 'auto',
  format: 'wav',
  wavDepth: '16',
  flacDepth: '16',
  mp3Bitrate: 320,
  clip: 'rescale',
};

const KEY = 'steminize.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable: fall back to defaults */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Round-trip audio delay (ms) taken off recorded takes so they line up with the song; see player/latency.ts. */
const LATENCY_KEY = 'steminize.recLatencyMs';
export const MAX_REC_LATENCY_MS = 500;

/** The native engine has its own value (its round trip is a few ms, the webview's is hundreds). */
const NATIVE_LATENCY_KEY = 'steminize.nativeRecLatencyMs';
export const DEFAULT_NATIVE_LATENCY_MS = 10;

export function loadRecLatencyMs(native = false): number {
  try {
    const stored = localStorage.getItem(native ? NATIVE_LATENCY_KEY : LATENCY_KEY);
    if (native && stored == null) return DEFAULT_NATIVE_LATENCY_MS;
    const v = Number(stored);
    if (Number.isFinite(v)) return Math.max(0, Math.min(MAX_REC_LATENCY_MS, Math.round(v)));
  } catch {
    /* storage unavailable */
  }
  return 0;
}

export function saveRecLatencyMs(ms: number, native = false) {
  try {
    localStorage.setItem(native ? NATIVE_LATENCY_KEY : LATENCY_KEY, String(Math.max(0, Math.min(MAX_REC_LATENCY_MS, Math.round(ms)))));
  } catch {
    /* ignore */
  }
}

/** Ask the browser for its smallest audio buffers (lower delay when playing live, at more risk of glitches). Read when the audio starts, so it applies from the next launch. */
const LOW_LATENCY_KEY = 'steminize.lowLatencyAudio';

export function loadLowLatencyAudio(): boolean {
  try {
    return localStorage.getItem(LOW_LATENCY_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveLowLatencyAudio(on: boolean) {
  try {
    localStorage.setItem(LOW_LATENCY_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Which input channels the live input uses; see Player.setMonitorChannel. */
const CHANNEL_KEY = 'steminize.liveChannel';
export type LiveChannel = 'stereo' | 'left' | 'right' | 'sum';

export function loadLiveChannel(): LiveChannel {
  try {
    const v = localStorage.getItem(CHANNEL_KEY);
    if (v === 'stereo' || v === 'left' || v === 'right' || v === 'sum') return v;
  } catch {
    /* storage unavailable */
  }
  return 'stereo';
}

export function saveLiveChannel(v: LiveChannel) {
  try {
    localStorage.setItem(CHANNEL_KEY, v);
  } catch {
    /* ignore */
  }
}
