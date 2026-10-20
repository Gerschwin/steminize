export interface StretchConfig {
  blockMs: number;
  overlap: number;
  split: boolean;
}

export const DEFAULT_STRETCH: StretchConfig = { blockMs: 120, overlap: 75, split: false };

/** Keep saved values within the ranges offered by the playback controls. */
export function stretchConfig(value: Partial<StretchConfig> = {}): StretchConfig {
  const block = Number(value.blockMs);
  const overlap = Number(value.overlap);
  return {
    blockMs: Number.isFinite(block) ? Math.max(60, Math.min(200, Math.round(block / 10) * 10)) : DEFAULT_STRETCH.blockMs,
    overlap: Number.isFinite(overlap) ? Math.max(50, Math.min(85, Math.round(overlap / 5) * 5)) : DEFAULT_STRETCH.overlap,
    split: typeof value.split === 'boolean' ? value.split : DEFAULT_STRETCH.split,
  };
}
