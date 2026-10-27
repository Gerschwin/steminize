// The sample song that comes with the app: a short original piece (synthesised, so there is nothing to license) with a finished guitar
// tab that is already timed, for trying the player, Follow along and the full-window Tab view before bringing any music of your own.
// Made by tools/make-example-song.py; lives in public/sample/example-tab/ (three small MP3 stems and a song.json).

import type { Analysis } from './library.ts';
import type { Settings } from './settings.ts';
import type { DeckState, Result } from './ui/deck.ts';

export const SAMPLE_ID = 'example-tab';
const BASE = './sample/example-tab/';

/** The song.json written by the generator. */
export interface SampleDoc {
  id: string;
  title: string;
  seconds: number;
  analysis: Analysis;
  stems: { name: string; file: string }[];
  state: DeckState;
}

/** Reads the sample's description and decodes its stems (`decode` turns a file into two channels at 44.1 kHz). */
export async function loadSample(settings: Settings, decode: (file: File) => Promise<[Float32Array, Float32Array]>, fetchFn: typeof fetch = fetch): Promise<{ result: Result; state: DeckState }> {
  const get = async (name: string) => {
    const res = await fetchFn(BASE + name);
    if (!res.ok) throw new Error(`the sample's ${name} is missing (${res.status})`);
    return res;
  };
  const doc: SampleDoc = await (await get('song.json')).json();
  const decoded = [];
  for (const s of doc.stems) decoded.push(await decode(new File([await (await get(s.file)).arrayBuffer()], s.file)));
  // Every stem the same length, from the same start.
  const len = Math.max(...decoded.map((d) => d[0].length));
  const pad = (c: Float32Array) => {
    if (c.length === len) return c;
    const o = new Float32Array(len);
    o.set(c);
    return o;
  };
  const result: Result = {
    title: doc.title,
    stems: decoded.map((d, i) => ({ name: doc.stems[i].name, data: [pad(d[0]), pad(d[1])] })),
    settings: structuredClone(settings),
    seconds: len / 44100,
    kind: 'multitrack',
    analysis: doc.analysis,
    sample: doc.id,
  };
  return { result, state: doc.state };
}
