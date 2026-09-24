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
  model: 'htdemucs',
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

const KEY = 'stemdeck.settings.v1';

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
