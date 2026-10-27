// Reads a Guitar Pro (.gp3 .gp4 .gp5 .gp .gpx) or MusicXML (.musicxml .xml .mxl) file with alphaTab, loaded only when a file is
// chosen (it is a big library, and most sessions never import one). What the rest of the app uses is in tabImport.ts.

import type { TScore } from './tabImport.ts';

export interface LoadedScore {
  score: TScore;
  /** The bars in the order they are played, repeats, numbered endings and jumps included (empty: work it out from the repeats alone). */
  order: number[];
}

/** Why a file could not be read, in words for the person. */
export function describeLoadError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/UnsupportedFormat|not.*supported|format/i.test(m) || (e as { name?: string })?.name === 'UnsupportedFormatError') return "it isn't a Guitar Pro (.gp3 to .gp) or MusicXML file this can read";
  return m;
}

export async function loadScoreFile(bytes: Uint8Array): Promise<LoadedScore> {
  const at = await import('@coderline/alphatab');
  const settings = new at.Settings();
  const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, settings) as unknown as TScore;
  let order: number[] = [];
  try {
    // alphaTab's own player works out the order the bars are heard in; ask it rather than redoing its rules.
    const gen = new at.midi.MidiFileGenerator(score as never, settings, new at.midi.AlphaSynthMidiFileHandler(new at.midi.MidiFile()));
    gen.generate();
    order = gen.tickLookup.masterBars.map((m: { masterBar: { index: number } }) => m.masterBar.index);
  } catch {
    order = [];
  }
  return { score, order: order.length ? order : [] };
}
