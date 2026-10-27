// Checks the example song's tab against what it is meant to sound like: every note the app reads from the tab text, put on the
// timeline through the taps saved with the song, must land where the audio has it (within a few milliseconds).
//   python3 tools/make-example-song.py <library> --check /tmp/notes.json && node --experimental-strip-types tools/check-example-song.mjs /tmp/notes.json <meta.json>
import { readFileSync } from 'node:fs';
import { anchorCoords, parseScore, tabBlocks, timeAtCoord } from '../src/lyrics/tabSync.ts';

const [, , notesFile, metaFile] = process.argv;
const want = JSON.parse(readFileSync(notesFile, 'utf8'));
const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
const { tab, tabAnchors } = meta.state.scratch;
if (tab !== want.text) throw new Error('the saved tab text is not the one the notes were made from');
const blocks = tabBlocks(tab);
const { notes } = parseScore(tab);
const ROWS = ['e', 'B', 'G', 'D', 'A', 'E'];
let worst = 0;
for (const mode of ['all taps', 'first tap only']) {
  const anchors = mode === 'all taps' ? tabAnchors : tabAnchors.slice(0, 1);
  const coords = anchorCoords(tab, blocks, anchors);
  const sorted = [...want.notes].sort((a, b) => a.time - b.time || ROWS.indexOf(a.string) - ROWS.indexOf(b.string));
  const read = [...notes].sort((a, b) => a.start - b.start || a.string - b.string);
  if (read.length !== sorted.length) throw new Error(`${mode}: the app reads ${read.length} notes, expected ${sorted.length}`);
  let worstHere = 0;
  sorted.forEach((w, i) => {
    const r = read[i];
    if (ROWS[r.string] !== w.string || r.fret !== w.fret) throw new Error(`${mode}: note ${i} is ${ROWS[r.string]}${r.fret}, expected ${w.string}${w.fret}`);
    const t = timeAtCoord(coords, want.bpm, r.start);
    worstHere = Math.max(worstHere, Math.abs(t - w.time));
    if (Math.abs(r.length - w.len) > 1e-9) throw new Error(`${mode}: note ${i} is ${r.length} long, expected ${w.len}`);
  });
  console.log(`${mode}: ${read.length} notes, worst timing error ${(worstHere * 1000).toFixed(2)} ms`);
  worst = Math.max(worst, worstHere);
}
if (worst > 0.005) throw new Error('timing is off');
console.log('ok');
