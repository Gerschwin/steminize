// Native audio is experimental and off by default, so it must be easy to find and hard to miss. This is the wording, and the rule for
// when the "it exists" tip in the Live input drawer is shown, kept apart from the page so it can be tested.

export const NATIVE_TIP_KEY = 'steminize.nativeTipSeen';

export const NATIVE_TIP =
  'New and experimental: Native audio talks to your sound card directly for lower delay when you play along or record. It is off by default. Switch it on in Settings, under Audio input & latency (the Show me button takes you there).';

export const NATIVE_INFO =
  'Native audio (experimental, desktop only) opens your sound card directly for lower delay when you play along or record. It is off by default while it is tested on more computers. You find it in Settings, under Audio input & latency.';

export const NATIVE_WELCOME = 'Playing along or recording? Try Native audio (experimental) in Settings, under Audio input & latency: lower delay, off by default.';

interface Store {
  getItem(key: string): string | null;
}

/** The tip is for the desktop app only, until it has been dismissed, and not once native audio is already on. */
export function nativeTipVisible(store: Store, desktop: boolean, nativeOn: boolean): boolean {
  if (!desktop || nativeOn) return false;
  try {
    return store.getItem(NATIVE_TIP_KEY) !== '1';
  } catch {
    return true; // storage that can't be read: show it rather than hide the feature
  }
}
