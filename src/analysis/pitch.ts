// Single-note pitch detection (a tuner needs one clear fundamental, not a chord/mix).
// Normalised autocorrelation: cheap, robust for a plucked/bowed string or a held note,
// and its peak height doubles as a confidence score for rejecting noise and silence.

export interface PitchResult {
  freq: number;
  /** 0–1: how clean/tonal the match is. Below ~0.55 is usually noise, not a note. */
  clarity: number;
}

/** Covers a 5-string bass's low B (~31 Hz) up to a guitar's highest fretted notes. */
const MIN_HZ = 30;
const MAX_HZ = 1300;

export function detectPitch(buf: Float32Array, sampleRate: number, minHz = MIN_HZ, maxHz = MAX_HZ): PitchResult | null {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.01) return null; // near silence

  const minLag = Math.max(1, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 1, Math.floor(sampleRate / minHz));
  if (maxLag <= minLag) return null;

  const corrAt = (lag: number) => {
    let corr = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) corr += buf[i] * buf[i + lag];
    return corr;
  };

  const THRESHOLD = 0.6;
  const LOW = 0.3;
  let bestLag = -1;
  let bestScore = 0;
  let pastPeak = false;
  // Neighbouring samples of any smooth waveform are near-identical, so the correlation at
  // very short lags starts out high regardless of the note's real period — that's not a
  // match, just an artefact. Ignore that region until the score has genuinely dropped,
  // proving we're clear of it, before starting to track a peak at all.
  let seenLow = false;
  for (let lag = minLag; lag <= maxLag && !pastPeak; lag++) {
    let corr = 0;
    let e0 = 0;
    let e1 = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) {
      corr += buf[i] * buf[i + lag];
      e0 += buf[i] * buf[i];
      e1 += buf[i + lag] * buf[i + lag];
    }
    const denom = Math.sqrt(e0 * e1);
    const score = denom > 0 ? corr / denom : 0;
    if (!seenLow) {
      if (score < LOW) seenLow = true;
      continue;
    }
    // Lock onto the *first* clear peak past that point (the shortest remaining lag, i.e.
    // highest frequency) rather than scanning the whole range for the single best match: a
    // pure tone's autocorrelation is often just as strong (sometimes stronger) at double the
    // true period, and chasing the global maximum picks that octave-below subharmonic instead
    // of the real fundamental.
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    } else if (bestScore > THRESHOLD) {
      pastPeak = true;
    }
  }
  if (bestLag < 0 || bestScore < THRESHOLD) return null;

  // Parabolic interpolation around the best lag, for sub-sample (sub-cent) precision.
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = corrAt(bestLag - 1);
    const y1 = corrAt(bestLag);
    const y2 = corrAt(bestLag + 1);
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) lag = bestLag + 0.5 * (y0 - y2) / denom;
  }
  return { freq: sampleRate / lag, clarity: bestScore };
}

/** Hz to the nearest MIDI note number, plus how many cents sharp (+) or flat (-) of it. */
export function freqToNote(f: number): { note: number; cents: number } {
  const raw = 12 * Math.log2(f / 440) + 69;
  const note = Math.round(raw);
  const cents = Math.round((raw - note) * 100);
  return { note, cents };
}
