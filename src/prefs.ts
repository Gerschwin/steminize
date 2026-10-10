// The interface choices the app remembers in the browser's storage, and putting them back to how they start. The library, the
// setlists, the last-backup time and the separation settings are deliberately not in this list: resetting the look and the
// panels must never touch someone's songs or sets.

export const APP_PREFERENCE_KEYS = [
  'steminize.theme',
  'steminize.drawer',
  'steminize.showPan',
  'steminize.scratchFloat',
  'steminize.pedal',
  'steminize.autoSave',
  'steminize.autoStart',
  'steminize.liveChannel',
  'steminize.lowLatencyAudio',
  'steminize.maxTakes',
  'steminize.recLatencyMs',
  'steminize.nativeRecLatencyMs',
  'steminize.nativePlayback',
  'steminize.gpuFailed',
] as const;

interface KeyStore {
  removeItem(key: string): void;
}

/** Forgets every remembered interface choice; returns how many keys it was asked to remove. */
export function resetAppPreferences(store: KeyStore): number {
  for (const k of APP_PREFERENCE_KEYS) {
    try {
      store.removeItem(k);
    } catch {
      /* storage unavailable: nothing to reset */
    }
  }
  return APP_PREFERENCE_KEYS.length;
}
