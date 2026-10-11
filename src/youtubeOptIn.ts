// "From YouTube" is switched off until the user turns it on in Settings, after reading what it means. This is the remembered choice and
// the wording, kept apart from the page so it can be tested.

export const YOUTUBE_KEY = 'steminize.youtube';

/** What the user is asked to accept before the feature is turned on. */
export const YOUTUBE_NOTICE =
  "From YouTube downloads audio from YouTube with the separate yt-dlp tool. Only download audio that you own, that is royalty-free or under a Creative Commons licence, or that you otherwise have the right to use. Downloading from YouTube can break YouTube's terms of service, and copyright law differs from country to country. You are responsible for what you download; Steminize doesn't check.";

/** The short reminder shown in the download window itself. */
export const YOUTUBE_REMINDER = "Only download audio you own, that is royalty-free or Creative Commons, or that you have the right to use. YouTube's terms may forbid downloading, and you are responsible for what you download.";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Whether the user has turned From YouTube on. Off unless they said yes; storage that can't be read means off. */
export function youtubeEnabled(store: Pick<Store, 'getItem'>): boolean {
  try {
    return store.getItem(YOUTUBE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setYoutubeEnabled(store: Pick<Store, 'setItem' | 'removeItem'>, on: boolean) {
  try {
    if (on) store.setItem(YOUTUBE_KEY, '1');
    else store.removeItem(YOUTUBE_KEY);
  } catch {
    /* storage unavailable: it stays off */
  }
}
