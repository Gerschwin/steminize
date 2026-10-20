export interface StretchConfig {
  blockMs: number;
  overlap: number;
  split: boolean;
}

export const DEFAULT_STRETCH: StretchConfig = { blockMs: 120, overlap: 4, split: false };

/** Keep saved values within the ranges offered by the playback controls. */
export function stretchConfig(value: Partial<StretchConfig> = {}): StretchConfig {
  const block = Number(value.blockMs);
  const savedOverlap = Number(value.overlap);
  // Older settings stored overlap as a percentage; the demo uses block/interval.
  const overlap = savedOverlap > 8 ? 1 / (1 - savedOverlap / 100) : savedOverlap;
  return {
    blockMs: Number.isFinite(block) ? Math.max(60, Math.min(200, Math.round(block / 10) * 10)) : DEFAULT_STRETCH.blockMs,
    overlap: Number.isFinite(overlap) ? Math.max(2, Math.min(8, Math.round(overlap * 10) / 10)) : DEFAULT_STRETCH.overlap,
    split: typeof value.split === 'boolean' ? value.split : DEFAULT_STRETCH.split,
  };
}
