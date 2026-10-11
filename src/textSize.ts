// The interface size (the desktop app's page zoom), for people who want larger text. The steps, the remembered choice and the
// keyboard step are kept apart from the page so they can be tested.

export const ZOOM_KEY = 'steminize.zoom';

/** The sizes offered, as the factor the page is scaled by. */
export const ZOOM_STEPS = [1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export const zoomLabel = (z: number) => (z === 1 ? 'Normal' : `${Math.round(z * 100)}%`);

/** The nearest offered size to any number (so a stale or hand-edited value still lands on a real step). */
export function nearestZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - z) < Math.abs(best - z) ? s : best), 1 as number);
}

/** One step bigger (+1) or smaller (-1), staying within the offered sizes. */
export function stepZoom(current: number, dir: 1 | -1): number {
  const i = ZOOM_STEPS.indexOf(nearestZoom(current) as (typeof ZOOM_STEPS)[number]);
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))];
}

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadZoom(store: Pick<Store, 'getItem'>): number {
  try {
    return nearestZoom(Number(store.getItem(ZOOM_KEY) ?? 1));
  } catch {
    return 1;
  }
}

export function saveZoom(store: Pick<Store, 'setItem' | 'removeItem'>, z: number) {
  try {
    if (z === 1) store.removeItem(ZOOM_KEY);
    else store.setItem(ZOOM_KEY, String(z));
  } catch {
    /* storage unavailable: the size is not remembered */
  }
}
