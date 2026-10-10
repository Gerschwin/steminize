// A heads-up before separating a long file: separation holds the whole mix and every stem in memory at once (plus working copies),
// so a very long song can run a small machine out of memory. Better to say so first than to stall or stop part-way.

/** Rough peak memory (bytes) to separate `seconds` of audio into `stems` stems: the mix, each stem and about four more copies being worked on, all stereo 32-bit at 44.1 kHz. */
export function separationMemory(seconds: number, stems: number): number {
  return seconds * 44100 * 2 * 4 * (stems + 4);
}

const GB = 1024 ** 3;

/**
 * A warning to show before separating, or null when it should be fine. `deviceMemoryGb` is what the browser reports (capped at
 * 8, and missing in some webviews); unknown is treated as 8 GB.
 */
export function songSizeWarning(seconds: number, stems: number, deviceMemoryGb?: number): string | null {
  const have = (deviceMemoryGb && deviceMemoryGb > 0 ? deviceMemoryGb : 8) * GB;
  const need = separationMemory(seconds, stems);
  const long = seconds >= 15 * 60;
  if (need < have * 0.4 && !long) return null;
  const minutes = Math.round(seconds / 60);
  const gb = Math.max(1, Math.round(need / GB));
  return `This is a ${minutes}-minute file. Separating it needs about ${gb} GB of memory${need >= have * 0.4 ? ", which is a lot for this computer" : ''}. If it stalls or stops, try the Compact model, the CPU setting, or a shorter file.`;
}
