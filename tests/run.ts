// Run with: npm test   (Node 22+, uses --experimental-strip-types)
// Checks the separation maths with a fake network, and the encoders against ffmpeg.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEGMENT, SR, countRuns, pickStems, separate, type Member, type Stereo } from '../src/engine/separate.ts';
import { encodeFlac } from '../src/encode/flac.ts';
import { encodeWav } from '../src/encode/wav.ts';
import { encodeMp3 } from '../src/encode/mp3.ts';
import { applyClip } from '../src/encode/pcm.ts';
import { MixSource, panMatrix, renderMix } from '../src/player/mixcore.ts';
import { FLAT, PRESETS, responseDb } from '../src/player/eq.ts';
import { DEFAULT_PRACTICE, Transport, gateStep } from '../src/player/transport.ts';
import { Renderer } from '../src/player/mixcore.ts';
import { analyse } from '../src/analysis/beats.ts';
import { detectKey, keyName } from '../src/analysis/key.ts';
import { BINS, CQT_FPS, NOTE_LO, cqt } from '../src/analysis/cqt.ts';
import { chordName, chordSheet, detectChords, mergeSame, prefersSharps } from '../src/analysis/chords.ts';
import { BP_PITCHES, BP_WINDOW, bpNotes, bpUnwrap, bpWindows, singleLine } from '../src/analysis/basicPitch.ts';
import { decimate2 } from '../src/analysis/resample.ts';
import { autoTab, barStartOffsets, beatPos, beatTime, fitOffset, mergeRetriggers, simplifyTimes } from '../src/analysis/autoTab.ts';
import { writeMidi } from '../src/encode/midi.ts';
import { centsFrom, detectPitch, freqToNote } from '../src/analysis/pitch.ts';
import { isNewer, parseVersion, pickUpdate, updateEndpoint } from '../src/version.ts';
import { lineAt, parseLrc } from '../src/lyrics/lrc.ts';
import { pageRowAt, planRows, planStack, splitLength, staffX, vexKey, zoomDrawing } from '../src/ui/staff.ts';
import { acceptedMidis, timeAtCoord, fromUnrolled, repeatPlan, toUnrolled, addAnchor, charOffsetAt, coordAtBpm, coordToPlace, coordToStripX, findNoteAt, noteCols, noteGroupAt, parseScore, parseTab, setRhythmLetter, stripLayout, isLockedAt, moveAnchor, offsetToCoord, removeAnchor, rowCol, tabBlocks, tabPositionAt, toggleAnchorLock, type TabAnchor, type TabNote } from '../src/lyrics/tabSync.ts';
import { moveItem, nextSong, parseSetlists, prevSong, pruneSongs, totalSeconds, uniqueName, type Setlist } from '../src/setlists.ts';
import { detectLatency } from '../src/player/latency.ts';
import { placeTake, shiftTake } from '../src/player/placement.ts';
import { StreamResampler } from '../src/player/resample.ts';
import { withTimeout } from '../src/engine/timeout.ts';
import { separationMemory, songSizeWarning } from '../src/engine/sizeHint.ts';
import { beatCells, beatPositionAt, displayName, simplifyChord, timeAtBeat } from '../src/analysis/chordStrip.ts';
import { APP_PREFERENCE_KEYS, resetAppPreferences } from '../src/prefs.ts';
import { INCOMPLETE_GRACE_MS, backupNote, canCleanIncompleteSong, fmtBytes, spaceNeeded, spaceStatus } from '../src/library/safety.ts';
import { parseMeta } from '../src/library/meta.ts';
import { voiceSlots } from '../src/ui/drumStaff.ts';
import { DRUM_VOICES, drumMidi, hitStyle, parseDrums, voiceOfLabel } from '../src/lyrics/drumTab.ts';
import { PART_IDS, defaultTrack, isBuiltinPart, legacyTabPart, newPartId, normaliseScratch, partKind, stringCount } from '../src/lyrics/tabParts.ts';
import { CHORD_TONES, chordCost, fretShape, pianoKeys, shapeIsRight, suggestCapo } from '../src/analysis/chordShapes.ts';
import { QUALITIES } from '../src/analysis/chords.ts';
import { segmentsFor, snapToWord, sungSeconds } from '../src/lyrics/lyricChords.ts';
import { modelNote } from '../src/models.ts';
import { dawprojectAudioPath, dawprojectMetadata, dawprojectXml } from '../src/export/dawproject.ts';
import { addEdgeCuts, barFeatures, boundaries, nameSegments, novelty, selfSimilarity, standardise, suggestSections } from '../src/analysis/structure.ts';
import { DEFAULT_LEARN, mergeMarkers, addClean, addMiss, addPass, barStarts, chunksOf, firstUnfinished, newProgress, readLearn, sameSpan, sectionStatus, sectionsFromMarkers, spanKey, stitch } from '../src/learn/learn.ts';
import { ardourColour, ardourSession, ardourSessionName } from '../src/export/ardour.ts';
import { songManifest, barAlignment, beatTempos, dawReadme, guid, markersCsv, reaperColour, reaperProject, tempoMapFile, type DawProject } from '../src/export/daw.ts';
import { ZOOM_KEY, ZOOM_STEPS, loadZoom, nearestZoom, saveZoom, stepZoom, zoomLabel } from '../src/textSize.ts';
import { NATIVE_INFO, NATIVE_TIP, NATIVE_TIP_KEY, NATIVE_WELCOME, nativeTipVisible } from '../src/nativeHint.ts';
import { YOUTUBE_KEY, YOUTUBE_NOTICE, YOUTUBE_REMINDER, setYoutubeEnabled, youtubeEnabled } from '../src/youtubeOptIn.ts';
import { downloadResumable, keptBytes, parseContentRange, type PartStore } from '../src/modelDownload.ts';
import { BarTally, barColour, barCue, barPercent, barTip } from '../src/lyrics/barScores.ts';

let failed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failed++;
};

function signal(n: number, seed = 1): Stereo {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = 0.4 * Math.sin(i * 0.013) + 0.2 * rnd() + 0.05;
    r[i] = 0.3 * Math.sin(i * 0.021 + 1) + 0.2 * rnd();
  }
  return [l, r];
}

/** Fake network: source k = weight[k] * input. */
function fakeMember(weights: number[], rows: number[], calls = { n: 0 }): Member {
  return {
    rows,
    load: async () => ({
      run: async (input: Float32Array) => {
        calls.n++;
        const out = new Float32Array(weights.length * 2 * SEGMENT);
        for (let k = 0; k < weights.length; k++) for (let i = 0; i < 2 * SEGMENT; i++) out[k * 2 * SEGMENT + i] = weights[k] * input[i];
        return out;
      },
      release: () => {},
    }),
  };
}

const maxErr = (a: Float32Array, b: (i: number) => number) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b(i))), 0);

// ---- 1. overlap-add reconstructs exactly, for odd lengths, overlaps and shifts
const W = [0.1, 0.2, 0.3, 0.4];
for (const [len, overlap, shifts] of [
  [1000, 0.25, 1],
  [Math.round(SEGMENT * 2.37), 0.25, 1],
  [Math.round(SEGMENT * 2.37), 0.1, 1],
  [Math.round(SEGMENT * 1.5), 0.5, 3],
] as const) {
  const mix = signal(len);
  const calls = { n: 0 };
  const opts = { members: [fakeMember(W, [0, 1, 2, 3], calls)], numSources: 4, shifts, overlap };
  let lastDone = 0;
  const out = await separate(mix, { ...opts, onProgress: (d) => (lastDone = d) });
  let mean = 0;
  for (let i = 0; i < len; i++) mean += (mix[0][i] + mix[1][i]) / 2;
  mean /= len;
  // Demucs adds the mix mean back to every source: w*(x-mean)+mean.
  const err = Math.max(...out.flatMap((src, k) => src.map((ch, c) => maxErr(ch, (i) => W[k] * (mix[c][i] - mean) + mean))));
  ok(`reconstruct len=${len} overlap=${overlap} shifts=${shifts}`, err < 1e-4, `max err ${err.toExponential(1)}`);
  ok(`  run count matches progress`, calls.n === countRuns(len, opts) && lastDone === calls.n, `${calls.n} runs`);
}

// ---- 1b. the memory-lean paths give exactly the same answer
{
  const mix = signal(Math.round(SEGMENT * 1.7), 21);
  const run = (over: object) => separate(mix, { members: [fakeMember(W, [0, 1, 2, 3])], numSources: 4, shifts: 1, overlap: 0.25, ...over });
  const plain = await run({});
  let allocated = 0;
  const viaAlloc = await run({ alloc: (n: number) => (allocated++, new Float32Array(n)) });
  ok('alloc: result rows come from the caller (4 sources x 2 channels)', allocated === 8, `${allocated} arrays`);
  ok('alloc: identical output', plain.every((src, k) => src.every((ch, c) => maxErr(ch, (i) => viaAlloc[k][c][i]) === 0)));
  // A single-model, no-shift run writes straight into the result; a shifted one sums via a second set. Same physics.
  const progress: number[] = [];
  await run({ onProgress: (d: number) => progress.push(d) });
  ok('progress: reports 0 once the model is loaded, before the first pass', progress[0] === 0 && progress[1] === 1, progress.slice(0, 3).join(','));
}

// ---- 2. bags take each row only from its specialist
{
  const mix = signal(50_000, 7);
  const out = await separate(mix, {
    members: [fakeMember([1, 1, 1, 1], [0]), fakeMember([2, 2, 2, 2], [1]), fakeMember([3, 3, 3, 3], [3])],
    numSources: 4,
    shifts: 1,
    overlap: 0.25,
  });
  let mean = 0;
  for (let i = 0; i < mix[0].length; i++) mean += (mix[0][i] + mix[1][i]) / 2;
  mean /= mix[0].length;
  const errs = [1, 2, 0, 3].map((w, k) => maxErr(out[k][0], (i) => w * (mix[0][i] - mean) + mean));
  ok('bag: rows come from their own member', Math.max(...errs) < 1e-4, errs.map((e) => e.toExponential(0)).join(' '));
}

// ---- 3. two-stem modes
{
  const mix = signal(10_000, 3);
  const raw = [0, 1, 2, 3].map((k) => [mix[0].map((v) => v * W[k]), mix[1].map((v) => v * W[k])]);
  const a = pickStems(raw, ['drums', 'bass', 'other', 'vocals'], mix, 'vocals', [0, 1, 2, 3]);
  ok('two-stem (sum of others)', a[1].name === 'no_vocals' && maxErr(a[1].data[0], (i) => 0.6 * mix[0][i]) < 1e-6);
  const b = pickStems(raw, ['drums', 'bass', 'other', 'vocals'], mix, 'vocals', [3]);
  ok('two-stem (mix minus stem)', maxErr(b[1].data[1], (i) => 0.6 * mix[1][i]) < 1e-6);
  const c = pickStems(raw, ['drums', 'bass', 'other', 'vocals'], mix, '', [0, 1, 2, 3], ['bass', 'other']);
  ok('stem subset', c.map((s) => s.name).join() === 'drums,vocals');
}

// ---- 4. clipping
{
  const x: Stereo = [Float32Array.from([0.5, 1.5, -2]), Float32Array.from([0, 0, 0])];
  const r = applyClip(x, 'rescale');
  ok('clip rescale keeps shape', Math.abs(r[0][2] / r[0][1] - -2 / 1.5) < 1e-6 && Math.abs(r[0][2]) < 1);
  ok('clip clamp', applyClip(x, 'clamp')[0][1] === Math.fround(0.99));
}

// ---- 5. mixer / time-stretch
{
  const a = signal(SR * 3, 11);
  const b = signal(SR * 3, 12);
  const m = renderMix([a, b], [1, 0.5], 0, SR * 3, 1, 0);
  ok('mix at 100% is an exact weighted sum', maxErr(m[0], (i) => a[0][i] + 0.5 * b[0][i]) < 1e-6);
  const slow = renderMix([a, b], [1, 1], 0, SR * 2, 0.5, 0);
  const rms = Math.sqrt(slow[0].reduce((s, v) => s + v * v, 0) / slow[0].length);
  ok('50% tempo doubles length and has audio', slow[0].length === SR * 4 && rms > 0.05, `rms ${rms.toFixed(3)}`);
  const frac = renderMix([a], [1], 1000.4, 50000.7, 1, 0);
  ok('fractional positions still render audio', frac[0][10] === a[0][1010]);
  const shifted = renderMix([a], [1], 0, SR * 2, 1, 3);
  ok('pitch shift keeps length', shifted[0].length === SR * 2);
  const src = new MixSource([a], [1], SR * 3);
  src.loopOn = true;
  src.loopStart = 1000;
  src.loopEnd = 6000;
  src.pos = 5000;
  const buf = new Float32Array(4000);
  src.extract(buf, 2000);
  ok('loop wraps to A', src.pos === 2000 && buf[2000] === a[0][1000]);
}

// ---- 5b. pan
{
  const a = signal(20_000, 21);
  const c = renderMix([a], [1], 0, 20_000, 1, 0, [0]);
  ok('pan centre keeps original stereo', maxErr(c[0], (i) => a[0][i]) === 0 && maxErr(c[1], (i) => a[1][i]) === 0);
  const L = renderMix([a], [0.5], 0, 20_000, 1, 0, [-1]);
  ok('pan hard left: silent right, mono sum left', L[1].every((v) => Math.abs(v) < 1e-7) && maxErr(L[0], (i) => 0.5 * Math.SQRT2 * (a[0][i] + a[1][i]) / 2) < 1e-6);
  const R = renderMix([a], [1], 0, 20_000, 1, 0, [1]);
  ok('pan hard right: silent left', R[0].every((v) => Math.abs(v) < 1e-7));
  const [p, q, r2, t] = panMatrix(0.5);
  ok('pan half right leans right', r2 + t > p + q, [p, q, r2, t].map((x) => x.toFixed(3)).join(' '));
}

// ---- 5c. EQ
{
  const n = SR * 2;
  const tone = (f: number): Stereo => {
    const l = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / SR));
    return [l, l.slice()];
  };
  const rms = (x: Float32Array) => Math.sqrt(x.subarray(SR).reduce((a, v) => a + v * v, 0) / (n - SR)); // skip settling
  const gainDb = (f: number, eq: typeof FLAT) => 20 * Math.log10(rms(renderMix([tone(f)], [1], 0, n, 1, 0, [], [eq])[0]) / rms(tone(f)[0]));
  const a = signal(20_000, 31);
  const flat = renderMix([a], [1], 0, 20_000, 1, 0, [], [FLAT]);
  ok('EQ flat is bit-exact passthrough', maxErr(flat[0], (i) => a[0][i]) === 0);
  const kick = PRESETS.find((p) => p.name === 'Kick')!.eq;
  const hats = PRESETS.find((p) => p.name === 'Hi-hats')!.eq;
  const k50 = gainDb(50, kick), k5k = gainDb(5000, kick);
  ok('EQ Kick keeps 50 Hz, removes 5 kHz', Math.abs(k50) < 6 && k5k < -40, `50 Hz ${k50.toFixed(1)} dB, 5 kHz ${k5k.toFixed(1)} dB`);
  const h100 = gainDb(100, hats), h10k = gainDb(10000, hats);
  ok('EQ Hi-hats removes 100 Hz, keeps 10 kHz', h100 < -60 && Math.abs(h10k) < 1, `100 Hz ${h100.toFixed(1)} dB, 10 kHz ${h10k.toFixed(1)} dB`);
  const boost = { ...FLAT, freq: 1000, gain: 12, q: 1 };
  const b1k = gainDb(1000, boost);
  ok('EQ focus +12 dB at 1 kHz', Math.abs(b1k - 12) < 0.3, `${b1k.toFixed(2)} dB`);
  const k260 = gainDb(260, kick);
  const pred = responseDb(kick, [260])[0];
  ok('EQ curve matches measured response', Math.abs(pred - k260) < 0.5, `curve ${pred.toFixed(1)} vs measured ${k260.toFixed(1)} dB at 260 Hz`);
}

// ---- 5d. transport: loop gap, count-in, trainer, click
{
  const len = SR * 6;
  const src: Stereo = [new Float32Array(len), new Float32Array(len)];
  src[0][SR] = src[1][SR] = 0.9; // marker at the loop start (1.0 s)
  const make = () => {
    const ms = new MixSource([src], [1], len);
    ms.padEnd = 32768;
    return new Transport(new Renderer(ms));
  };
  const run = (t: Transport, seconds: number, onBlock?: (frame: number) => void) => {
    const out = new Float32Array(Math.round(seconds * SR));
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let f = 0; f < out.length; f += 128) {
      t.render(L, R, 128);
      out.set(L.subarray(0, Math.min(128, out.length - f)), f);
      onBlock?.(f);
    }
    return out;
  };
  const markers = (x: Float32Array) => [...x.keys()].filter((i) => x[i] > 0.8).map((i) => +(i / SR).toFixed(3));
  const clicks = (x: Float32Array) => {
    const o: number[] = [];
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.05 && Math.abs(x[i]) < 0.8 && (!o.length || i - o[o.length - 1] > 2000)) o.push(i);
    return o.map((i) => +(i / SR).toFixed(3));
  };
  const beats = Array.from({ length: 12 }, (_, k) => Math.round(k * SR * 0.5)); // 120 BPM

  let t = make();
  t.setLoop(true, SR, 2 * SR);
  t.setPractice({ ...DEFAULT_PRACTICE, gap: 1 });
  t.onPlay();
  const g = markers(run(t, 5));
  ok('loop gap: 1 s pass then 1 s silence', g.join() === '0,2,4', `loop starts at ${g.join(' ')} s`);

  t = make();
  t.setLoop(true, SR, 2 * SR);
  t.setPractice({ ...DEFAULT_PRACTICE, countIn: true, beats, perBar: 4 });
  t.onPlay();
  const o1 = run(t, 5.5);
  ok('count-in: 4 clicks at 120 BPM, loop starts on the next beat', clicks(o1).slice(0, 4).join() === '0,0.5,1,1.5' && markers(o1)[0] === 2, `clicks ${clicks(o1).join(' ')} | loop starts ${markers(o1).join(' ')}`);

  t = make();
  t.setLoop(true, SR, 2 * SR);
  t.r.setTempoPitch(0.8, 0);
  t.setPractice({ ...DEFAULT_PRACTICE, countIn: true, beats, perBar: 4 });
  t.onPlay();
  const o2 = clicks(run(t, 3));
  ok('count-in follows slowed tempo (80% -> 0.625 s beats)', o2.slice(0, 4).join() === '0,0.625,1.25,1.875', o2.join(' '));

  t = make();
  t.setLoop(true, SR, 2 * SR);
  t.setPractice({ ...DEFAULT_PRACTICE, trainer: { on: true, from: 0.7, to: 1, step: 0.1, every: 1 } });
  t.onPlay();
  const tempos: number[] = [];
  let seen = 0;
  run(t, 7, () => {
    if (t.passes !== seen) {
      seen = t.passes;
      tempos.push(t.r.tempo);
    }
  });
  ok('speed trainer: 70% +10% per pass, stops at 100%', tempos.slice(0, 4).join() === '0.8,0.9,1,1', tempos.join(' '));

  // gated on accuracy: the transport never steps on its own — the UI decides after each pass
  t = make();
  t.setLoop(true, SR, 2 * SR);
  t.setPractice({ ...DEFAULT_PRACTICE, trainer: { on: true, from: 0.7, to: 1, step: 0.1, every: 1, gate: 0.9 } });
  t.onPlay();
  run(t, 7);
  ok('gated speed trainer: holds its speed however many passes go by', t.passes >= 3 && Math.abs(t.r.tempo - 0.7) < 1e-9, String(t.r.tempo));

  t = make();
  t.setPractice({ ...DEFAULT_PRACTICE, click: true, clickVol: 0.5, beats, downbeat: 0, perBar: 4 });
  const c = clicks(run(t, 2.2));
  ok('click track on the beats', c.join() === '0,0.5,1,1.5,2', c.join(' '));
}

// ---- 5e. beat detection on a synthetic drum track
{
  let s0 = 5;
  const rnd = () => (s0 = (s0 * 16807) % 2147483647) / 2147483647 - 0.5;
  const secs = 30;
  const bpm = 118;
  const x = new Float32Array(secs * SR);
  const truth: number[] = [];
  for (let k = 0, t = 0.4; t < secs - 1; k++, t += 60 / bpm) {
    truth.push(t);
    const i0 = Math.round(t * SR);
    for (let i = 0; i < 0.12 * SR; i++) {
      const tt = i / SR;
      const kick = k % 4 === 0 ? 0.9 : k % 4 === 2 ? 0.6 : 0;
      x[i0 + i] += kick * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-tt * 40)) * tt) * Math.exp(-tt * 18);
      if (k % 2) x[i0 + i] += 0.5 * rnd() * Math.exp(-tt * 25);
      x[i0 + i] += 0.15 * rnd() * Math.exp(-tt * 90);
    }
  }
  const a = analyse(x);
  const hits = truth.filter((b) => a.beats.some((d) => Math.abs(d - b) < 0.03)).length;
  const bar = truth.some((b, i) => i % 4 === 0 && Math.abs(b - a.beats[a.downbeat]) < 0.03);
  ok('beat detection: tempo, beats and bar start', Math.abs(a.bpm - bpm) < 0.5 && hits >= truth.length - 1 && bar, `${a.bpm} BPM, ${hits}/${truth.length} beats, bar ${bar}`);
}

// ---- 5g. note view: one bin per semitone
{
  const peakNote = (midi: number) => {
    const f = 440 * 2 ** ((midi - 69) / 12);
    const x = new Float32Array(SR * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / SR));
    const c = cqt(x);
    const row = c.data.subarray(Math.round(CQT_FPS) * BINS, (Math.round(CQT_FPS) + 1) * BINS);
    let best = 0;
    for (let b = 0; b < BINS; b++) if (row[b] > row[best]) best = b;
    const next = Math.max(row[best - 1] ?? 0, row[best + 1] ?? 0);
    return { note: best + NOTE_LO, sep: 10 * Math.log10(row[best] / next) };
  };
  const r = [28, 45, 69, 93].map(peakNote);
  ok('note view finds pure tones (E1, A2, A4, A6)', r.every((x, i) => x.note === [28, 45, 69, 93][i] && x.sep > 10), r.map((x) => `${x.note} ${x.sep.toFixed(0)} dB`).join(', '));
  const hi = cqt(new Float32Array(SR * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 15000 * i) / SR)));
  ok('note view ignores a 15 kHz tone (no aliasing)', Math.max(...hi.data) < 0.0625 * 1e-4);
}

// ---- 5h. chord detection on a synthetic band (keys + bass + melody)
{
  const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, Bb: 10, Eb: 3, Ab: 8, 'F#': 6, 'C#': 1 };
  const beat = 60 / 110;
  const band = (prog: string[]) => {
    const n = Math.ceil((prog.length * 4 * beat + 1) * SR);
    const harm = new Float32Array(n);
    const bass = new Float32Array(n);
    const tone = (x: Float32Array, midi: number, s: number, e: number, amp: number) => {
      const f = 440 * 2 ** ((midi - 69) / 12);
      for (let i = Math.floor(s * SR); i < Math.min(n, e * SR); i++) {
        const t = i / SR - s;
        let v = 0;
        for (let hh = 1; hh <= 5; hh++) v += Math.sin(2 * Math.PI * f * hh * t) / hh;
        x[i] += amp * v * Math.exp(-t * 1.5) * Math.min(1, t * 200);
      }
    };
    prog.forEach((ch, ci) => {
      const minor = ch.endsWith('m');
      const root = NOTE[minor ? ch.slice(0, -1) : ch];
      const t0 = ci * 4 * beat;
      for (const iv of [0, minor ? 3 : 4, 7]) tone(harm, 60 + root + iv - (root > 6 ? 12 : 0), t0, t0 + 4 * beat, 0.07);
      for (let b = 0; b < 4; b++) tone(bass, 36 + root + (b === 3 ? 7 : 0), t0 + b * beat, t0 + (b + 0.9) * beat, 0.25);
    });
    const beats = Array.from({ length: prog.length * 4 }, (_, i) => i * beat);
    return { harm, bass, beats };
  };
  const prog = ['C', 'G', 'Am', 'F', 'Dm', 'E', 'Am', 'Am'];
  const b = band(prog);
  const ch = detectChords(cqt(b.harm), b.beats, cqt(b.bass), { downbeat: 0, perBar: 4 });
  const names = ch.filter((c) => c.root >= 0).map((c) => chordName(c));
  ok('chords: C G Am F Dm E Am (with bass stem)', names.join(' ') === 'C G Am F Dm E Am', names.join(' '));
  const mix = b.harm.map((v, i) => v + b.bass[i]);
  const m2 = detectChords(cqt(mix), b.beats, undefined, { downbeat: 0, perBar: 4 })
    .filter((c) => c.root >= 0)
    .map((c) => chordName(c));
  ok('chords: same from the full mix', m2.join(' ') === 'C G Am F Dm E Am', m2.join(' '));
  ok(
    'chord names: shift, sharps, slash',
    chordName({ root: 1, q: 'm' }, 0, true) === 'C♯m' && chordName({ root: 0, q: '' }, 2) === 'D' && chordName({ root: 0, q: '', bass: 4 }) === 'C/E' && prefersSharps({ tonic: 4, mode: 'minor' }) && !prefersSharps({ tonic: 5, mode: 'major' }),
  );
  const merged = mergeSame([
    { start: 0, end: 1, root: 0, q: '' },
    { start: 1, end: 2, root: 0, q: '' },
    { start: 2, end: 3, root: 7, q: '' },
  ]);
  ok('chords: neighbours merge after an edit', merged.length === 2 && merged[0].end === 2);
  const sheet = chordSheet({ title: 'T', chords: ch, beats: b.beats, downbeat: 0, perBar: 4, markers: [{ name: 'Verse', time: 0 }] });
  ok('chord chart: one chord per bar, in sections', sheet.includes('[Verse]') && sheet.includes('| C       | G       | Am      | F       |'), sheet.split('\n')[3]);
}

// ---- 5i. audio to MIDI: windowing and note extraction (the model itself is checked in the browser)
{
  const audio = new Float32Array(22050 * 5);
  const w = bpWindows(audio);
  ok('Basic Pitch windows', w.length === 4 && w.every((x) => x.length === BP_WINDOW));
  // Two fake windows of activations: one note (A4) from frame 20 to 60 of the joined output.
  const parts = [0, 1].map(() => new Float32Array(172 * BP_PITCHES));
  const set = (arr: Float32Array[], t: number, p: number, v: number) => (arr[Math.floor(t / 142)][((t % 142) + 15) * BP_PITCHES + p] = v);
  const frames = parts.map((x) => x.slice());
  const onsets = parts.map((x) => x.slice());
  for (let t = 20; t < 60; t++) set(frames, t, 69 - 21, 0.8);
  set(onsets, 20, 69 - 21, 0.9);
  const n = bpUnwrap(frames, BP_PITCHES, 22050 * 3);
  const o = bpUnwrap(onsets, BP_PITCHES, 22050 * 3);
  const notes = bpNotes(n.data, o.data, n.frames);
  ok('Basic Pitch note extraction', notes.length === 1 && notes[0].pitch === 69 && Math.abs(notes[0].start - (20 * 256) / 22050) < 0.01 && Math.abs(notes[0].end - (60 * 256) / 22050) < 0.01, JSON.stringify(notes));
  const line = singleLine([
    { start: 0, end: 1, pitch: 60, amp: 0.8 },
    { start: 0.05, end: 0.9, pitch: 72, amp: 0.4 },
    { start: 1, end: 2, pitch: 62, amp: 0.5 },
  ]);
  ok('one note at a time drops overlapping harmonics', line.map((x) => x.pitch).join() === '60,62');
  const dec = decimate2(new Float32Array(44100).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100)));
  const peak = Math.max(...dec.subarray(1000, 20000));
  ok('resampler keeps a 440 Hz tone', dec.length === 22050 && Math.abs(peak - 1) < 0.01, peak.toFixed(4));

  // ---- tuner: pitch detection ----
  const sineBuf = (freq: number, n: number, sr = 44100) => {
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sr);
    return b;
  };
  const pA3 = detectPitch(sineBuf(220, 4096), 44100);
  ok('pitch detection: 220 Hz tone', !!pA3 && Math.abs(pA3.freq - 220) < 0.5, pA3 ? `${pA3.freq.toFixed(2)} Hz` : 'null');
  if (pA3) {
    const { note, cents } = freqToNote(pA3.freq);
    ok('pitch detection: 220 Hz is A3 (note 57), in tune', note === 57 && Math.abs(cents) <= 2, `note ${note}, ${cents} cents`);
  }
  const pLow = detectPitch(sineBuf(41.2, 4096), 44100);
  ok('pitch detection: low bass note (~41 Hz, E1)', !!pLow && Math.abs(pLow.freq - 41.2) < 1, pLow ? `${pLow.freq.toFixed(2)} Hz` : 'null');
  const pSharp = detectPitch(sineBuf(220 * 2 ** (30 / 1200), 4096), 44100); // 30 cents sharp of A3
  const sharpCents = pSharp ? freqToNote(pSharp.freq).cents : null;
  ok('pitch detection: reads a detuned note as sharp', sharpCents != null && sharpCents > 15 && sharpCents < 45, `${sharpCents} cents`);
  ok('pitch detection: silence gives no reading', detectPitch(new Float32Array(4096), 44100) === null);
  const mid = writeMidi([{ name: 'Bass', notes: [{ start: 0, end: 0.5, pitch: 40, amp: 1 }] }], 120);
  const txt = String.fromCharCode(...mid.subarray(0, 4));
  ok('MIDI file header', txt === 'MThd' && mid[9] === 1 && mid[11] === 2 && mid[mid.length - 3] === 0xff && mid[mid.length - 2] === 0x2f);
}

// ---- 5f. key detection on synthetic chord progressions
{
  const NOTE: Record<string, number> = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
  const song = (chords: string[]) => {
    const secs = 2;
    const x = new Float32Array(chords.length * secs * SR);
    chords.forEach((ch, ci) => {
      const minor = ch.endsWith('m');
      const root = NOTE[minor ? ch.slice(0, -1) : ch];
      for (const n of [root + 48, root + 60, root + 60 + (minor ? 3 : 4), root + 67]) {
        const f = (440 * 2 ** ((n + 12 - 69) / 12)) / 2;
        for (let i = 0; i < secs * SR; i++) {
          let v = 0;
          for (let hh = 1; hh <= 6; hh++) v += Math.sin((2 * Math.PI * f * hh * i) / SR) / hh;
          x[ci * secs * SR + i] += 0.05 * v;
        }
      }
    });
    return x;
  };
  const a = keyName(detectKey(song(['Am', 'Dm', 'E', 'Am', 'F', 'G', 'E', 'Am']))!);
  const e = keyName(detectKey(song(['Eb', 'Ab', 'Bb', 'Eb', 'Cm', 'Ab', 'Bb', 'Eb']))!);
  ok('key detection (A minor, E♭ major)', a === 'A minor' && e === 'E♭ major', `${a}, ${e}`);
  ok('key name after pitch shift', keyName({ tonic: 4, mode: 'major' }, -2) === 'D major' && keyName({ tonic: 9, mode: 'minor' }, 3) === 'C minor');
}

// ---- 6. encoders, decoded by ffmpeg
let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
  console.log('SKIP  encoder checks (ffmpeg not installed)');
}
if (hasFfmpeg) {
  const dir = mkdtempSync(join(tmpdir(), 'steminize-'));
  const x = signal(SR * 5 + 777, 5);
  x[1].fill(0.25, 0, 30000); // constant run exercises CONSTANT subframes
  const decode = (file: string, fmt: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', fmt, '-'], { maxBuffer: 1 << 30 });
  for (const depth of [16, 24] as const) {
    const f = join(dir, `t${depth}.flac`);
    const w = join(dir, `t${depth}.wav`);
    writeFileSync(f, encodeFlac(x, depth, SR));
    writeFileSync(w, encodeWav(x, String(depth) as '16' | '24', SR));
    const fmt = depth === 16 ? 's16le' : 's32le';
    const same = Buffer.compare(decode(f, fmt), decode(w, fmt)) === 0;
    const ratio = readFileSync(f).length / readFileSync(w).length;
    ok(`FLAC ${depth}-bit is lossless`, same, `${Math.round(ratio * 100)}% of WAV size`);
  }
  const w32 = join(dir, 't.wav');
  writeFileSync(w32, encodeWav(x, '32f', SR));
  const f32 = new Float32Array(new Uint8Array(decode(w32, 'f32le')).buffer);
  ok('WAV 32-bit float round-trips', f32.length === x[0].length * 2 && f32[2001] === x[1][1000]);
  const mp3 = join(dir, 't.mp3');
  writeFileSync(mp3, encodeMp3(x, 192, SR));
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=bit_rate,channels', '-of', 'csv=p=0', mp3]).toString();
  const dur = parseFloat(probe.trim().split('\n').pop()!);
  ok('MP3 decodes with right duration', Math.abs(dur - x[0].length / SR) < 0.1, probe.trim().replace(/\n/g, ' | '));
}


// ---- update check: version comparison
ok('version: parses v-prefixed tags', JSON.stringify(parseVersion('v1.12.1')) === '[1,12,1]');
ok('version: ignores a pre-release suffix', JSON.stringify(parseVersion('1.13.0-beta.2')) === '[1,13,0]');
ok('version: newer minor wins over larger patch', isNewer('v1.13.0', '1.12.9'));
ok('version: same is not newer', !isNewer('v1.12.1', '1.12.1'));
ok('version: older is not newer', !isNewer('v1.11.0', '1.12.1'));
ok('version: numeric, not lexical (1.10 > 1.9)', isNewer('1.10.0', '1.9.9'));
const rel = (tag: string, o: { prerelease?: boolean; draft?: boolean } = {}) => ({ tag_name: tag, html_url: `https://github.com/Gerschwin/steminize/releases/tag/${tag}`, ...o });
ok('update: a 0.x install is offered a newer 0.x pre-release', pickUpdate([rel('v0.9.1', { prerelease: true })], '0.9.0')?.tag_name === 'v0.9.1');
ok('update: ...and a full release', pickUpdate([rel('v1.0.0')], '0.9.0')?.tag_name === 'v1.0.0');
ok("update: ...but not the old v1.x pre-release left from before renumbering", pickUpdate([rel('v1.9.0', { prerelease: true })], '0.9.0') === null);
ok('update: drafts are never offered', pickUpdate([rel('v0.9.1', { draft: true })], '0.9.0') === null);
ok('update: a 1.x install is not offered pre-releases', pickUpdate([rel('v1.1.0', { prerelease: true })], '1.0.0') === null && pickUpdate([rel('v1.1.0')], '1.0.0')?.tag_name === 'v1.1.0');
ok('update: the highest eligible version wins whatever the list order', pickUpdate([rel('v0.9.1', { prerelease: true }), rel('v0.9.3', { prerelease: true }), rel('v0.9.2', { prerelease: true })], '0.9.0')?.tag_name === 'v0.9.3');
ok('update: nothing newer, nothing offered', pickUpdate([rel('v0.9.0', { prerelease: true })], '0.9.0') === null);
ok('version: garbage is never newer', !isNewer('latest', '1.0.0') && !isNewer('1.0.1', 'dev'));

// ---- latency measurement: clicks played at known frames, heard again after a delay
{
  const rate = 44100;
  const click = (buf: Float32Array, at: number, amp = 0.5) => {
    for (let i = 0; i < 220; i++) if (at + i < buf.length) buf[at + i] += amp * Math.sin(i * 0.9) * (1 - i / 220);
  };
  const run = (delayMs: number, noise: number, amp: number, drop: number[] = []) => {
    const delay = Math.round((delayMs / 1000) * rate);
    const buf = new Float32Array(rate * 4);
    let s = 7;
    for (let i = 0; i < buf.length; i++) buf[i] = noise * (((s = (s * 16807) % 2147483647) / 2147483647) - 0.5);
    const clicks = [0.5, 1.1, 1.7, 2.3].map((t) => Math.round(t * rate));
    clicks.forEach((c, i) => { if (!drop.includes(i)) click(buf, c + delay, amp); });
    return detectLatency(buf, 0, clicks, rate);
  };
  const a = run(47, 0.004, 0.5);
  ok('latency: finds a 47 ms delay', !!a && Math.abs(a.ms - 47) <= 1, `got ${a?.ms}`);
  const b = run(12, 0.02, 0.4);
  ok('latency: finds a 12 ms delay in a noisy room', !!b && Math.abs(b.ms - 12) <= 1, `got ${b?.ms}`);
  const c = run(180, 0.004, 0.5, [1]);
  ok('latency: copes with one missed click', !!c && Math.abs(c.ms - 180) <= 1 && c.hits === 3, `got ${c?.ms}, ${c?.hits} hits`);
  ok('latency: no clicks heard gives null (not zero)', run(47, 0.004, 0) === null);
  ok('latency: clicks buried in noise give null', run(47, 0.5, 0.05) === null);
}

// ---- take placement: latency shift and punch-out trim
{
  const p = placeTake(1000, 500, 0, 10000);
  ok('placement: no latency starts at the playhead', p.srcStart === 0 && p.dstStart === 500 && p.count === 1000);
  const q = placeTake(1000, 500, 100, 10000);
  ok('placement: latency moves the take earlier', q.dstStart === 400 && q.srcStart === 0 && q.count === 1000);
  const r = placeTake(1000, 50, 200, 10000);
  ok('placement: a take that would start before 0 drops its lead-in', r.dstStart === 0 && r.srcStart === 150 && r.count === 850);
  const t = placeTake(5000, 9000, 0, 10000);
  ok('placement: never runs past the end of the song', t.count === 1000);
  const u = placeTake(5000, 2000, 0, 10000, 3500);
  ok('placement: punch-out trims to the end of the loop', u.count === 1500);
  const v = placeTake(5000, 2000, 300, 10000, 3500);
  ok('placement: punch-out is in song time, after the latency shift', v.dstStart === 1700 && v.count === 1800);
  ok('placement: nothing to copy when the punch end is already past', placeTake(100, 2000, 0, 10000, 1000).count === 0);
  ok('placement: negative latency is ignored', placeTake(100, 500, -50, 10000).dstStart === 500);
  const src = [Float32Array.from([1, 2, 3, 4, 5]), Float32Array.from([6, 7, 8, 9, 10])];
  ok('shiftTake: later pads the start and keeps the length', shiftTake(src, 2)[0].join() === '0,0,1,2,3' && shiftTake(src, 2)[1].join() === '0,0,6,7,8');
  ok('shiftTake: earlier drops the start and pads the end', shiftTake(src, -2)[0].join() === '3,4,5,0,0');
  ok('shiftTake: zero is a copy, not the same array', shiftTake(src, 0)[0].join() === '1,2,3,4,5' && shiftTake(src, 0)[0] !== src[0]);
  ok('shiftTake: a shift longer than the take gives silence', shiftTake(src, 9)[0].join() === '0,0,0,0,0' && shiftTake(src, -9)[0].join() === '0,0,0,0,0');
}


// ---- synced lyrics (LRC)
{
  const basic = parseLrc('[ti:Song]\n[ar:Band]\n[00:12.00]First line\n[00:15.50]Second line\n[01:02.25]Third line\n');
  ok('lrc: parses timed lines and skips metadata tags', !!basic && basic.lines.length === 3 && basic.lines[0].text === 'First line' && basic.lines[0].t === 12);
  ok('lrc: minutes and fractions', basic!.lines[1].t === 15.5 && basic!.lines[2].t === 62.25);
  const multi = parseLrc('[00:10.00][01:30.00]Chorus\n[00:20.00]Verse\n[00:25.00]More\n');
  ok('lrc: several timestamps on one line repeat it, in time order', !!multi && multi.lines.map((l) => `${l.t}:${l.text}`).join('|') === '10:Chorus|20:Verse|25:More|90:Chorus');
  const off = parseLrc('[offset:+500]\n[00:10.00]a\n[00:20.00]b\n[00:30.00]c\n');
  ok('lrc: a positive [offset:] shows lines sooner', off!.lines[0].t === 9.5 && off!.lines[2].t === 29.5);
  const neg = parseLrc('[offset:-250]\n[00:01.00]a\n[00:02.00]b\n[00:03.00]c\n');
  ok('lrc: a negative [offset:] shows lines later', neg!.lines[0].t === 1.25);
  const clamp = parseLrc('[offset:+5000]\n[00:01.00]a\n[00:02.00]b\n[00:03.00]c\n');
  ok('lrc: never before zero', clamp!.lines[0].t === 0);
  const enh = parseLrc('[00:05.00]<00:05.00>Word <00:05.40>by <00:05.80>word\n[00:09.00]Two\n[00:12.00]Three\n');
  ok('lrc: word-level tags are dropped', enh!.lines[0].text === 'Word by word');
  const frac = parseLrc('[00:01.5]a\n[00:02.05]b\n[00:03.500]c\n[1:00:00.00]hour\n');
  ok('lrc: 1, 2 and 3 digit fractions, and hours', frac!.lines.map((l) => l.t).join() === '1.5,2.05,3.5,3600');
  ok('lrc: blank timed lines are kept (instrumental gaps)', parseLrc('[00:01.00]a\n[00:05.00]\n[00:09.00]b\n[00:12.00]c\n')!.lines[1].text === '');
  ok('lrc: plain lyrics are not LRC', parseLrc('Just some words\nmore words [chorus]\nand more') === null);
  ok('lrc: too few timed lines is not LRC', parseLrc('[00:01.00]one\n[00:02.00]two\nplain') === null);
  ok('lrc: Windows line endings', parseLrc('[00:01.00]a\r\n[00:02.00]b\r\n[00:03.00]c\r\n')!.lines.length === 3);
  const L = basic!.lines;
  ok('lineAt: before the first line', lineAt(L, 5) === -1);
  ok('lineAt: exactly on a line', lineAt(L, 12) === 0 && lineAt(L, 15.5) === 1);
  ok('lineAt: between lines', lineAt(L, 14.99) === 0 && lineAt(L, 60) === 1);
  ok('lineAt: after the last line', lineAt(L, 9999) === 2);
  ok('lineAt: empty', lineAt([], 3) === -1);
}


// ---- tab+ (Scratchpad tab timing)
{
  let a: TabAnchor[] = [];
  a = addAnchor(a, { charOffset: 20, time: 5 });
  a = addAnchor(a, { charOffset: 0, time: 0 });
  ok('tabSync: addAnchor keeps anchors sorted by charOffset', a.map((x) => x.charOffset).join() === '0,20');
  a = addAnchor(a, { charOffset: 0, time: 1 });
  ok('tabSync: re-tapping the same charOffset replaces its time, not a duplicate', a.length === 2 && a[0].time === 1);

  ok('tabSync: fewer than 2 anchors interpolates to null', charOffsetAt([], 5) === null && charOffsetAt([{ charOffset: 0, time: 0 }], 5) === null);
  const two: TabAnchor[] = [{ charOffset: 0, time: 0 }, { charOffset: 40, time: 4 }];
  ok('tabSync: clamps before the first anchor', charOffsetAt(two, -5) === 0);
  ok('tabSync: clamps after the last anchor', charOffsetAt(two, 999) === 40);
  ok('tabSync: linear interpolation between two anchors', charOffsetAt(two, 1) === 10 && charOffsetAt(two, 2) === 20);
  const three: TabAnchor[] = [{ charOffset: 0, time: 0 }, { charOffset: 10, time: 1 }, { charOffset: 50, time: 5 }];
  ok('tabSync: interpolates within the right pair of three+ anchors', charOffsetAt(three, 3) === 30);
  const unsorted: TabAnchor[] = [{ charOffset: 40, time: 4 }, { charOffset: 0, time: 0 }];
  ok('tabSync: works even if anchors are not passed in time order', charOffsetAt(unsorted, 2) === 20);
  const sameTime: TabAnchor[] = [{ charOffset: 0, time: 2 }, { charOffset: 10, time: 2 }];
  ok('tabSync: two anchors at the same time do not divide by zero', charOffsetAt(sameTime, 2) === 0);

  ok('tabSync: coordAtBpm sits exactly on the anchor at its own time', coordAtBpm({ charOffset: 10, time: 2 }, 60, 2) === 10);
  ok('tabSync: coordAtBpm advances a quarter note (4 sixteenths) per beat at 60 BPM', coordAtBpm({ charOffset: 0, time: 0 }, 60, 1) === 4);
  ok('tabSync: coordAtBpm doubles the rate at double the tempo', coordAtBpm({ charOffset: 0, time: 0 }, 120, 1) === 8);
  ok('tabSync: coordAtBpm extrapolates before the anchor too, unlike charOffsetAt', coordAtBpm({ charOffset: 10, time: 2 }, 60, 1) === 6);

  const text = 'e|----3----|\nB|----0----|\nsecond block here';
  ok('tabSync: rowCol at the very start', JSON.stringify(rowCol(text, 0)) === JSON.stringify({ row: 0, col: 0 }));
  ok('tabSync: rowCol within the first line', JSON.stringify(rowCol(text, 5)) === JSON.stringify({ row: 0, col: 5 }));
  const nl = text.indexOf('\n');
  ok('tabSync: rowCol right after a newline starts the next row at col 0', JSON.stringify(rowCol(text, nl + 1)) === JSON.stringify({ row: 1, col: 0 }));
  ok('tabSync: rowCol carries a fractional offset into a fractional column', rowCol(text, 5.5).col === 5.5);
  ok('tabSync: rowCol clamps to the end of the text', rowCol(text, 9999).row === 2);
  ok('tabSync: rowCol clamps negative offsets to the start', JSON.stringify(rowCol(text, -10)) === JSON.stringify({ row: 0, col: 0 }));
}


// ---- setlists
{
  const A = ['a', 'b', 'c', 'd'];
  ok('setlist: move a song down', moveItem(A, 0, 2).join() === 'b,c,a,d');
  ok('setlist: move a song up', moveItem(A, 3, 1).join() === 'a,d,b,c');
  ok('setlist: out-of-range moves change nothing (and never alias)', moveItem(A, 0, 9).join() === 'a,b,c,d' && moveItem(A, -1, 2) !== A);
  ok('setlist: next song, and the end', nextSong(0, 3) === 1 && nextSong(2, 3) === null && nextSong(-1, 3) === null);
  ok('setlist: previous song stays on the first', prevSong(2) === 1 && prevSong(0) === 0);
  ok('setlist: names are made unique', uniqueName('Setlist', []) === 'Setlist' && uniqueName('Setlist', ['Setlist', 'Setlist 2']) === 'Setlist 3');
  const sl: Setlist = { id: 'x', name: 'Gig', songs: ['a', 'b', 'gone', 'c'], auto: true, gap: 2 };
  const pruned = pruneSongs(sl, new Set(['a', 'b', 'c']));
  ok('setlist: songs deleted from the library are dropped', pruned.songs.join() === 'a,b,c');
  ok('setlist: nothing to prune returns the same object', pruneSongs(pruned, new Set(['a', 'b', 'c'])) === pruned);
  ok('setlist: total running time', totalSeconds(sl, (id) => ({ a: 100, b: 50, c: 30 } as Record<string, number>)[id]) === 180);
  ok('setlist: parses saved data', parseSetlists('[{"id":"1","name":"Gig","songs":["a","b","a"],"auto":false,"gap":5}]').map((l) => `${l.name}:${l.songs.join('')}:${l.auto}:${l.gap}`).join() === 'Gig:ab:false:5');
  ok('setlist: garbage in storage gives no setlists', parseSetlists('nope').length === 0 && parseSetlists('{"a":1}').length === 0 && parseSetlists(null).length === 0);
  ok('setlist: bad entries are skipped, bad gaps defaulted', parseSetlists('[{"id":1},{"id":"2","name":"ok","songs":[],"gap":7}]').map((l) => `${l.id}:${l.gap}:${l.auto}`).join() === '2:2:true');
}

// ---- tab+ column space: which string row you tap must not matter, and only real time columns count
{
  const sys = (n: number) => ['e|' + '-'.repeat(n), 'B|' + '-'.repeat(n), 'G|' + '-'.repeat(n)].join('\n');
  const text = sys(10) + '\n\n' + sys(10); // two systems of three rows, each row 12 wide, 2 of them the label
  const blocks = tabBlocks(text);
  ok('tab columns: blocks are runs of non-blank lines, laid end to end; the row label takes no time', blocks.length === 2 && blocks[0].width === 10 && blocks[1].start === 10 && blocks[1].firstRow === 4);
  const rowStart = (r: number) => text.split('\n').slice(0, r).reduce((n, l) => n + l.length + 1, 0);
  ok('tab columns: the same column in different string rows is the same coordinate', offsetToCoord(text, blocks, rowStart(0) + 5) === 3 && offsetToCoord(text, blocks, rowStart(2) + 5) === 3);
  ok('tab columns: second system continues after the first', offsetToCoord(text, blocks, rowStart(4) + 3) === 11);
  ok('tab columns: an offset on a blank line snaps to the next system', offsetToCoord(text, blocks, rowStart(3)) === 10);
  const place = coordToPlace(blocks, 11);
  ok('tab columns: coordinate maps back to a system and column', place?.firstRow === 4 && place.lastRow === 6 && place.col === 3);
  // start of tab (row 0, col 0) at 0 s, end of the LAST ROW of the LAST system at 24 s
  const anchors: TabAnchor[] = [
    { charOffset: 0, time: 0 },
    { charOffset: text.length, time: 24 },
  ];
  const mid = tabPositionAt(text, anchors, 12);
  ok('tab columns: halfway in time is halfway through the whole tab, not down the rows', mid?.firstRow === 4 && mid.col === 2);
  const q = tabPositionAt(text, anchors, 6);
  ok('tab columns: a quarter through sits inside the first system', q?.firstRow === 0 && Math.abs((q?.col ?? 0) - 7) < 1e-9);

  // bar lines and the second digit of a two-digit fret take space on the page but no time
  const t2 = 'e|-12-|-3-|\nB|----|---|';
  const b2 = tabBlocks(t2);
  ok('tab columns: bar lines, labels and continuation digits are zero-width', b2[0].width === 6 && b2[0].chars === 11);
  ok('tab columns: a two-digit fret is one column of time', offsetToCoord(t2, b2, 3) === 1 && offsetToCoord(t2, b2, 5) === 2);
  ok('tab columns: a tap on a bar line means the start of the next bar', offsetToCoord(t2, b2, 6) === 3 && offsetToCoord(t2, b2, 7) === 3);
  ok('tab columns: the cursor skips the bar line and the continuation digit', coordToPlace(b2, 3)?.col === 7 && coordToPlace(b2, 2)?.col === 5);
  const bend = tabBlocks('e|-7b9r7-|\nB|--------|');
  ok('tab columns: a bend (7b9r7) is one note, not five columns of time', bend[0].width === 3);
  const chordBend = tabBlocks('e|-7b9-|\nB|-5-7-|');
  ok('tab columns: another string starting a note under a bend keeps its column', chordBend[0].counts.slice(2, 7).join() === 'true,true,false,true,true' && chordBend[0].width === 4);
  const bracket = tabBlocks('e|-(7)-|\nB|------|');
  ok('tab columns: brackets around a note take no time', bracket[0].width === 3);
  const slide = tabBlocks('e|-5/7-|\nB|------|');
  ok('tab columns: slides and hammer-ons keep their columns', slide[0].width === 5);
  ok('tab columns: the cursor at the very end sits after the last time column', coordToPlace(b2, 6)?.col === 10);
}

// ---- tab+ taps: move, lock, remove
{
  const base: TabAnchor[] = [
    { charOffset: 2, time: 1 },
    { charOffset: 30, time: 5 },
    { charOffset: 60, time: 9 },
  ];
  ok('taps: moving a tap changes only its time', moveAnchor(base, 30, 6).map((a) => a.time).join() === '1,6,9');
  const locked = toggleAnchorLock(base, 30);
  ok('taps: locking marks just that tap', isLockedAt(locked, 30) && !isLockedAt(locked, 2));
  ok('taps: a locked tap cannot be moved', moveAnchor(locked, 30, 7).find((a) => a.charOffset === 30)?.time === 5);
  ok('taps: a locked tap is not replaced by re-tapping the same spot', addAnchor(locked, { charOffset: 30, time: 5.5 }).find((a) => a.charOffset === 30)?.time === 5);
  ok('taps: a locked tap cannot be removed', removeAnchor(locked, 30).length === 3);
  ok('taps: removing an unlocked tap drops it', removeAnchor(base, 30).map((a) => a.charOffset).join() === '2,60');
  const unlocked = toggleAnchorLock(locked, 30);
  ok('taps: unlocking allows edits again and leaves no stray flag', !isLockedAt(unlocked, 30) && !('locked' in unlocked[1]) && moveAnchor(unlocked, 30, 7)[1].time === 7);
}

// ---- tab+ scroll strip
{
  const text = 'e|-1-|-2-|\nB|---|---|\n\ne|-3-|-4-|\nB|---|---|';
  const blocks = tabBlocks(text);
  const lay = stripLayout(text, blocks);
  ok('strip: labels are pinned once and stripped from every block', lay.labels.join() === 'e|,B|' && lay.rows[0] === '-1-|-2-|-3-|-4-|' && lay.rows[1] === '---|---|---|---|');
  ok('strip: each block starts where the previous one ended', lay.startOf.join() === '0,8');
  // time columns per block: 6 ('-1-' and '-2-' are 3 each, bar lines zero-width) -> 6 wide
  ok('strip: time 0 is the first note column', coordToStripX(blocks, lay, 0) === 0);
  ok('strip: a whole time column later is the next column', coordToStripX(blocks, lay, 1) === 1);
  ok('strip: crossing a bar line takes its share of the time, not a jump', coordToStripX(blocks, lay, 2.5) === 3);
  ok('strip: the next bar starts exactly on its first time column', coordToStripX(blocks, lay, 3) === 4);
  ok('strip: the second system continues from the first', coordToStripX(blocks, lay, 6) === 8);
  const rhy = 'e|-1-2-|\nB|-----|\n  q q';
  const rhyBlocks = tabBlocks(rhy);
  const rhyStrip = stripLayout(rhy, rhyBlocks);
  ok('strip: the rhythm line is annotation, not a string, so it gets no row of its own', rhyStrip.rows.length === 2);
  ok('strip: its letters do not leak into the tab that is shown', !rhyStrip.rows.join('').match(/[qhwse]/i));

  const padded = stripLayout(text, blocks, 5);
  ok('strip: padding runs the strings on before and after, and shifts every position', padded.rows[0] === '-----' + lay.rows[0] + '-----' && padded.startOf.join() === '5,13' && coordToStripX(blocks, padded, 0) === 5);
  ok('strip: bar numbers sit at each bar start and count through every system', lay.header.trimEnd() === '1   2   3   4' && padded.header.slice(5).trimEnd() === '1   2   3   4');
  ok('strip: speed never goes backwards', (() => { let last = -1; for (let c = 0; c <= 12; c += 0.25) { const x = coordToStripX(blocks, lay, c); if (x < last) return false; last = x; } return true; })());
}

// ---- tab+ rhythm line: exact note lengths
{
  const t = 'e|-------|-------|\nB|-------|-------|\nE|1-2-3-4|5-6-7-8|\n  q q q q|q q q q';
  // (the rhythm line has a stray '|' so this is NOT a rhythm line: bar lines belong to string rows only)
  ok('rhythm: a line with bar lines in it is not a rhythm line', tabBlocks(t)[0].events === undefined);

  const tab = 'e|-------|-------|\nB|-------|-------|\nE|1-2-3-4|5-6-7-8|\n  q q q q q q q q';
  const b = tabBlocks(tab)[0];
  ok('rhythm: a last line of rhythm letters gives the block exact events', !!b.events && b.events.length === 8 && b.width === 32);
  ok('rhythm: events sit at the note columns, four sixteenths per quarter', b.events!.map((e) => e.col).join() === '2,4,6,8,10,12,14,16' && b.events!.map((e) => e.u).join() === '0,4,8,12,16,20,24,28');
  ok('rhythm: the cursor sweeps evenly through a quarter note', coordToPlace([b], 2)?.col === 3 && coordToPlace([b], 8)?.col === 6);
  ok('rhythm: the cursor crosses a bar line at the speed of the notes', coordToPlace([b], 14)?.col === 8 + (2 / 4) * 2);

  // uneven lengths: eighth, eighth, quarter, half in one bar (16 sixteenths)
  const uneven = tabBlocks('e|-------|\nE|1-2-3-4|\n  e e q h')[0];
  ok('rhythm: uneven lengths put each note at its exact time', uneven.events!.map((e) => e.u).join() === '0,2,4,8' && uneven.width === 16);
  ok('rhythm: half way through the long note is half way to the next column', coordToPlace([uneven], 10)?.col === 8 + (2 / 8) * (uneven.chars - 8));
  ok('rhythm: a tap on the first column of the bar is time 0, and on the 4th note is 8', offsetToCoord('e|-------|\nE|1-2-3-4|\n  e e q h', [uneven], 11 + 8) === 8);

  // rests: an upper-case letter with no note under it takes time
  const rest = tabBlocks('e|-------|\nE|1---2--|\n  q Q q')[0];
  ok('rhythm: an upper-case letter is a rest that takes its time', rest.events!.length === 3 && rest.events![1].rest && rest.events![2].u === 8);

  // one letter repeats for the notes that follow
  const inherit = tabBlocks('e|-------|\nE|1-2-3-4|\n  e')[0];
  ok('rhythm: notes with no letter repeat the last length', inherit.events!.map((e) => e.d).join() === '2,2,2,2');

  // dotted
  const dotted = tabBlocks('e|-----|\nE|1---2|\n  q. e')[0];
  ok('rhythm: a dot makes the note half as long again', dotted.events![0].d === 6 && dotted.events![1].u === 6);

  // parsing to notes
  const notes = parseTab('e|0---|\nB|----|\nG|----|\nD|----|\nA|----|\nE|--3-|');
  ok('parse: notes get standard-tuning pitches', notes.length === 2 && notes[0].midi === 64 && notes[1].midi === 43);
  const bendNotes = parseTab('e|-7b9-|\nB|-----|\nG|-----|\nD|-----|\nA|-----|\nE|-----|');
  ok('parse: a bend is one note at its starting fret', bendNotes.length === 1 && bendNotes[0].fret === 7 && bendNotes[0].midi === 71);
  const two = parseTab('e|-12-|\nB|----|\nG|----|\nD|----|\nA|----|\nE|----|');
  ok('parse: a two-digit fret is read whole', two.length === 1 && two[0].fret === 12);
  const timed = parseTab('e|0-0-|\nB|----|\nG|----|\nD|----|\nA|----|\nE|----|\n  q q');
  ok('parse: a rhythm line gives each note its length', timed.length === 2 && timed[0].length === 4 && timed[1].start === 4);
}

// ---- tab+ rhythm editing: click a note in Follow along, press a key to set its length
{
  const text = 'e|--0---3---|\nB|-----------|\nG|-----------|\nD|-----------|\nA|-----------|\nE|-----------|';
  const notes = parseTab(text);
  ok('tabSync: findNoteAt finds a note by its bar and column', findNoteAt(notes, 0, 4)?.fret === 0 && findNoteAt(notes, 0, 8)?.fret === 3);
  ok('tabSync: findNoteAt is undefined off any note', findNoteAt(notes, 0, 5) === undefined);

  const mkNote = (bar: number, col: number, start: number): TabNote => ({ block: 0, string: 0, fret: 0, midi: null, col, start, length: 4, bar });
  const cols = noteCols([mkNote(0, 4, 0), mkNote(0, 8, 4), mkNote(0, 4, 0), mkNote(1, 4, 8)]); // a chord (two notes sharing a start) plus two later notes, given out of order
  ok('tabSync: noteCols collapses a chord to one entry', cols.length === 3);
  ok(
    'tabSync: noteCols sorts by playing order regardless of input order',
    cols[0].bar === 0 && cols[0].col === 4 && cols[1].bar === 0 && cols[1].col === 8 && cols[2].bar === 1 && cols[2].col === 4,
  );

  const block = tabBlocks(text)[0];
  const added = setRhythmLetter(text, block, 4, 'q');
  ok('setRhythmLetter: inserts a new rhythm line for a block that has none', added.text.split('\n')[6] === '    q');
  ok('setRhythmLetter: a fresh insertion grows by the whole new line plus its newline', added.grew === 6 && added.insertAt === text.length + 1);

  const withRhythm = added.text; // one block, rhythm line now "    q" (just the first note set)
  const edited = setRhythmLetter(withRhythm, tabBlocks(withRhythm)[0], 8, 'e');
  ok('setRhythmLetter: pads a short existing line out to reach a later column', edited.text.split('\n')[6][8] === 'e' && edited.text.split('\n')[6][4] === 'q');

  const replaced = setRhythmLetter(edited.text, tabBlocks(edited.text)[0], 4, 'h');
  ok('setRhythmLetter: replaces an existing letter in place at the same length', replaced.text.split('\n')[6][4] === 'h' && replaced.grew === 0);

  const dottedText = withRhythm.replace('    q', '    q.');
  const undotted = setRhythmLetter(dottedText, tabBlocks(dottedText)[0], 4, 'e');
  ok('setRhythmLetter: clears a trailing dot when the base letter changes', undotted.text.split('\n')[6] === '    e');
}

// ---- tab+ playing techniques: h p b r / \\ ~ t, read off the text for drawing
{
  const six = (e: string) => `e|${e}|\nB|${'-'.repeat(e.length)}|\nG|${'-'.repeat(e.length)}|\nD|${'-'.repeat(e.length)}|\nA|${'-'.repeat(e.length)}|\nE|${'-'.repeat(e.length)}|`;
  const t = (e: string) => parseScore(six(e)).notes;
  const ho = t('-5h7-7p5-5/7-9\\7-');
  ok('technique: h, p, / and \\ link a note to the one before it', ho.map((n) => n.link ?? '').join() === ',h,,p,,/,,\\');
  ok('technique: the first note of a pair carries no link', ho[0].link === undefined && ho[2].link === undefined);
  const bend = t('-7b9r7-5b6-')[0];
  ok('technique: a bend with a release', bend.bend?.to === 9 && bend.bend?.release === 7 && bend.fret === 7);
  ok('technique: a bend without a release', t('-7b9r7-5b6-')[1].bend?.to === 6 && t('-7b9r7-5b6-')[1].bend?.release === undefined);
  ok('technique: a bend is still just the one note', t('-7b9r7-5b6-').length === 2);
  ok('technique: ~ and v after a fret are vibrato', t('-7~-5v-')[0].vibrato === true && t('-7~-5v-')[1].vibrato === true && t('-7-')[0].vibrato === undefined);
  ok('technique: t before a fret is a tap', t('-t12-5-')[0].tap === true && t('-t12-5-')[0].fret === 12 && t('-t12-5-')[1].tap === undefined);
  ok('technique: a plain note has none of them', Object.keys(t('-5-')[0]).every((k) => !['bend', 'link', 'vibrato', 'tap'].includes(k)));
  const tapTimed = parseScore(six('-t5---5-')); // the t takes no time of its own
  ok('technique: a tap marker takes no time, so the note starts where it would without it', tapTimed.notes[0].start === parseScore(six('-5----5-')).notes[0].start);
}

// ---- tab+ more notation: pre-bends, harmonics, repeats, and picking/fingering/palm-mute lines
{
  const strs = (e: string, extra: Record<string, string> = {}) => ['e', 'B', 'G', 'D', 'A', 'E'].map((l, i) => `${l}|${i === 0 ? e : extra[l] ?? '-'.repeat(e.length)}|`).join('\n');
  const one = (e: string) => parseScore(strs(e)).notes[0];
  ok('pre-bend: 7pb9 is one note, pre-bent to 9', one('-7pb9---').bend?.pre === true && one('-7pb9---').bend?.to === 9 && parseScore(strs('-7pb9---')).notes.length === 1);
  ok('pre-bend: released after, 7pb9r7', one('-7pb9r7--').bend?.release === 7 && one('-7pb9r7--').bend?.pre === true);
  ok('pre-bend: a plain bend is not a pre-bend', one('-7b9----').bend?.pre === undefined);
  ok('harmonic: 12(h) natural, 12(ph) pinch', one('-12(h)--').harmonic === 'natural' && one('-12(ph)-').harmonic === 'pinch' && one('-12-----').harmonic === undefined);
  ok('harmonic: the marker takes no time', parseScore(strs('-5(h)-5---')).notes[1].start === parseScore(strs('-5-5-----')).notes[1].start);
  ok('tap: a capital T works as well as t', one('-T12----').tap === true && one('-t12----').tap === true);

  const rep2 = parseScore('e|*-5-|-5-*|\nB|*---|---*|');
  ok('repeat: * just inside the opening bar line starts a repeat, just inside the closing one ends it', rep2.bars.length === 2 && rep2.bars[0].repeatStart === true && rep2.bars[0].repeatEnd === undefined && rep2.bars[1].repeatEnd === true && rep2.bars[1].repeatStart === undefined);
  ok('repeat: an asterisk takes no time', rep2.notes[0].start === parseScore('e|-5-|\nB|---|').notes[0].start);

  const withAnn = parseScore(['  D U D', 'e|-5-7-5-|', 'B|-------|', 'G|-------|', 'D|-------|', 'A|-------|', 'E|-------|', '  1 3 1', '    q q q'].join('\n'));
  ok('annotation lines: pick/finger rows are not strings, so the notes are the same', withAnn.notes.length === 3 && withAnn.notes.map((n) => n.fret).join() === '5,7,5');
  ok('annotation lines: block knows its string and annotation rows', tabBlocks(['  D U D', 'e|-5-7-5-|', 'B|-------|', 'G|-------|', 'D|-------|', 'A|-------|', 'E|-------|', '  1 3 1'].join('\n'))[0].stringFirst === 1);
  const above = withAnn.notes.map((n) => n.marks?.map((m) => m.kind + m.text + (m.above ? '^' : 'v')).join('') ?? '');
  ok('annotation lines: D/U above and 1-4 below attach to the notes beneath them', above.join() === 'pickD^lh1v,pickU^lh3v,pickD^lh1v');
  const rh = parseScore(['e|-5---7--|', 'B|--------|', 'G|--------|', 'D|--------|', 'A|--------|', 'E|--------|', '  [1] [3]', '  PM---'].join('\n'));
  ok('annotation lines: [1]-[4] are right-hand fingers, PM-- a palm-mute run over the notes it spans', rh.notes[0].marks?.[0]?.kind === 'rh' && rh.notes[0].marks?.[0]?.text === '1' && rh.notes[0].pm?.below !== undefined && rh.notes[0].pm?.above === undefined && rh.notes[1].pm === undefined);
  const fretsOnly = parseScore('e|5-7|\nB|-1-|');
  ok('annotation lines: a barless row that is a real fret row in the middle still counts as a string', parseScore('e|5-7|\nB|---|\n1-2\nE|---|').notes.length >= 2 && fretsOnly.notes.length === 3);
}

// ---- tab+ repeats (played back as repeated) and bends (judged by pitch)
{
  const bars = (txt: string) => parseScore(txt).bars;
  const none = repeatPlan(bars('e|-5-7-|-5-7-|\nB|-----|-----|'));
  ok('repeat: no repeat signs, no plan', none === null);
  const rep = bars('e|*-5-7-|-5-7-|-5-7-*|\nB|*-----|-----|-----*|');
  const plan = repeatPlan(rep)!;
  ok('repeat: the section is played twice by default', plan.total === rep.reduce((n, b) => n + b.length, 0) * 2);
  ok('repeat: an x3 over the closing bar plays it three times', repeatPlan(parseScore('     x3\ne|*-5-7-*|\nB|*-----*|').bars)!.total === parseScore('e|*-5-7-*|\nB|*-----*|').bars[0].length * 3);
  ok('repeat: the count is read off the bar it sits over', parseScore('          x4\ne|-5-7-|-5-7-*|\nB|-----|-----*|').bars[1].repeatCount === 4);
  const one = bars('e|*-5-7-*|-5-7-|\nB|*-----*|-----|');
  const p1 = repeatPlan(one)!;
  const len = one[0].length;
  ok('repeat: first time through, position is just position', fromUnrolled(p1, 2) === 2 && toUnrolled(p1, 2) === 2);
  ok('repeat: the second time through, position jumps back to the start of the section', fromUnrolled(p1, len + 2) === 2);
  ok('repeat: what comes after continues from where it would have been', fromUnrolled(p1, len * 2 + 1) === len + 1);
  ok('repeat: a tap after the repeat counts both passes', toUnrolled(p1, len + 1) === len * 2 + 1);
  ok('repeat: an unmarked start repeats from the beginning', repeatPlan(bars('e|-5-|-7-*|\nB|---|---*|'))!.total === bars('e|-5-|-7-|\nB|---|---|').reduce((n, b) => n + b.length, 0) * 2);
  ok('repeat: past the end carries on beyond the written tab', fromUnrolled(p1, p1.total + 3) === p1.end + 3);

  const nt = (e: string) => parseScore(`e|${e}|\nB|${'-'.repeat(e.length)}|\nG|${'-'.repeat(e.length)}|\nD|${'-'.repeat(e.length)}|\nA|${'-'.repeat(e.length)}|\nE|${'-'.repeat(e.length)}|`).notes[0];
  ok('bend: a plain note is accepted at just its own pitch', acceptedMidis(nt('-5---')).length === 1 && acceptedMidis(nt('-5---'))[0] === nt('-5---').midi);
  const bend = nt('-7b9---');
  ok('bend: a bend is right at its start or at the bent-to pitch', acceptedMidis(bend).join() === [bend.midi!, bend.midi! + 2].join());
  const rel = nt('-7b9r7--');
  ok('bend: a released bend is also right at the pitch it comes back to', acceptedMidis(rel).join() === [rel.midi!, rel.midi! + 2, rel.midi!].join());
  const pre = nt('-7pb9--');
  ok('bend: a pre-bend is only right at the bent-to pitch', acceptedMidis(pre).join() === [pre.midi! + 2].join());
  ok('bend: a muted note has no pitch to accept', acceptedMidis(nt('-x---')).length === 0);
}

// ---- tab+ palm-mute runs above and below at once, and joins across a bar line
{
  const rows = (e: string) => ['e|' + e, ...['B', 'G', 'D', 'A', 'E'].map((l) => l + '|' + e.replace(/[^|]/g, '-'))].join('\n');
  const both = parseScore(['  PM---', rows('-5-7-5-7-|'), '  PM---'].join('\n'));
  ok('palm mute: a run above and a run below can cover the same notes', both.notes[0].pm?.above !== undefined && both.notes[0].pm?.below !== undefined && both.notes[0].pm?.above !== both.notes[0].pm?.below);
  const two = parseScore(['  PM--  PM--', rows('-5-7-5-7-|')].join('\n'));
  ok('palm mute: two runs on one line are two runs', two.notes[0].pm?.above !== two.notes[2].pm?.above && two.notes[0].pm?.above === two.notes[1].pm?.above);
  const across = parseScore(rows('-5h|7-5-|-5-|'));
  ok('across a bar line: 5h|7 joins the 7 to the 5 before the bar line', across.notes[1].link === 'h' && across.notes[1].bar === 1 && across.notes[0].bar === 0);
  ok('across a bar line: slides too', parseScore(rows('-5/|7--|')).notes[1].link === '/' && parseScore(rows('-9\\|7--|')).notes[1].link === '\\');
  ok('across a bar line: a lone bar line before a note joins nothing', parseScore(rows('-5-|7--|')).notes[1].link === undefined);
}

// ---- speed trainer gated on the tab Trainer's accuracy
{
  ok('gate: a pass at or above the target steps up when one clean pass is enough', gateStep(0, 9, 10, 0.9, 1).step === true);
  ok('gate: a pass below the target holds, and spoils the run', gateStep(2, 8, 10, 0.9, 3).step === false && gateStep(2, 8, 10, 0.9, 3).clean === 0);
  const r1 = gateStep(0, 10, 10, 0.9, 3);
  const r2 = gateStep(r1.clean, 10, 10, 0.9, 3);
  const r3 = gateStep(r2.clean, 10, 10, 0.9, 3);
  ok('gate: needs `every` clean passes in a row, then the count starts again', !r1.step && !r2.step && r3.step && r3.clean === 0);
  ok('gate: a pass with nothing judged neither counts nor spoils the run', gateStep(2, 0, 0, 0.9, 3).clean === 2 && gateStep(2, 0, 0, 0.9, 3).step === false);
  ok('gate: exactly on the target counts', gateStep(0, 9, 10, 0.9, 1).step && gateStep(0, 17, 20, 0.85, 1).step);
}

// ---- tab bar -> song time (for looping a bar from its number)
{
  const one: TabAnchor[] = [{ charOffset: 4, time: 2 }];
  ok('bar loop: with one tap and a tempo, time is exact (a quarter is 60/bpm seconds)', timeAtCoord(one, 120, 4) === 2 && Math.abs(timeAtCoord(one, 120, 8)! - 2.5) < 1e-9);
  ok('bar loop: and it is the exact inverse of coordAtBpm', Math.abs(coordAtBpm(one[0], 100, timeAtCoord(one, 100, 13)!) - 13) < 1e-9);
  const two: TabAnchor[] = [{ charOffset: 0, time: 1 }, { charOffset: 16, time: 3 }, { charOffset: 32, time: 7 }];
  ok('bar loop: between taps it interpolates', timeAtCoord(two, undefined, 8) === 2 && timeAtCoord(two, undefined, 24) === 5);
  ok('bar loop: outside the taps it clamps to the first/last', timeAtCoord(two, undefined, -5) === 1 && timeAtCoord(two, undefined, 99) === 7);
  ok('bar loop: and is the inverse of charOffsetAt', Math.abs(charOffsetAt(two, timeAtCoord(two, undefined, 21)!)! - 21) < 1e-9);
  ok('bar loop: nothing to go on without taps, or one tap and no tempo', timeAtCoord([], 120, 4) === null && timeAtCoord(one, undefined, 4) === null);
}

// ---- tab+ score: bars for the staff view
{
  const sc = parseScore('e|0-0-|0-0-|\nB|----|----|\nG|----|----|\nD|----|----|\nA|----|----|\nE|----|----|\n  q q  q q');
  ok('score: a rhythm line gives each bar its start and exact length', sc.bars.length === 2 && sc.bars[0].start === 0 && sc.bars[0].length === 8 && sc.bars[1].start === 8);
  ok('score: notes know which bar they are in', sc.notes.map((n) => n.bar).join() === '0,0,1,1');
  const plain = parseScore('e|0-0-|0-0-|\nB|----|----|');
  ok('score: without a rhythm line a bar is as long as its columns', plain.bars.length === 2 && plain.bars[0].length === 4 && plain.bars[1].start === 4);
  const two = parseScore('e|0-|\nB|--|\n\ne|0-|\nB|--|');
  ok('score: bars carry on counting through every system', two.bars.length === 2 && two.notes[1].bar === 1);

  // a time signature, typed as its own line right before the strings, fixes bar length instead of
  // leaving it to raw column counting
  const noSig = parseScore('e|0-------|\nB|--------|');
  ok('score: without a time signature a bar of 8 raw columns is 8 long', noSig.bars[0].length === 8);
  const sig = parseScore('4/4\ne|0-------|\nB|--------|');
  ok('score: a 4/4 line fixes a bar of 8 raw columns to 16 (a real 4/4 bar) instead', sig.bars.length === 1 && sig.bars[0].start === 0 && sig.bars[0].length === 16);
  ok('score: a note in a rescaled bar is rescaled the same way', sig.notes[0].start === 0 && sig.notes[0].length === 16);
  const sigTwoBars = parseScore('4/4\ne|0-------|3-------|\nB|--------|--------|');
  ok(
    'score: a later bar in the same block starts after the fixed length, not the raw one',
    sigTwoBars.bars.length === 2 && sigTwoBars.bars[1].start === 16 && sigTwoBars.bars[1].length === 16 && sigTwoBars.notes[1].start === 16,
  );
  const sigWithRhythm = parseScore('4/4\ne|0-0-|0-0-|\nB|----|----|\nG|----|----|\nD|----|----|\nA|----|----|\nE|----|----|\n  q q  q q');
  ok('score: a rhythm line still wins over a time signature (exact lengths, not a guess)', sigWithRhythm.bars[0].length === 8 && sigWithRhythm.bars[1].start === 8);
}

// ---- tab+ staff helpers
{
  ok('staff: lengths split into drawable notes', splitLength(16).join() === 'w' && splitLength(6).join() === 'qd' && splitLength(20).join() === 'w,q' && splitLength(2.5).join() === '8,32');
  ok('staff: guitar is written an octave above where it sounds', vexKey(40) === 'e/3' && vexKey(64) === 'e/5' && vexKey(61) === 'c#/5');
  const map = [{ u: 0, x: 10 }, { u: 4, x: 50 }, { u: 12, x: 130 }];
  ok('staff: the cursor joins note positions with straight lines', staffX(map, 2) === 30 && staffX(map, 8) === 90 && staffX(map, -5) === 10 && staffX(map, 99) === 130);
  {
    const layout = { map: [{ u: 0, x: 10 }, { u: 4, x: 50 }], notes: [{ u: 0, len: 4, x: 10, y: 20, w: 8, h: 30 }], width: 100, height: 60 };
    const attrs: Record<string, string> = {};
    const svg = { setAttribute: (k: string, v: string) => (attrs[k] = v), style: {} as Record<string, string> };
    const big = zoomDrawing({ querySelector: () => svg } as unknown as HTMLElement, layout, 2);
    ok('staff: zooming a drawing scales every position and the picture itself', big.map[1].x === 100 && big.notes[0].y === 40 && big.notes[0].w === 16 && big.width === 200 && big.height === 120 && attrs.width === '200' && attrs.height === '120' && svg.style.width === '200px');
    ok('staff: zoom 1 leaves the layout as it was', zoomDrawing({} as HTMLElement, layout, 1) === layout);
    const paged = { ...layout, rows: [{ y: 0, h: 50, sy: 0, sh: 110, u0: 0, u1: 8, map: [{ u: 0, x: 10 }] }, { y: 60, h: 50, sy: 60, sh: 110, u0: 8, u1: 16, map: [{ u: 8, x: 12 }] }] };
    const bigPaged = zoomDrawing({ querySelector: () => null } as unknown as HTMLElement, paged, 2);
    ok('staff: zooming a page scales its lines too', bigPaged.rows?.[1].y === 120 && bigPaged.rows[1].h === 100 && bigPaged.rows[1].map[0].x === 24 && bigPaged.rows[1].u0 === 8 && bigPaged.rows[1].sy === 120 && bigPaged.rows[1].sh === 220);
  }
  // Wrapping bars into lines
  {
    const widths = [100, 100, 100, 100, 100];
    const rows = planRows(widths, 50, 360);
    ok('page: bars fill a line until the next would not fit, the clef counted on each line', rows.length === 2 && rows[0].bars.join() === '0,1,2' && rows[1].bars.join() === '3,4');
    ok('page: a well-filled line is stretched to the full width', Math.abs(rows[0].widths.reduce((a, b) => a + b, 0) - 360) < 1e-6);
    ok('page: the clef is only extra width on a line\'s first bar, however much it is stretched', rows[0].widths[0] > rows[0].widths[1] && Math.abs(rows[0].widths[1] - rows[0].widths[2]) < 1e-6);
    const sparse = planRows([100, 100, 100, 100], 50, 400);
    ok('page: a short last line is left at its natural width', sparse.length === 2 && sparse[1].widths.join() === '150');
    ok('page: a bar wider than the page still gets a line of its own', planRows([900, 100], 50, 400).map((r) => r.bars.join()).join('|') === '0|1');
    ok('page: no bars, no lines', planRows([], 50, 400).length === 0);
    // Stacked parts share one plan, each bar as wide as the widest part needs
    const stacked = planStack([[100, 100, 100, 100], [80, 140, 80, 80]], 50, 380);
    ok('stack: a bar is as wide as the widest part needs, so the parts\' bar lines line up', stacked.length === 2 && stacked[0].bars.join() === '0,1' && stacked[1].bars.join() === '2,3');
    ok('stack: the same lines for every part, however many parts there are', planStack([[100, 100]], 50, 300).length === planRows([100, 100], 50, 300).length && planStack([], 50, 300).length === 0);
    const lines = [{ y: 0, h: 10, sy: 0, sh: 10, u0: 0, u1: 16, map: [] }, { y: 20, h: 10, sy: 20, sh: 10, u0: 16, u1: 32, map: [] }, { y: 40, h: 10, sy: 40, sh: 10, u0: 32, u1: 48, map: [] }];
    ok('page: a position belongs to the line holding it', pageRowAt(lines, 0) === lines[0] && pageRowAt(lines, 15.9) === lines[0] && pageRowAt(lines, 16) === lines[1] && pageRowAt(lines, 47) === lines[2]);
    ok('page: before the start is the first line, after the end the last', pageRowAt(lines, -3) === lines[0] && pageRowAt(lines, 999) === lines[2]);
  }
}

// ---- tab+ playing trainer: which note(s) are expected right now, and how close a live pitch is
{
  const notes: TabNote[] = [
    { block: 0, string: 0, fret: 0, midi: 64, col: 2, start: 0, length: 4, bar: 0 },
    { block: 0, string: 0, fret: 3, midi: 67, col: 6, start: 4, length: 4, bar: 0 },
    { block: 0, string: 1, fret: 0, midi: 59, col: 2, start: 0, length: 2, bar: 0 }, // a chord with the first note
  ];
  ok('trainer: a plain note is found by its own time window', noteGroupAt(notes, 5).map((n) => n.fret).join() === '3');
  ok('trainer: a chord returns every note that starts together', noteGroupAt(notes, 1).map((n) => n.fret).sort().join() === '0,0');
  ok('trainer: a gap past the last note is a rest — nothing expected', noteGroupAt(notes, 9).length === 0);
  ok('trainer: right at a note\'s start is inside its window, right at its end is not', noteGroupAt(notes, 4).map((n) => n.fret).join() === '3' && noteGroupAt(notes, 8).length === 0);

  ok('pitch: cents distance is 0 dead on', Math.abs(centsFrom(440, 69)) < 1e-6);
  ok('pitch: a semitone sharp is +100 cents', Math.abs(centsFrom(440 * Math.pow(2, 1 / 12), 69) - 100) < 1e-6);
  ok('pitch: an octave flat is -1200 cents', Math.abs(centsFrom(220, 69) + 1200) < 1e-6);
}


// ---- streaming resampler (44.1 kHz songs onto a 48 kHz context)
{
  const f = 1000;
  const src = (n: number) => Math.sin((2 * Math.PI * f * n) / 44100);
  const run = (block: number, total: number) => {
    let at = 0;
    const rs = new StreamResampler(44100, 48000);
    const out = new Float32Array(total);
    const pull = (l: Float32Array, r: Float32Array, n: number) => {
      for (let i = 0; i < n; i++) l[i] = r[i] = src(at + i);
      at += n;
      return true;
    };
    for (let o = 0; o < total; o += block) rs.render(pull, out.subarray(o, o + block), new Float32Array(block), block);
    return out;
  };
  const a = run(128, 4800);
  let worst = 0;
  for (let i = 4; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - Math.sin((2 * Math.PI * f * i) / 48000)));
  ok('resample: a 1 kHz sine at 48 kHz matches the true waveform', worst < 2e-3);
  const b = run(37, 4810);
  let same = true;
  for (let i = 0; i < 4800; i++) if (Math.abs(a[i] - b[i]) > 1e-6) same = false;
  ok('resample: block size does not change the output', same);
  const rs = new StreamResampler(44100, 48000);
  let calls = 0;
  const ended = rs.render((l, r, n) => (l.fill(0), r.fill(0), ++calls < 0), new Float32Array(128), new Float32Array(128), 128);
  ok('resample: reports when the source has ended', ended === false);
  rs.reset();
  ok('resample: reset clears the ended state', rs.render((l, r, n) => true, new Float32Array(64), new Float32Array(64), 64) === true);
}

// ---- tab+ per-bar accuracy colours
{
  const t = new BarTally();
  ok('bars: the first group in a bar finishes nothing', t.group(0, true) === null);
  ok('bars: more groups in the same bar finish nothing', t.group(0, false) === null && t.group(0, true) === null);
  const done = t.group(1, true);
  ok('bars: moving to the next bar finishes the previous bar with its counts', !!done && done.bar === 0 && done.hit === 2 && done.total === 3);
  const rest = t.flush();
  ok('bars: flush finishes the bar in progress', !!rest && rest.bar === 1 && rest.hit === 1 && rest.total === 1);
  ok('bars: a second flush has nothing left', t.flush() === null);
  const again = new BarTally();
  again.group(2, true);
  ok('bars: going back to an earlier bar (a loop) finishes the one just played', again.group(0, false)?.bar === 2);
  ok('bars: percent rounds', barPercent(2, 3) === 67 && barPercent(0, 0) === 0);
  ok('bars: all wrong is red, all right is green', barColour(0, 4) === 'hsl(0 70% 52%)' && barColour(4, 4) === 'hsl(120 70% 52%)');
  ok('bars: half right is amber', barColour(2, 4) === 'hsl(60 70% 52%)');
  ok('bars: a cue that does not need colour: clean, part right, missed', barCue(4, 4) === 'clean' && barCue(17, 20) === 'clean' && barCue(3, 4) === 'partial' && barCue(2, 4) === 'partial' && barCue(1, 4) === 'missed' && barCue(0, 4) === 'missed' && barCue(0, 0) === 'missed');
  ok('bars: the tooltip adds the last result', barTip(4, [3, 4]).endsWith('3 of 4 notes (75%)') && !barTip(4, undefined).includes('Last time'));
}

// ---- the watchdog on the GPU session (a hang on some Windows GPUs)
{
  const never = new Promise<number>(() => {});
  const slow = withTimeout(never, 30, 'Loading the model on the GPU');
  const hung = await slow.then(() => 'resolved', (e: Error) => e.message);
  ok('timeout: a promise that never settles is rejected with what and how long', hung === "Loading the model on the GPU didn't finish within 0.03 s");
  ok('timeout: a quick result passes straight through', (await withTimeout(Promise.resolve(7), 1000, 'x')) === 7);
  const failed = await withTimeout(Promise.reject(new Error('boom')), 1000, 'x').then(() => 'resolved', (e: Error) => e.message);
  ok('timeout: a real failure is passed on, not replaced by the timeout', failed === 'boom');
}

// ---- scratchpad parts (guitar / bass / drums) and the track each is linked to
{
  const demucs4 = ['drums', 'bass', 'other', 'vocals'];
  const demucs6 = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
  ok('parts: three parts', PART_IDS.join() === 'guitar,bass,drums');
  ok('parts: 4-stem Demucs links bass and drums by name', defaultTrack('bass', demucs4) === 'bass' && defaultTrack('drums', demucs4) === 'drums');
  ok('parts: 4-stem Demucs has no guitar track, so guitar links to "other"', defaultTrack('guitar', demucs4) === 'other');
  ok('parts: 6-stem Demucs has a guitar track and it wins over "other"', defaultTrack('guitar', demucs6) === 'guitar');
  const multi = ['Lead Guitar', 'Bass Drum', 'Bass DI', 'Drums Overhead', 'Vox'];
  ok('parts: multitrack names are matched, and "Bass Drum" is not the bass', defaultTrack('bass', multi) === 'Bass DI' && defaultTrack('guitar', multi) === 'Lead Guitar');
  ok('parts: kit / percussion names count as drums', defaultTrack('drums', ['Kit', 'Keys']) === 'Kit' && defaultTrack('drums', ['Perc']) === 'Perc');
  ok('parts: nothing fits gives no link, not a wrong one', defaultTrack('bass', ['Vox', 'Keys']) === undefined && defaultTrack('guitar', ['Vox', 'Keys']) === undefined);
  const six = 'e|-0-|\nB|-0-|\nG|-0-|\nD|-0-|\nA|-0-|\nE|-0-|';
  const four = 'G|-0-|\nD|-0-|\nA|-0-|\nE|-0-|';
  ok('parts: counts strings', stringCount(six) === 6 && stringCount(four) === 4 && stringCount('hello') === 0);
  ok('parts: an added part links only to a track with exactly its name', defaultTrack('part1', ['piano', 'other', 'guitar'], 'Piano') === 'piano' && defaultTrack('part1', ['piano', 'guitar'], '2nd guitar') === undefined && defaultTrack('part1', ['piano'], '') === undefined);
  ok('parts: built-in and added parts are told apart, and drums are the only non-tab kind', isBuiltinPart('bass') && !isBuiltinPart('part1') && partKind('drums') === 'drums' && partKind('part1') === 'tab' && partKind('guitar') === 'tab');
  ok('parts: a new part id is never one already in use', newPartId([]) === 'part1' && newPartId([{ id: 'part1', name: 'a' }]) === 'part2' && newPartId([{ id: 'part2', name: 'b' }, { id: 'part1', name: 'a' }, { id: 'part3', name: 'c' }]) === 'part4');
  ok('parts: an old four-string tab becomes the bass part, six strings or none the guitar part', legacyTabPart(four) === 'bass' && legacyTabPart(six) === 'guitar' && legacyTabPart('') === 'guitar' && legacyTabPart(undefined) === 'guitar');
}

// ---- drum tab: the grid as timed hits
{
  const grid = [
    'HH|x-x-x-x-x-x-x-x-|x-x-x-x-x-x-x-x-|',
    'SD|----o-------o---|----o-------g---|',
    'BD|o-------o-o-----|o---------------|',
  ].join('\n');
  const { notes, bars } = parseDrums(grid);
  ok('drums: two bars of sixteen columns are two bars of sixteen sixteenths', bars.length === 2 && bars[0].start === 0 && bars[0].length === 16 && bars[1].start === 16 && bars[1].length === 16);
  ok('drums: every hit is found, with its voice', notes.filter((n) => n.drum.voice === 'hihat').length === 16 && notes.filter((n) => n.drum.voice === 'snare').length === 4 && notes.filter((n) => n.drum.voice === 'kick').length === 4);
  const kicks = notes.filter((n) => n.drum.voice === 'kick').map((n) => n.start);
  ok('drums: a column is a sixteenth note: the kicks are at 0, 8, 10 and 16', kicks.join() === '0,8,10,16');
  ok('drums: hits are in time order and carry their bar', notes.every((n, i) => i === 0 || notes[i - 1].start <= n.start) && notes.filter((n) => n.bar === 1).every((n) => n.start >= 16));
  ok('drums: pitch is the General MIDI drum number', notes.find((n) => n.drum.voice === 'kick')!.midi === 36 && notes.find((n) => n.drum.voice === 'snare')!.midi === 38 && notes.find((n) => n.drum.voice === 'hihat')!.midi === 42);
  ok('drums: a ghost note is marked', notes.filter((n) => n.drum.style === 'ghost').length === 1);
  ok('drums: a hit lasts until the next hit anywhere', notes.find((n) => n.start === 0 && n.drum.voice === 'kick')!.length === 2 && notes[notes.length - 1].length === 2);
  ok('drums: the row index tells which line a hit is on', notes.find((n) => n.drum.voice === 'hihat')!.string === 0 && notes.find((n) => n.drum.voice === 'kick')!.string === 2);

  const open = parseDrums('HH|x-o-X-O-|').notes;
  ok('drums: hi-hat o is the open hi-hat, with its own MIDI number', open[1].drum.style === 'open' && open[1].midi === 46 && open[0].midi === 42 && open[2].drum.style === 'accent' && open[3].drum.style === 'open');
  ok('drums: o on a snare is just a hit', hitStyle('o', 'snare') === 'normal' && hitStyle('O', 'snare') === 'accent' && hitStyle('-', 'snare') === null && hitStyle(' ', 'kick') === null);

  const eight = parseDrums('4/4\nHH|x-x-x-x-|x-x-x-x-|\nBD|o---o---|o---o---|');
  ok('drums: a 4/4 line fits an eight-column bar to a whole bar', eight.bars.length === 2 && eight.bars[0].length === 16 && eight.bars[1].start === 16 && eight.notes.filter((n) => n.drum.voice === 'hihat').map((n) => n.start).slice(0, 4).join() === '0,4,8,12');

  const labelled = parseDrums('1 e + a 2 e + a\nHH|x-x-x-x-|\nSN|----x---|');
  ok('drums: a counting line above the grid is skipped', labelled.notes.length === 5 && labelled.notes.every((n) => n.string <= 1));
  ok('drums: labels in the usual abbreviations are understood', voiceOfLabel('CC') === 'crash' && voiceOfLabel('RC') === 'ride' && voiceOfLabel('HH') === 'hihat' && voiceOfLabel('SN') === 'snare' && voiceOfLabel('SD') === 'snare' && voiceOfLabel('HT') === 'hightom' && voiceOfLabel('MT') === 'midtom' && voiceOfLabel('FT') === 'floortom' && voiceOfLabel('BD') === 'kick' && voiceOfLabel('xyz') === null);
  ok('drums: a row it does not recognise is ignored, not guessed at', parseDrums('ZZ|x-x-|\nBD|o---|').notes.length === 1);
  const rep = parseDrums('BD|*o---o---*|').bars;
  ok('drums: repeat signs are read as in the guitar tab', rep.length === 1 && rep[0].repeatStart === true && rep[0].repeatEnd === true);
  ok('drums: nothing written gives nothing', parseDrums('').notes.length === 0 && parseDrums('CC|--------|\nBD|--------|').notes.length === 0);
  ok('drums: hands up, the kick foot down; cymbals and hi-hat drawn as x', DRUM_VOICES.kick.up === false && DRUM_VOICES.snare.up === true && DRUM_VOICES.hihat.head === 'x' && DRUM_VOICES.crash.head === 'x' && DRUM_VOICES.snare.head === 'normal' && drumMidi('hihat', 'open') === 46);
}

// ---- drum staff: how a voice's hits become notes and rests that fill a bar
{
  const mk = (slot: number) => ({ slot, note: { drum: { voice: 'snare', style: 'normal' }, start: slot, col: slot, bar: 0 } as any });
  const sum = (s: { d: number }[]) => s.reduce((n, x) => n + x.d, 0);
  const eighths = voiceSlots([0, 2, 4, 6, 8, 10, 12, 14].map(mk), 16);
  ok('drum staff: eight eighth-note hits are eight eighth notes', eighths.length === 8 && eighths.every((s) => s.d === 2 && s.hits.length === 1));
  const kick = voiceSlots([mk(0), mk(8)], 16);
  ok('drum staff: a hit is never longer than a quarter; the rest is rests', kick.map((s) => `${s.at}:${s.d}${s.hits.length ? 'n' : 'r'}`).join() === '0:4n,4:4r,8:4n,12:4r');
  ok('drum staff: an empty bar is one whole rest', voiceSlots([], 16).length === 1 && voiceSlots([], 16)[0].d === 16 && voiceSlots([], 16)[0].hits.length === 0);
  const offbeat = voiceSlots([mk(1)], 16);
  ok('drum staff: a hit on an off sixteenth gets rests before it and after, all on natural places', offbeat[0].at === 0 && offbeat[0].d === 1 && offbeat[1].at === 1 && offbeat[1].hits.length === 1 && sum(offbeat) === 16 && offbeat.every((s) => s.at % s.d === 0));
  ok('drum staff: two hits at the same moment make one chord', voiceSlots([mk(0), mk(0), mk(4)], 16).filter((s) => s.hits.length === 2).length === 1);
  let always = true;
  for (let seed = 1; seed <= 200; seed++) {
    let r = seed * 2654435761;
    const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const len = [16, 12, 8, 14][seed % 4];
    const hits = Array.from({ length: Math.floor(rnd() * 9) }, () => mk(Math.floor(rnd() * len)));
    const slots = voiceSlots(hits, len);
    let at = 0;
    for (const s of slots) {
      if (s.at !== at || s.d < 1) always = false;
      at += s.d;
    }
    if (at !== len) always = false;
  }
  ok('drum staff: whatever the pattern, notes and rests run on from the start and fill the bar exactly', always);
}

// ---- opening songs saved by older versions: the scratchpad is brought up to date without losing text
{
  const six = 'e|-0-|\nB|-0-|\nG|-0-|\nD|-0-|\nA|-0-|\nE|-0-|';
  const four = 'G|-0-|\nD|-0-|\nA|-0-|\nE|-0-|';
  const old = normaliseScratch({ lyrics: 'la', tab: six, notes: 'n' } as any);
  ok('migrate: a version-1 save (one six-string tab) opens on Guitar with its text and other fields intact', old.tab === six && old.tabPart === undefined && (old as any).lyrics === 'la' && (old as any).notes === 'n');
  ok('migrate: an old four-string tab opens on Bass', normaliseScratch({ tab: four } as any).tabPart === 'bass');
  const withDrums = normaliseScratch({ tab: six, drums: 'BD|o---|' } as any);
  ok('migrate: the old Drum tab box becomes the Drums part and the old field goes', withDrums.tabParts?.drums?.tab === 'BD|o---|' && (withDrums as any).drums === undefined && withDrums.tab === six);
  const drumsOpen = normaliseScratch({ tab: 'BD|o---|', tabPart: 'drums', drums: '' } as any);
  ok('migrate: a save with the drums open keeps them open and invents nothing', drumsOpen.tabPart === 'drums' && drumsOpen.tabParts === undefined);
  ok('migrate: a legacy drum grid never overwrites a drums tab already saved in its part', normaliseScratch({ tab: six, drums: 'old', tabParts: { drums: { tab: 'new' } } } as any).tabParts?.drums?.tab === 'new');
  ok('migrate: an open part that was deleted falls back to Guitar', normaliseScratch({ tab: six, tabPart: 'part3', extraParts: [{ id: 'part1' }] } as any).tabPart === undefined);
  ok('migrate: an open added part that still exists stays open', normaliseScratch({ tab: six, tabPart: 'part1', extraParts: [{ id: 'part1' }] } as any).tabPart === 'part1');
  const input = { tab: six, drums: 'x', tabParts: { bass: { tab: four } } } as any;
  const snapshot = JSON.stringify(input);
  normaliseScratch(input);
  ok('migrate: the saved object itself is not changed', JSON.stringify(input) === snapshot);
  ok('migrate: an empty or missing scratchpad is fine', normaliseScratch({} as any).tabPart === undefined && Object.keys(normaliseScratch({} as any)).length === 0);
  const again = normaliseScratch(normaliseScratch({ tab: four, drums: 'BD|o---|' } as any));
  ok('migrate: doing it twice changes nothing more', again.tabPart === 'bass' && again.tabParts?.drums?.tab === 'BD|o---|');
}

// ---- a heads-up before separating a very long file
{
  ok('size: a normal song on a normal machine gets no warning', songSizeWarning(240, 6, 8) === null && songSizeWarning(240, 4, undefined) === null);
  ok('size: the estimate grows with length and with the number of stems', separationMemory(600, 6) > separationMemory(300, 6) && separationMemory(300, 6) > separationMemory(300, 4));
  const w = songSizeWarning(25 * 60, 6, 8);
  ok('size: a 25-minute file is warned about, with its length and a way out', !!w && w.includes('25-minute') && w.includes('Compact model') && w.includes('shorter file'));
  ok('size: a smaller machine is warned about a song a big one would not be', songSizeWarning(600, 6, 2) !== null && songSizeWarning(600, 6, 8) === null);
  ok('size: "a lot for this computer" is said only when the memory really is a lot', (songSizeWarning(600, 6, 2) ?? '').includes('a lot for this computer') && (songSizeWarning(16 * 60, 4, 8) ?? '').includes('16-minute') && !(songSizeWarning(16 * 60, 4, 8) ?? '').includes('a lot'));
}

// ---- library safety: disk space before saving, and the backup reminder
{
  const need = spaceNeeded(210, 6);
  ok('space: a 3.5-minute 6-stem song needs tens of megabytes, not kilobytes or gigabytes', need > 40 * 1024 * 1024 && need < 400 * 1024 * 1024);
  ok('space: lots of room is fine, and unknown room is not an error', spaceStatus(50 * 1024 ** 3, need) === 'ok' && spaceStatus(null, need) === 'ok');
  ok('space: room for the song but not much more is "low"', spaceStatus(need + 500 * 1024 * 1024, need) === 'low');
  ok('space: not enough room means do not start', spaceStatus(need - 1, need) === 'full' && spaceStatus(need + 50 * 1024 * 1024, need) === 'full' && spaceStatus(0, need) === 'full');
  ok('space: sizes read as MB or GB', fmtBytes(5 * 1024 * 1024) === '5 MB' && fmtBytes(3 * 1024 ** 3) === '3.0 GB' && fmtBytes(10) === '1 MB');
  const now = Date.UTC(2026, 9, 10);
  const day = 24 * 60 * 60 * 1000;
  ok('backup: an empty library needs no reminder', backupNote(null, now, 0) === null);
  ok('backup: never backed up is a nudge', backupNote(null, now, 3)?.stale === true);
  ok('backup: today, yesterday and recent days are fine', backupNote(now - 1000, now, 3)?.text === 'Backed up today.' && backupNote(now - day, now, 3)?.text === 'Last backed up yesterday.' && backupNote(now - 5 * day, now, 3)?.stale === false);
  ok('backup: a month old is a nudge, with the number of days', backupNote(now - 40 * day, now, 3)?.stale === true && backupNote(now - 40 * day, now, 3)?.text === 'Last backed up 40 days ago.');
}

// ---- Reset app preferences never touches songs or sets
{
  const store = new Map<string, string>([
    ['steminize.theme', 'light'],
    ['steminize.drawer', 'live'],
    ['steminize.setlist.active', 'abc'],
    ['steminize.lastBackup', '123'],
    ['steminize.settings', '{"model":"htdemucs"}'],
    ['something.else', 'x'],
  ]);
  const fake = { removeItem: (k: string) => void store.delete(k) };
  resetAppPreferences(fake);
  ok('prefs: the remembered look and panels are forgotten', !store.has('steminize.theme') && !store.has('steminize.drawer'));
  ok('prefs: setlists, the last-backup time, separation settings and other apps\' keys are left alone', store.get('steminize.setlist.active') === 'abc' && store.get('steminize.lastBackup') === '123' && store.get('steminize.settings') === '{"model":"htdemucs"}' && store.get('something.else') === 'x');
  ok('prefs: nothing that looks like a library or setlist key is in the list', APP_PREFERENCE_KEYS.every((k) => !/setlist|library|backup|settings$/.test(k)));
  ok('prefs: a store that throws does not break the reset', resetAppPreferences({ removeItem: () => { throw new Error('blocked'); } }) === APP_PREFERENCE_KEYS.length);
}

// ---- the chord timeline's logic
{
  const ch = (start: number, end: number, root: number, q: string, extra: object = {}) => ({ start, end, root, q, ...extra }) as any;
  ok('chords: sevenths, sixths, sus, add, power and augmented chords simplify to plain major', ['7', 'maj7', 'sus2', 'sus4', 'add9', '5', '6', '9', 'aug', ''].every((q) => simplifyChord(ch(0, 1, 0, q)).q === ''));
  ok('chords: minor sevenths, sixths and diminished chords simplify to plain minor', ['m', 'm7', 'm6', 'dim'].every((q) => simplifyChord(ch(0, 1, 9, q)).q === 'm'));
  ok('chords: a slash bass is dropped and the root kept; no chord stays no chord', simplifyChord(ch(0, 1, 0, '', { bass: 4 })).bass === undefined && simplifyChord(ch(0, 1, 7, '7')).root === 7 && simplifyChord(ch(0, 1, -1, '')).root === -1);
  ok('chords: the name shown follows the pitch shift, the key spelling and the simple switch', displayName(ch(0, 1, 0, 'maj7'), 2, false, false) === 'Dmaj7' && displayName(ch(0, 1, 0, 'maj7'), 2, false, true) === 'D' && displayName(ch(0, 1, 9, 'm7', { bass: 0 }), 0, false, true) === 'Am' && displayName(undefined, 0, false, false) === '' && displayName(ch(0, 1, -1, ''), 0, false, false) === 'N.C.');
  ok('chords: the input chord is not changed by simplifying', (() => { const c = ch(0, 1, 0, '7', { bass: 4 }); simplifyChord(c); return c.q === '7' && c.bass === 4; })());

  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
  const chords = [ch(0, 1, 0, ''), ch(1, 2, 7, ''), ch(2, 3.4, 9, 'm')];
  const cells = beatCells(chords, beats, 0, 4);
  ok('chords: each beat gets the chord that covers it', cells.map((c) => c.chord).join() === '0,0,1,1,2,2,2,-1');
  ok('chords: beats are numbered within their bar from the downbeat', cells.map((c) => `${c.bar}.${c.beat}`).join() === '1.0,1.1,1.2,1.3,2.0,2.1,2.2,2.3');
  const late = beatCells(chords, beats, 2, 4);
  ok('chords: beats before the first downbeat belong to bar 0 or earlier', late[0].bar === 0 && late[0].beat === 2 && late[1].beat === 3 && late[2].bar === 1 && late[2].beat === 0);
  ok('chords: a beat with no chord over it has none', beatCells([ch(1, 2, 7, '')], beats, 0, 4).map((c) => c.chord).join() === '-1,-1,0,0,-1,-1,-1,-1');
  ok('chords: the last beat is given a length from the one before', cells[7].t1 === 4);
  ok('chords: three beats in a bar (waltz time) and no beats at all both work', beatCells(chords, beats, 0, 3).map((c) => c.bar).join() === '1,1,1,2,2,2,3,3' && beatCells(chords, [], 0, 4).length === 0);

  ok('chords: the position among the beats is fractional and exact on a beat', beatPositionAt(beats, 0) === 0 && beatPositionAt(beats, 1) === 2 && Math.abs(beatPositionAt(beats, 1.25) - 2.5) < 1e-9);
  ok('chords: before the first beat and after the last, it carries on at the nearest tempo', beatPositionAt(beats, -0.5) === -1 && beatPositionAt(beats, 4) === 8);
  ok('chords: with an uneven tempo it follows the real beats', Math.abs(beatPositionAt([0, 1, 1.5, 2], 1.25) - 1.5) < 1e-9);
  let inverse = true;
  for (let t = -0.7; t < 4.6; t += 0.137) if (Math.abs(timeAtBeat(beats, beatPositionAt(beats, t)) - t) > 1e-9) inverse = false;
  ok('chords: time at a beat position is the inverse of the position at a time', inverse && timeAtBeat([0, 1, 1.5, 2], 1.5) === 1.25);
}


{
  // Chord diagrams: every chord gets a fingering that sounds exactly its notes, within a hand's reach.
  for (const inst of ['guitar', 'ukulele'] as const) {
    const bad: string[] = [];
    let wide = 0;
    for (let r = 0; r < 12; r++)
      for (const q of QUALITIES) {
        const sh = fretShape(inst, r, q);
        if (!sh) { bad.push(`${r}${q}: none`); continue; }
        if (!shapeIsRight(inst, sh.frets, r, q)) bad.push(`${r}${q}: wrong notes ${sh.frets.join(',')}`);
        const f = sh.frets.filter((x) => x > 0);
        if (f.length && Math.max(...f) - Math.min(...f) > 3) wide++;
      }
    ok(`shapes: every root and quality has a correct ${inst} fingering`, bad.length === 0, bad.slice(0, 5).join(' | '));
    ok(`shapes: no ${inst} fingering stretches more than four frets`, wide === 0);
  }
  const fr = (inst: 'guitar' | 'ukulele', r: number, q: (typeof QUALITIES)[number]) => fretShape(inst, r, q)!.frets.join(inst === 'guitar' ? ',' : ',');
  ok('shapes: C is the open shape on guitar and ukulele', fr('guitar', 0, '') === '-1,3,2,0,1,0' && fr('ukulele', 0, '') === '0,0,0,3', fr('guitar', 0, ''));
  ok('shapes: F and B minor on guitar are the usual barre chords', fr('guitar', 5, '') === '1,3,3,2,1,1' && fr('guitar', 11, 'm') === '-1,2,4,4,3,2', fr('guitar', 5, '') + ' ' + fr('guitar', 11, 'm'));
  ok('shapes: a slash chord on guitar has its bass note lowest', (() => { const sh = fretShape('guitar', 0, '', 4)!; return shapeIsRight('guitar', sh.frets, 0, '', 4); })());
  ok('shapes: piano keys are the chord notes within an octave of the root', pianoKeys(0, '').join() === '0,4,7' && pianoKeys(11, '9').join() === '11,13,15,18,21' && Math.max(...pianoKeys(11, '9')) < 24);
  const cs = (names: [number, string][]) => names.map(([root, q]) => ({ root, q: q as (typeof QUALITIES)[number], dur: 1 }));
  ok('capo: a song in G with open chords needs no capo', suggestCapo('guitar', cs([[7, ''], [0, ''], [2, ''], [4, 'm']])).capo === 0);
  ok('capo: a song in A-flat is easiest with the capo on 1 (G, C, D, Em shapes)', suggestCapo('guitar', cs([[8, ''], [1, ''], [3, ''], [5, 'm']])).capo === 1);
  ok('capo: a song in B-flat major is easiest with the capo on 3 (G shapes)', suggestCapo('guitar', cs([[10, ''], [3, ''], [5, ''], [7, 'm']])).capo === 3);
  ok('capo: chord time counts, a long chord outweighs a short one', suggestCapo('guitar', [{ root: 7, q: '', dur: 10 }, { root: 6, q: '', dur: 1 }]).capo === 0);
  ok('capo: open chords cost nothing and barre chords cost something', chordCost('guitar', 0, '') === 0 && chordCost('guitar', 5, '') === 1);
  ok('shapes: every quality has a note list', QUALITIES.every((q) => CHORD_TONES[q]?.length >= 2));
}


{
  // Chords over synced lyrics.
  const txt = 'hello there my friend';
  ok('lyric chords: a chord placed partway through snaps to the nearest word start', snapToWord(txt, 3) === 0 && snapToWord(txt, 8) === 6 && snapToWord(txt, 10) === 12 && snapToWord(txt, 0) === 0 && snapToWord(txt, 99) === txt.length);
  ok('lyric chords: a line after a short gap fills it, after a long gap only the sung part counts', sungSeconds('abcd', 10) === 2 && sungSeconds(txt, 4) === 4 && Math.abs(sungSeconds(txt, 60) - txt.length * 0.15) < 1e-9);
  const seg = segmentsFor(txt, 10, 14, [{ t: 10, name: 'C' }, { t: 11.2, name: 'G' }]);
  ok('lyric chords: the chord sounding at the start sits over the first word, the next change over a later word', seg.length === 2 && seg[0].chord === 'C' && seg[0].text.startsWith('hello') && seg[1].chord === 'G' && seg.map((s) => s.text).join('') === txt, JSON.stringify(seg));
  ok('lyric chords: the pieces always add up to the original text', segmentsFor(txt, 0, 5, [{ t: 0, name: 'A' }, { t: 0.4, name: 'B' }, { t: 2, name: 'C' }, { t: 4, name: 'D' }]).map((s) => s.text).join('') === txt);
  ok('lyric chords: a chord repeated straight after itself is shown once', segmentsFor(txt, 0, 5, [{ t: 0, name: 'A' }, { t: 1, name: 'A' }]).length === 1);
  ok('lyric chords: a chord after the next line starts is left for that line', segmentsFor(txt, 0, 3, [{ t: 0, name: 'A' }, { t: 3.5, name: 'B' }]).every((s) => s.chord !== 'B'));
  ok('lyric chords: two chords landing on one word are shown together', segmentsFor('one', 0, 5, [{ t: 0, name: 'A' }, { t: 0.2, name: 'B' }])[0].chord === 'A B');
  ok('lyric chords: a line with no words still carries its chords, and no chords leaves the text alone', segmentsFor('', 0, 4, [{ t: 0, name: 'Am' }])[0].chord === 'Am' && segmentsFor(txt, 0, 3, []).length === 1 && segmentsFor(txt, 0, 3, [])[0].chord === undefined);
}


{
  ok('welcome: says the model is already here once it is downloaded', /already on this computer/.test(modelNote('HT Demucs 6-stem', 136 * 1048576, true)) && !/download/i.test(modelNote('HT Demucs 6-stem', 136 * 1048576, true)));
  const fresh = modelNote('HT Demucs 6-stem', 136 * 1048576, false);
  ok('welcome: a first-time user is told the size, that it is one-off, and that it then works offline', /136 MB/.test(fresh) && /one-off/.test(fresh) && /offline/.test(fresh) && fresh.includes('HT Demucs 6-stem'));
  ok('welcome: a part-finished download says the rest will be fetched once', /Part of/.test(modelNote('X', 1048576, 'partly')));
}


{
  // Resumable model downloads, against a fake server that honours (or ignores) Range requests.
  const MB = 1024 * 1024;
  const file = new Uint8Array(5 * MB).map((_, i) => (i * 31 + (i >> 8)) & 255);
  const store = (): PartStore & { data: Blob[] } => {
    const data: Blob[] = [];
    return { data, sizes: async () => data.map((b) => b.size), put: async (i, b) => void (data[i] = b), blobs: async () => [...data], clear: async () => void (data.length = 0) };
  };
  const server = (opts: { range?: boolean; breakAt?: number; badRange?: boolean } = {}) => {
    const calls: (string | undefined)[] = [];
    const fn = (async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      calls.push(range);
      const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      const honour = opts.range !== false && range;
      const start = honour ? from : 0;
      const body = file.slice(start);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(ctl) {
          if (sent >= body.length) return ctl.close();
          const n = Math.min(256 * 1024, body.length - sent);
          if (opts.breakAt != null && start + sent >= opts.breakAt) return ctl.error(new Error('connection lost'));
          ctl.enqueue(body.slice(sent, sent + n));
          sent += n;
        },
      });
      const headers: Record<string, string> = { 'content-length': String(body.length) };
      if (honour) headers['content-range'] = opts.badRange ? `bytes 0-${file.length - 1}/${file.length}` : `bytes ${start}-${file.length - 1}/${file.length}`;
      return new Response(stream, { status: honour ? 206 : 200, headers });
    }) as unknown as typeof fetch;
    return { fn, calls };
  };
  const same = async (b: Blob) => { const x = new Uint8Array(await b.arrayBuffer()); return x.length === file.length && x.every((v, i) => v === file[i]); };
  const prog: number[] = [];

  const s1 = store();
  const whole = await downloadResumable({ url: 'u', parts: s1, expected: file.length, onProgress: (l) => prog.push(l), fetchFn: server().fn, partBytes: MB });
  ok('download: a plain download returns the whole file and reports progress up to its size', (await same(whole)) && prog[prog.length - 1] === file.length && s1.data.length >= 4);

  const s2 = store();
  let err = '';
  try { await downloadResumable({ url: 'u', parts: s2, expected: file.length, onProgress: () => {}, fetchFn: server({ breakAt: 2 * MB }).fn, partBytes: MB }); } catch (e) { err = (e as Error).message; }
  const kept = await keptBytes(s2);
  ok('download: a dropped connection keeps what arrived', err === 'connection lost' && kept >= 2 * MB && kept < file.length, `${err} ${kept}`);

  const srv = server();
  const prog2: number[] = [];
  const done = await downloadResumable({ url: 'u', parts: s2, expected: file.length, onProgress: (l) => prog2.push(l), fetchFn: srv.fn, partBytes: MB });
  ok('download: the next try asks only for the rest and gets the same file', srv.calls[0] === `bytes=${kept}-` && (await same(done)));
  ok('download: progress carries on from where it stopped, not from zero', prog2[0] > kept && prog2[prog2.length - 1] === file.length);

  const s3 = store();
  try { await downloadResumable({ url: 'u', parts: s3, expected: file.length, onProgress: () => {}, fetchFn: server({ breakAt: 2 * MB }).fn, partBytes: MB }); } catch { /* expected */ }
  const noRange = await downloadResumable({ url: 'u', parts: s3, expected: file.length, onProgress: () => {}, fetchFn: server({ range: false }).fn, partBytes: MB });
  ok('download: a server that ignores Range gives the whole file again, not a mixed-up one', await same(noRange));

  const s4 = store();
  try { await downloadResumable({ url: 'u', parts: s4, expected: file.length, onProgress: () => {}, fetchFn: server({ breakAt: 2 * MB }).fn, partBytes: MB }); } catch { /* expected */ }
  const badSrv = server({ badRange: true });
  const fixed = await downloadResumable({ url: 'u', parts: s4, expected: file.length, onProgress: () => {}, fetchFn: badSrv.fn, partBytes: MB });
  ok('download: an answer that does not start where asked makes it start again from the beginning', (await same(fixed)) && badSrv.calls.length === 2 && badSrv.calls[1] === undefined);

  ok('download: parseContentRange reads a range and refuses nonsense', parseContentRange('bytes 100-199/1000')?.total === 1000 && parseContentRange('bytes */1000') === null && parseContentRange(null) === null);
}


{
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  ok('youtube: it starts off', youtubeEnabled(store) === false);
  setYoutubeEnabled(store, true);
  const on = youtubeEnabled(store);
  setYoutubeEnabled(store, false);
  ok('youtube: turning it on is remembered, turning it off forgets it', on === true && youtubeEnabled(store) === false && !mem.has(YOUTUBE_KEY));
  ok('youtube: storage that fails means off, not a crash', youtubeEnabled({ getItem: () => { throw new Error('blocked'); } }) === false);
  ok('youtube: the notice says to use only audio you own or may use, that it may break YouTube terms, and who is responsible', /own/.test(YOUTUBE_NOTICE) && /royalty-free/.test(YOUTUBE_NOTICE) && /terms of service/.test(YOUTUBE_NOTICE) && /responsible/.test(YOUTUBE_NOTICE) && /responsible/.test(YOUTUBE_REMINDER));
  ok('youtube: Reset app preferences puts it back to off', (APP_PREFERENCE_KEYS as readonly string[]).includes(YOUTUBE_KEY));
}


{
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null };
  ok('native tip: shown on the desktop app until dismissed', nativeTipVisible(store, true, false) === true);
  mem.set(NATIVE_TIP_KEY, '1');
  ok('native tip: gone once dismissed', nativeTipVisible(store, true, false) === false);
  mem.delete(NATIVE_TIP_KEY);
  ok('native tip: not in the browser, and not once native audio is on', nativeTipVisible(store, false, false) === false && nativeTipVisible(store, true, true) === false);
  ok('native tip: unreadable storage shows it rather than hiding the feature', nativeTipVisible({ getItem: () => { throw new Error('blocked'); } }, true, false) === true);
  ok('native tip: the words say it is experimental and off by default', /experimental/i.test(NATIVE_TIP) && /off by default/i.test(NATIVE_TIP) && /off by default/i.test(NATIVE_INFO) && /experimental/i.test(NATIVE_WELCOME) && /Settings/.test(NATIVE_INFO));
  ok('native tip: Reset app preferences brings the tip back', (APP_PREFERENCE_KEYS as readonly string[]).includes(NATIVE_TIP_KEY));
}


{
  ok('text size: the steps start at normal and grow', ZOOM_STEPS[0] === 1 && ZOOM_STEPS.every((z, i) => i === 0 || z > ZOOM_STEPS[i - 1]) && ZOOM_STEPS[ZOOM_STEPS.length - 1] >= 1.75);
  ok('text size: a step up and down moves one place and stops at the ends', stepZoom(1, 1) === ZOOM_STEPS[1] && stepZoom(ZOOM_STEPS[1], -1) === 1 && stepZoom(1, -1) === 1 && stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], 1) === ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  ok('text size: an odd value lands on the nearest real step, nonsense on normal', nearestZoom(1.2) === 1.25 && nearestZoom(NaN) === 1 && nearestZoom(99) === 2 && nearestZoom(0.1) === 1);
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  saveZoom(store, 1.5);
  const got = loadZoom(store);
  saveZoom(store, 1);
  ok('text size: the choice is remembered, and normal leaves nothing stored', got === 1.5 && !mem.has(ZOOM_KEY) && loadZoom(store) === 1);
  ok('text size: unreadable storage means normal', loadZoom({ getItem: () => { throw new Error('blocked'); } }) === 1);
  ok('text size: labels read well, and Reset app preferences puts it back to normal', zoomLabel(1) === 'Normal' && zoomLabel(1.25) === '125%' && (APP_PREFERENCE_KEYS as readonly string[]).includes(ZOOM_KEY));
}


{
  ok('updater: a plain version tag gets its release address', updateEndpoint('v0.9.5') === 'https://github.com/Gerschwin/steminize/releases/download/v0.9.5/latest.json' && updateEndpoint('v1.0.0') === 'https://github.com/Gerschwin/steminize/releases/download/v1.0.0/latest.json');
  ok('updater: anything that is not a plain version tag gets none', [null, '', '0.9.5', 'v0.9', 'v0.9.5-beta', 'v0.9.5/../x', 'untagged-123', 'v0.9.5 ', 'vx.y.z'].every((t) => updateEndpoint(t as string) === null));
}


{
  // Saved songs from every era still open, and damaged ones never take the library down with them.
  const dir = new URL('./fixtures/library/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  ok('library: there is a saved-song fixture for each era', files.length >= 4, files.join(','));
  const parsed = new Map<string, ReturnType<typeof parseMeta>>();
  for (const f of files) {
    const raw = readFileSync(new URL(f, dir), 'utf8');
    const m = parseMeta(`song-${f}`, raw);
    parsed.set(f, m);
    ok(`library: ${f} opens`, !!m && m.id === `song-${f}` && m.stems.length > 0 && typeof m.title === 'string' && m.seconds > 0);
    if (!m) continue;
    const j = JSON.parse(raw);
    ok(`library: ${f} keeps its saved player state exactly as it was`, JSON.stringify(m.state) === JSON.stringify(j.state));
    ok(`library: ${f} reads the same the second time (nothing changes by being opened and saved)`, JSON.stringify(parseMeta(m.id, JSON.stringify(m))) === JSON.stringify(m));
    const sc = (m.state as { scratch?: Record<string, unknown> } | undefined)?.scratch;
    if (sc) {
      const n = normaliseScratch(sc as Parameters<typeof normaliseScratch>[0]);
      const again = normaliseScratch(n);
      ok(`library: ${f} scratchpad brought up to date is stable`, JSON.stringify(again) === JSON.stringify(n));
      const text = (v: unknown) => (typeof v === 'string' ? v : '');
      const all = JSON.stringify(n);
      ok(`library: ${f} scratchpad loses no text (lyrics, notes, tab, drum grid)`, [sc.lyrics, sc.notes, sc.tab, sc.drums].every((s) => !text(s) || all.includes(JSON.stringify(text(s)).slice(1, -1))));
    }
  }
  const era1 = parsed.get('era1-separated-single-tab.json');
  ok('library: an early separated song (no kind, no take groups) reads as separated with no takes', !!era1 && era1.kind === undefined && era1.takeGroups === undefined && era1.stems.every((s) => s.scale > 0));
  const era2 = parsed.get('era2-multitrack-takes-tabanchors.json');
  ok('library: a multitrack song with takes keeps its take groups and their active take', !!era2 && era2.kind === 'multitrack' && (era2.takeGroups?.length ?? 0) > 0);
  const era4 = parsed.get('era4-parts-chords-0.9.4.json');
  const sc4 = (era4?.state as { scratch?: { tabParts?: Record<string, unknown>; extraParts?: unknown[]; partNames?: Record<string, string> } } | undefined)?.scratch;
  ok('library: a 0.9.4 song keeps its parts, renames and chord view settings', !!sc4 && Object.keys(sc4.tabParts ?? {}).length === 3 && (sc4.extraParts?.length ?? 0) === 1 && sc4.partNames?.guitar === 'Lead' && (era4!.state as { tx: { capo: number } }).tx.capo === 3);

  const base = JSON.parse(readFileSync(new URL('era4-parts-chords-0.9.4.json', dir), 'utf8'));
  ok('library: a field from a newer version is kept, not thrown away', (parseMeta('x', JSON.stringify({ ...base, shinyNewField: { a: 1 } })) as unknown as { shinyNewField: unknown }).shinyNewField !== undefined);
  ok('library: the folder name is the song id, whatever the file says', parseMeta('real-id', JSON.stringify({ ...base, id: 'something-else' }))?.id === 'real-id');
  ok('library: a file that is not JSON, not an object, or has no stems is skipped, not an error', parseMeta('x', '{not json') === null && parseMeta('x', '[]') === null && parseMeta('x', '"hi"') === null && parseMeta('x', JSON.stringify({ ...base, stems: [] })) === null && parseMeta('x', '') === null);
  const odd = parseMeta('x', JSON.stringify({ ...base, title: 5, seconds: 'long', bytes: null, settings: 3, analysis: { bpm: 'fast' }, takeGroups: 'none', stems: [{ name: 'a', scale: -1 }, 7, { name: '' }], kind: 'weird', state: 'broken' }));
  ok('library: wrong-typed fields are repaired or dropped and the song still opens', !!odd && odd.title === 'Untitled' && odd.seconds === 0 && odd.bytes === 0 && odd.settings.model === 'htdemucs_6s' && odd.analysis === undefined && odd.takeGroups === undefined && odd.stems.length === 1 && odd.stems[0].scale === 1 && odd.kind === undefined && odd.state === undefined);

  const now = 10 * INCOMPLETE_GRACE_MS;
  ok('library: an unfinished save is only cleaned up when meta is definitely missing and everything is over a day old', canCleanIncompleteSong('missing', now - 2 * INCOMPLETE_GRACE_MS, now) === true);
  ok('library: a save in progress (recent files) is never cleaned up', canCleanIncompleteSong('missing', now - 1000, now) === false && canCleanIncompleteSong('missing', now - INCOMPLETE_GRACE_MS / 2, now) === false);
  ok('library: an unreadable meta file, or unknown file times, never lead to deleting a song', canCleanIncompleteSong('unreadable', now - 5 * INCOMPLETE_GRACE_MS, now) === false && canCleanIncompleteSong('missing', null, now) === false);
}


{
  // The getting-started page on the website: complete and not broken.
  const pageUrl = new URL('../public/guide/index.html', import.meta.url);
  const html = readFileSync(pageUrl, 'utf8');
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  ok('guide page: every image has a description and a file that exists', imgs.length >= 5 && imgs.every((i) => /\balt="/.test(i)) && imgs.filter((i) => /src="img\//.test(i)).every((i) => existsSync(new URL(`../public/guide/${/src="([^"]+)"/.exec(i)![1]}`, import.meta.url))));
  ok('guide page: one main heading, a language, a viewport and a skip link', (html.match(/<h1\b/g) || []).length === 1 && /<html lang="en">/.test(html) && /name="viewport"/.test(html) && /class="skip"/.test(html));
  ok('guide page: links to the app, the downloads, the FAQ and the privacy statement', ['href="../"', '/releases', 'FAQ.md', 'PRIVACY.md'].every((s) => html.includes(s)));
  ok('guide page: says what the app is honestly (free, pre-release, chord detection is a draft, installers unsigned)', /pre-release/i.test(html) && /first draft/i.test(html) && /not code-signed/i.test(html) && /MIT/.test(html));
}


{
  // Send to DAW: bar alignment, the Reaper project, the markers list and the MIDI tempo map.
  const a = barAlignment(1.3, 120, 4); // a bar is 2 s
  ok('daw: stems are put after a lead-in so the song\'s first bar lands on a bar line', Math.abs(a.padSec - 0.7) < 1e-9 && Math.abs(a.padSec + 1.3 - 2) < 1e-9 && a.leadBars === 1 && a.padSec < a.barLen);
  ok('daw: a song that starts on its first bar needs no lead-in, and neither does one a whole number of bars in', barAlignment(0, 120, 4).padSec === 0 && barAlignment(4, 120, 4).padSec === 0 && barAlignment(2, 120, 4).padSec === 0);
  ok('daw: odd values never throw or give a negative lead-in', [barAlignment(-1, 120, 4), barAlignment(NaN, 120, 4), barAlignment(1, 0, 4), barAlignment(1, 90, 3)].every((x) => x.padSec >= 0 && Number.isFinite(x.padSec)));
  const steady = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
  ok('daw: a steady song needs only one tempo', beatTempos(steady, 0, 120, 4, 0).length === 1);
  const drift = [0.5, 1, 1.5, 2, 2.55, 3.1, 3.65, 4.2];
  const bt = beatTempos(drift, 0, 120, 4, 1);
  ok('daw: a song that slows down gets a tempo change at the right beat, counted from the project start', bt.length === 2 && bt[0].beat === 0 && bt[1].beat === 4 + 3 && Math.abs(bt[1].bpm - 109.09) < 0.01, JSON.stringify(bt));

  const proj: DawProject = {
    title: 'Example', sampleRate: 44100, seconds: 12.5, bpm: 120, perBar: 4, padSec: 0.7,
    tracks: [
      { name: 'Bass', file: 'Example - Bass.wav', colour: '#a78bfa', vol: 0.8, pan: -0.25, mute: false, solo: false },
      { name: 'Vo"cals', file: 'Example - Vocals.wav', colour: '#f472b6', vol: 1, pan: 0, mute: true, solo: false },
    ],
    markers: [{ name: 'Verse', time: 2.7 }, { name: 'Chorus, big', time: 6.7 }],
    loop: { start: 2.7, end: 6.7 },
  };
  const rpp = reaperProject(proj);
  const opens = rpp.split('\n').filter((l) => l.trim().startsWith('<')).length;
  const closes = rpp.split('\n').filter((l) => l.trim() === '>').length;
  ok('daw: the Reaper project has balanced blocks, one track and item per stem, and the tempo', opens === closes && (rpp.match(/<TRACK /g) || []).length === 2 && (rpp.match(/<ITEM/g) || []).length === 2 && /TEMPO 120 4 4/.test(rpp));
  ok('daw: the Reaper items sit after the lead-in and point at the audio files', /POSITION 0\.7\b/.test(rpp) && /FILE "Example - Bass\.wav"/.test(rpp) && /LENGTH 12\.5\b/.test(rpp));
  ok('daw: the Reaper project carries levels, pan, mute, markers and the loop', /VOLPAN 0\.8 -0\.25/.test(rpp) && /MUTESOLO 1 0 0/.test(rpp) && /MARKER 1 2\.7 "Verse"/.test(rpp) && /LOOP 1/.test(rpp) && /SELECTION 2\.7 6\.7/.test(rpp));
  ok('daw: a quote in a name cannot break the Reaper file', !/NAME "Vo"cals"/.test(rpp) && /NAME "Vo\'cals"/.test(rpp));
  ok('daw: guids look like guids and the same seed gives the same one', /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/.test(guid('a')) && guid('a') === guid('a') && guid('a') !== guid('b'));
  ok('daw: colours become Reaper\'s custom-colour numbers', reaperColour('#ff0000') === (0x1000000 | 255) && reaperColour('#0000ff') === (0x1000000 | (255 << 16)) && reaperColour('nonsense') === 0);

  const csv = markersCsv(proj).trim().split('\n');
  ok('daw: the markers list has a header, quotes names with commas, and gives a bar and beat', csv[0].startsWith('#,Name') && csv.some((r) => r.includes('"Chorus, big"')) && csv.some((r) => /Verse,2\.7,2\.2$/.test(r)) && csv.length === 5, csv.join(' | '));

  // Read the tempo map back with a tiny MIDI reader.
  const readMidi = (b: Uint8Array) => {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tag = (o: number) => String.fromCharCode(...b.slice(o, o + 4));
    const ppq = dv.getUint16(12);
    let o = 14 + 8;
    const end = 14 + 8 + dv.getUint32(18);
    const ev: { at: number; type: number; data: number[] }[] = [];
    let at = 0;
    while (o < end) {
      let d = 0; let c: number;
      do { c = b[o++]; d = (d << 7) | (c & 127); } while (c & 128);
      at += d;
      const st = b[o++];
      if (st !== 0xff) throw new Error('unexpected status');
      const type = b[o++]; const len = b[o++];
      ev.push({ at, type, data: [...b.slice(o, o + len)] }); o += len;
    }
    return { head: tag(0), track: tag(14), ppq, ev };
  };
  const mid = readMidi(tempoMapFile(proj));
  const tempos = mid.ev.filter((e) => e.type === 0x51);
  const sig = mid.ev.find((e) => e.type === 0x58)!;
  const marks = mid.ev.filter((e) => e.type === 0x06);
  ok('daw: the tempo map is a MIDI file with the tempo, the bar length and the markers', mid.head === 'MThd' && mid.track === 'MTrk' && tempos.length === 1 && (tempos[0].data[0] << 16 | tempos[0].data[1] << 8 | tempos[0].data[2]) === 500000 && sig.data[0] === 4 && sig.data[1] === 2 && marks.length === 2 && String.fromCharCode(...marks[0].data) === 'Verse');
  ok('daw: a marker\'s tick matches its time at the tempo (2.7 s at 120 BPM is 5.4 beats)', Math.abs(marks[0].at - Math.round(5.4 * mid.ppq)) <= 1);
  const midVar = readMidi(tempoMapFile(proj, [{ beat: 8, bpm: 100 }]));
  const tv = midVar.ev.filter((e) => e.type === 0x51);
  const mv = midVar.ev.filter((e) => e.type === 0x06);
  ok('daw: tempo changes are written at their beat, and a marker after one is placed by the new tempo', tv.length === 2 && tv[1].at === 8 * midVar.ppq && Math.abs(mv[1].at - Math.round((8 + (6.7 - 4) / 0.6) * midVar.ppq)) <= 1, JSON.stringify(mv.map((m) => m.at)));
  const readme = dawReadme(proj, 'reaper');
  ok('daw: the README names the tempo, the lead-in and how to open it', /120 BPM, 4\/4/.test(readme) && /0\.7 s/.test(readme) && /Example\.rpp/.test(readme) && /dawproject/.test(dawReadme(proj, 'dawproject')) && /tempo-map\.mid/.test(dawReadme(proj, 'generic')));
  ok('daw: for stems with the lead-in built in, the README says each file begins with silence', /Each audio file begins with 0\.7 s of silence/.test(dawReadme(proj, 'generic', true)));
  ok('daw: a song with no detected tempo says so instead of pretending', /no tempo was detected/.test(dawReadme({ ...proj, bpm: 0 }, 'generic')));
}


{
  // Send to DAW, Ardour: the session text for Ardour 8 and later (also checked by loading it into real Ardour; see DAW_EXPORT.md).
  const proj: DawProject = {
    title: 'My Song (take 2)', sampleRate: 44100, seconds: 12, bpm: 120.1, perBar: 4, padSec: 1.198,
    tracks: [
      { name: 'Bass', file: 'My Song - Bass.wav', colour: '#a78bfa', vol: 0.8, pan: -0.5, mute: false, solo: false },
      { name: 'Drums', file: 'My Song - Drums.wav', colour: '#fb923c', vol: 1, pan: 0, mute: true, solo: true },
      { name: 'Bass', file: 'My Song - Bass (2).wav', colour: '#34d399', vol: 1.2, pan: 1, mute: false, solo: false },
    ],
    markers: [{ name: 'Verse & "intro"', time: 3.2 }],
    loop: { start: 3.2, end: 7.2 },
  };
  const s = ardourSession(proj);
  ok('ardour: the session is named safely for a folder and a file', ardourSessionName('A/B: C?*"d"|e%f,g') === 'A B C d e f g' && ardourSessionName('   ') === 'Steminize song' && s.name === 'My Song (take 2)');
  ok('ardour: one route, playlist and region per track and a pair of sources each, with the audio in the session\'s own folder', (s.xml.match(/<Route /g) || []).length === 4 && (s.xml.match(/<Playlist /g) || []).length === 3 && (s.xml.match(/<Source /g) || []).length === 6 && s.audioDir === 'interchange/My Song (take 2)/audiofiles' && s.dirs.includes(s.audioDir));
  ok('ardour: positions use Ardour\'s clock (282,240,000 to the second): the lead-in, the loop and the marker', s.xml.includes('length="a3386880000@a338123520"') && s.xml.includes('name="Loop" start="a903168000" end="a2032128000" flags="IsAutoLoop"') && /name="Verse &amp; &quot;intro&quot;" start="a903168000" end="a903168000" flags="IsMark"/.test(s.xml));
  ok('ardour: the session range runs to the end of the audio and the tempo and bar length are set', /flags="IsSessionRange"/.test(s.xml) && s.xml.includes(`end="a${Math.round(13.198 * 282240000)}"`) && /<Tempo npm="120.1" enpm="120.1"/.test(s.xml) && /divisions-per-bar="4"/.test(s.xml));
  ok('ardour: levels, pan, mute and solo reach the tracks (pan -0.5 is 0.25 of the way across)', /name="gaincontrol"[^>]* value="0.8"/.test(s.xml) && /name="pan-azimuth"[^>]* value="0.25"/.test(s.xml) && /name="gaincontrol"[^>]* value="1.2"/.test(s.xml) && /name="pan-azimuth"[^>]* value="1"/.test(s.xml) && /<MuteMaster [^>]*muted="1"/.test(s.xml) && /name="solo"[^>]* value="1" self-solo="1"/.test(s.xml));
  ok('ardour: two tracks called Bass get different names, so their ports do not clash', s.xml.includes('name="Bass"') && s.xml.includes('name="Bass 2"') && s.xml.includes('Bass 2/audio_in 1'));
  const ids = [...s.xml.matchAll(/(?<![-\w])id="(\d+)"/g)].map((m) => m[1]);
  const mine = ids.filter((i) => Number(i) >= 1000);
  ok('ardour: every id is unique and the id counter is above them all', new Set(ids).size === ids.length && Number(/id-counter="(\d+)"/.exec(s.xml)![1]) > Math.max(...mine.map(Number)));
  ok('ardour: no placeholder is left, and nothing from the capture\'s sound card or music is in it', !/\{\{[A-Z0-9]+\}\}/.test(s.xml) && !/USB Audio|YTDown|dancefloor/i.test(s.xml));
  ok('ardour: a "$" in a name is not treated as a replacement pattern', ardourSession({ ...proj, title: 'Cost $& more' }).xml.includes('name="Cost $&amp; more"'));
  ok('ardour: colours become Ardour\'s 0xRRGGBBAA number', ardourColour('#ff0000') === 0xff0000ff && ardourColour('#102030') === 0x102030ff && ardourColour('bad') === 0xaaaaaaff);
  ok('ardour: the README tells Ardour users how to open it', /open the session folder/.test(dawReadme(proj, 'ardour')));
}


{
  // Send to DAW, DAWproject: the project.xml (also checked against the format's official schema with xmllint; see DAW_EXPORT.md).
  const proj: DawProject = {
    title: 'My Song & more', sampleRate: 44100, seconds: 12.5, bpm: 120.1, perBar: 3, padSec: 1.198,
    tracks: [
      { name: 'Bass "low"', file: 'My Song - Bass.wav', colour: '#a78bfa', vol: 0.8, pan: -0.5, mute: false, solo: false },
      { name: 'Drums', file: 'My Song - Drums.wav', colour: '#fb923c', vol: 1.5, pan: 1, mute: true, solo: true },
    ],
    markers: [{ name: 'Verse <1>', time: 3.2 }, { name: 'Chorus', time: 7.2 }],
    loop: { start: 3.2, end: 7.2 },
  };
  const xml = dawprojectXml(proj, '0.9.4');
  const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  ok('dawproject: every id is unique and a valid XML name', new Set(ids).size === ids.length && ids.every((i) => /^[A-Za-z_][\w.-]*$/.test(i)));
  const refs = [...xml.matchAll(/(?:destination|track)="([^"]+)"/g)].map((m) => m[1]);
  ok('dawproject: every track and destination reference points at something that exists', refs.length === 5 && refs.every((r) => ids.includes(r)));
  ok('dawproject: tempo, bar length, and one audio track plus the master per stem', /unit="bpm" value="120.1"/.test(xml) && /numerator="3"/.test(xml) && (xml.match(/<Track /g) || []).length === 3 && /role="master"/.test(xml));
  ok('dawproject: levels, pan (normalised, -0.5 is 0.25), mute and solo carry over, and volume is capped at the format\'s maximum', /unit="linear" value="0.8"/.test(xml) && /unit="normalized" value="0.25"/.test(xml) && /<Mute value="true"/.test(xml) && /solo="true"/.test(xml) && /unit="linear" value="1.5"/.test(xml));
  ok('dawproject: each stem is one clip, in seconds, after the lead-in, pointing at its audio file', (xml.match(/<Clip time="1.198" duration="12.5" contentTimeUnit="seconds"/g) || []).length === 2 && /<File path="audio\/My Song - Bass\.wav"\/>/.test(xml) && /<Lanes timeUnit="seconds"/.test(xml) && dawprojectAudioPath('x.wav') === 'audio/x.wav');
  ok('dawproject: markers and the loop\'s ends are markers, in time order, with names escaped', /<Marker time="3.2" name="Loop start"\/>/.test(xml) && /name="Verse &lt;1&gt;"/.test(xml) && xml.indexOf('Loop start') > 0 && /<Marker time="7.2" name="Chorus"\/>/.test(xml));
  ok('dawproject: names and titles with quotes and ampersands cannot break the XML', /name="Bass &quot;low&quot;"/.test(xml) && dawprojectMetadata(proj).includes('<Title>My Song &amp; more</Title>'));
  ok('dawproject: a song with no tempo gets a plain 120 BPM', /unit="bpm" value="120"/.test(dawprojectXml({ ...proj, bpm: 0 })));
}


{
  // Learn mode: sections, chunks, the clean-pass streak and saved progress.
  const sr = 44100;
  const secs = sectionsFromMarkers([{ name: 'Verse', pos: 10 * sr }, { name: 'Chorus', pos: 30 * sr }], 50 * sr, sr);
  ok('learn: markers make sections that run to the next marker and the end, with a Start section before the first', secs.map((s) => s.name).join() === 'Start,Verse,Chorus' && secs[0].b === 10 * sr && secs[2].b === 50 * sr);
  ok('learn: a first marker near the very start has no Start section, and no markers is one whole-song section', sectionsFromMarkers([{ name: 'A', pos: sr }], 20 * sr, sr).map((s) => s.name).join() === 'A' && sectionsFromMarkers([], 20 * sr, sr).map((s) => s.name).join() === 'Whole song');
  const beats = Array.from({ length: 80 }, (_, i) => 1 + i * 0.5); // 120 BPM, first bar at 1.0 s
  const bars = barStarts(beats, 0, 4, sr);
  ok('learn: bar starts come from the beat grid, every perBar beats from the first bar', bars.length === 20 && bars[0] === sr && bars[1] === 3 * sr && barStarts(beats, 2, 4, sr)[0] === 2 * sr && barStarts([], 0, 4, sr).length === 0);
  const sec = { name: 'Verse', a: 1 * sr, b: 17 * sr }; // 8 bars of 2 s
  const two = chunksOf(sec, 2, bars, sr);
  ok('learn: a section of 8 bars in 2-bar chunks is 4 chunks that start on bar lines and cover it exactly', two.length === 4 && two[0].a === sec.a && two[3].b === sec.b && two.every((c, i) => i === 0 || c.a === two[i - 1].b) && two[1].a === 5 * sr);
  ok('learn: chunk sizes of 1 bar and 4 bars, and 0 for the whole section', chunksOf(sec, 1, bars, sr).length === 8 && chunksOf(sec, 4, bars, sr).length === 2 && chunksOf(sec, 0, bars, sr).length === 1);
  const odd = chunksOf({ name: 'Odd', a: sr, b: 15 * sr }, 2, bars, sr); // 7 bars: 2,2,2 and a 1-bar leftover (exactly half a chunk, kept)
  const odd2 = chunksOf({ name: 'Odd', a: sr, b: 13 * sr }, 4, bars, sr); // 6 bars: 4 and a 2-bar leftover (exactly half)
  const sliver = chunksOf({ name: 'S', a: sr, b: 20 * sr - sr * 1.2 }, 4, bars, sr);
  ok('learn: a leftover under half a chunk joins the chunk before it, and the chunks still cover the section', odd.length === 4 && odd2.length === 2 && sliver.every((c) => c.b > c.a) && sliver[sliver.length - 1].b === 20 * sr - sr * 1.2 - 0);
  const noGrid = chunksOf({ name: 'N', a: 0, b: 10 * sr }, 2, [], sr);
  ok('learn: with no tempo a bar is taken as 2 seconds, so 2-bar chunks are 4 seconds', noGrid.length === 3 && noGrid[0].b === 4 * sr && noGrid[2].b === 10 * sr);
  ok('learn: stitching joins chunks into one stretch, in either order', stitch(two, 0, 1).b === two[1].b && stitch(two, 2, 1).a === two[1].a && stitch(two, 0, 99).b === two[3].b);
  ok('learn: a stretch has a steady key and loops a few samples off are the same stretch', spanKey(two[0], sr) === spanKey({ a: two[0].a + 40, b: two[0].b - 30 }, sr) && sameSpan(two[0], { a: two[0].a + 40, b: two[0].b - 30 }, sr) && !sameSpan(two[0], two[1], sr));

  let p = newProgress();
  p = addPass(p); p = addPass(p);
  const r1 = addClean(p, 3);
  const r2 = addClean(r1.progress, 3);
  const r3 = addClean(r2.progress, 3);
  ok('learn: clean passes in a row build a streak and the chunk is done exactly when the target is reached', r1.progress.streak === 1 && !r1.reached && r2.progress.streak === 2 && !r2.progress.done && r3.progress.done && r3.reached && r3.progress.passes === 2);
  const miss = addMiss(r2.progress);
  ok('learn: a miss starts the run again but keeps the best and the passes', miss.streak === 0 && miss.best === 2 && addClean(miss, 3).progress.streak === 1);
  const after = addClean(r3.progress, 3);
  ok('learn: going past the target does not finish it a second time, and a done chunk stays done after a miss', !after.reached && addMiss(after.progress).done === true);
  const prog: Record<string, ReturnType<typeof newProgress>> = {};
  ok('learn: a section is new until something is played, learning while chunks are unfinished, solid when all are done', sectionStatus(two, prog, sr) === 'new');
  prog[spanKey(two[0], sr)] = { passes: 3, streak: 1, best: 1, done: false };
  ok('learn: one played chunk makes the section learning', sectionStatus(two, prog, sr) === 'learning');
  for (const c of two) prog[spanKey(c, sr)] = { passes: 20, streak: 20, best: 20, done: true };
  ok('learn: all chunks done is solid, and marking it solid by hand does too', sectionStatus(two, prog, sr) === 'solid' && sectionStatus(two, {}, sr, true) === 'solid');
  prog[spanKey(two[1], sr)].done = false;
  ok('learn: the first chunk not done is where to carry on, or the start if all are done', firstUnfinished(two, prog, sr) === 1 && firstUnfinished(two, {}, sr) === 0);
  const rl = readLearn({ size: 4, target: 9999, auto: false, advance: 'no', progress: { a: { passes: 'x', streak: 2, best: 5, done: true }, b: 7 }, solid: { k: true, j: 1 } });
  ok('learn: saved state is read tolerantly: odd values are repaired, junk entries dropped', rl.size === 4 && rl.target === 200 && rl.auto === false && rl.advance === true && rl.progress.a.passes === 0 && rl.progress.a.done === true && !('b' in rl.progress) && rl.solid.k === true && !('j' in rl.solid));
  ok('learn: no saved state, or nonsense, gives the defaults', JSON.stringify(readLearn(undefined)) === JSON.stringify(DEFAULT_LEARN) && JSON.stringify(readLearn('junk')) === JSON.stringify(DEFAULT_LEARN) && readLearn({ size: 7 }).size === DEFAULT_LEARN.size);
}


{
  // Song structure: finding sections from the music itself.
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 1.2; };
  const D = 28;
  const base: Record<string, number[][]> = {};
  for (const k of 'IVCBO') base[k] = Array.from({ length: 4 }, () => Array.from({ length: D }, () => Math.abs(gauss()) + 0.2));
  const loud: Record<string, number> = { I: 0.4, V: 0.6, C: 1, B: 0.7, O: 0.35 };
  const plan = [['I', 4], ['V', 8], ['C', 8], ['V', 8], ['C', 8], ['B', 8], ['C', 8], ['O', 4]] as const;
  const feats: number[][] = []; const energy: number[] = [];
  for (const [k, n] of plan) for (let b = 0; b < n; b++) { feats.push(base[k][b % 4].map((x) => x + 0.12 * gauss())); energy.push(loud[k] + 0.03 * gauss()); }
  const got = suggestSections({ feats, energy });
  const edges = got.map((g) => g.a).slice(1);
  ok('structure: sections are found at the real boundaries (bars 4 12 20 28 36 44 52) in a song with an intro, verses, choruses, a bridge and an outro', edges.join() === '4,12,20,28,36,44,52', edges.join());
  ok('structure: the repeats get the same letter and the different sections different ones', got[1].label === got[3].label && got[2].label === got[4].label && got[2].label === got[6].label && new Set(got.map((g) => g.label)).size === 5);
  ok('structure: the names are guessed from the pattern: intro, verses, choruses (the loud repeat), a bridge and an outro, numbered', got.map((g) => g.name).join() === 'Intro,Verse 1,Chorus 1,Verse 2,Chorus 2,Bridge,Chorus 3,Outro', got.map((g) => g.name).join());
  ok('structure: a short piece of music has no structure to find', suggestSections({ feats: feats.slice(0, 12), energy: energy.slice(0, 12) }).length === 0);

  // The same plan as real audio: chords with a different tone and loudness in each kind of section.
  const sr = 22050; const barLen = 1.5; const f = (m: number) => 440 * 2 ** ((m - 69) / 12);
  const prog: Record<string, { roots: number[]; amp: number; harm: number; noise: number }> = {
    I: { roots: [60, 60, 65, 65], amp: 0.12, harm: 1, noise: 0 }, V: { roots: [60, 67, 69, 65], amp: 0.2, harm: 2, noise: 0.01 },
    C: { roots: [65, 60, 67, 67], amp: 0.32, harm: 4, noise: 0.04 }, B: { roots: [62, 64, 65, 67], amp: 0.22, harm: 2, noise: 0 }, O: { roots: [60, 65, 60, 60], amp: 0.1, harm: 1, noise: 0 },
  };
  const total = plan.reduce((a, [, n]) => a + n, 0);
  const mono = new Float32Array(Math.round(total * barLen * sr));
  const bars: number[] = [];
  let seed2 = 3; const r2 = () => { seed2 = (seed2 * 1664525 + 1013904223) >>> 0; return seed2 / 4294967296 - 0.5; };
  let bar = 0;
  for (const [k, n] of plan) for (let b = 0; b < n; b++, bar++) {
    const start = Math.round(bar * barLen * sr); bars.push(start);
    const p = prog[k]; const root = p.roots[b % 4];
    for (let i = 0; i < Math.round(barLen * sr) && start + i < mono.length; i++) {
      const tt = i / sr; let v = 0;
      for (const iv of [0, 4, 7]) for (let h = 1; h <= p.harm; h++) v += (p.amp / h) * Math.sin(2 * Math.PI * f(root + iv) * h * tt) / 3;
      mono[start + i] = v + p.noise * r2();
    }
  }
  const bf = await barFeatures(mono, sr, bars, mono.length);
  const audio = suggestSections(bf);
  ok('structure: from real audio (chords, tone and loudness) the boundaries and the repeats are found too', audio.slice(1).map((g) => g.a).join() === '4,12,20,28,36,44,52' && audio[1].label === audio[3].label && audio[2].label === audio[4].label, audio.map((g) => `${g.name}@${g.a}`).join(' '));
  ok('structure: from real audio the names come out right as well', audio.map((g) => g.name).join() === 'Intro,Verse 1,Chorus 1,Verse 2,Chorus 2,Bridge,Chorus 3,Outro', audio.map((g) => g.name).join());
  const S = selfSimilarity(standardise(feats));
  ok('structure: the similarity of a bar to itself is 1, and bars of the same section in different verses are alike (stripes off the diagonal)', S[5][5] > 0.999 && S[5][21] > 0.9 && S[5][13] < 0.5);
  const nv = novelty(S);
  ok('structure: the novelty is highest where the music changes, and a flat song has no boundaries', nv[12] > nv[16] && nv[28] > nv[24] && boundaries(new Array(40).fill(0.1), 40).length === 0);
  ok('structure: a quiet start and a quiet end each get a boundary of their own when nothing else found one', addEdgeCuts([], [...new Array(4).fill(0.3), ...new Array(16).fill(1), ...new Array(4).fill(0.3)]).join() === '4,20' && addEdgeCuts([4], [...new Array(4).fill(0.3), ...new Array(16).fill(1)]).join() === '4');
  ok('structure: with no repeats nothing is called a chorus, and only one section is called a bridge', !nameSegments([{ a: 0, b: 8, label: 'A', loud: 1 }, { a: 8, b: 16, label: 'B', loud: 1 }, { a: 16, b: 24, label: 'C', loud: 1 }, { a: 24, b: 32, label: 'D', loud: 1 }, { a: 32, b: 40, label: 'E', loud: 1 }]).some((n) => /Chorus/.test(n)) && nameSegments([{ a: 0, b: 8, label: 'A', loud: 1 }, { a: 8, b: 16, label: 'B', loud: 1 }, { a: 16, b: 24, label: 'C', loud: 1 }, { a: 24, b: 32, label: 'D', loud: 1 }, { a: 32, b: 40, label: 'E', loud: 1 }]).filter((n) => n === 'Bridge').length === 1);

  const sr2 = 44100;
  const mine = [{ name: 'Verse', pos: 10 * sr2 }];
  const sug = [{ name: 'Intro', pos: 0 }, { name: 'Verse 1', pos: 10 * sr2 + 1000 }, { name: 'Chorus 1', pos: 30 * sr2 }];
  ok('structure: added suggestions skip a place you already marked (your name wins), and keep everything in order', mergeMarkers(mine, sug, false, sr2).map((m) => m.name).join() === 'Intro,Verse,Chorus 1');
  ok('structure: replacing swaps your markers for the suggestions', mergeMarkers(mine, sug, true, sr2).map((m) => m.name).join() === 'Intro,Verse 1,Chorus 1' && mine.length === 1);
}


{
  // The description the Steminize Player plugin reads.
  const proj: DawProject = {
    title: 'My Song', sampleRate: 44100, seconds: 12, bpm: 120.1, perBar: 4, padSec: 1.198,
    tracks: [
      { name: 'Bass', file: 'x', colour: '#a78bfa', vol: 0.8, pan: -0.5, mute: false, solo: false },
      { name: 'Drums', file: 'x', colour: '#fb923c', vol: 1, pan: 0, mute: true, solo: true },
    ],
    markers: [{ name: 'Verse', time: 3.2 }],
  };
  const m = JSON.parse(songManifest(proj, ['a/Bass.wav', 'a/Drums.wav']));
  ok('plugin manifest: the song, tempo, bar length and lead-in are written', m.format === 1 && m.title === 'My Song' && m.bpm === 120.1 && m.perBar === 4 && m.leadInSec === 1.198 && m.sampleRate === 44100);
  ok('plugin manifest: each stem has its own file path, colour and mixer settings', m.stems.length === 2 && m.stems[0].file === 'a/Bass.wav' && m.stems[0].gain === 0.8 && m.stems[0].pan === -0.5 && m.stems[1].mute === true && m.stems[1].solo === true && m.stems[1].colour === '#fb923c');
  ok('plugin manifest: markers are on the DAW timeline, and no tempo is written as 0', m.markers[0].name === 'Verse' && m.markers[0].timeSec === 3.2 && JSON.parse(songManifest({ ...proj, bpm: 0 }, ['a', 'b'])).bpm === 0);
}

// ---- the bundled sample song (public/sample/example-tab, made by tools/make-example-song.py)
{
  const dir = new URL('../public/sample/example-tab/', import.meta.url);
  const doc = JSON.parse(readFileSync(new URL('song.json', dir), 'utf8'));
  const files = doc.stems.map((s: { file: string }) => s.file);
  const sizes = files.map((f: string) => (existsSync(new URL(f, dir)) ? readFileSync(new URL(f, dir)).length : -1));
  ok('sample song: three stems that exist, kept small', files.length === 3 && sizes.every((n: number) => n > 10_000) && sizes.reduce((a: number, b: number) => a + b, 0) < 1_500_000);
  const tab = doc.state.scratch.tab as string;
  const { notes } = parseScore(tab);
  const anchors = doc.state.scratch.tabAnchors as { charOffset: number; time: number }[];
  ok('sample song: the tab is read in full and opens with Follow along on', notes.length === 99 && doc.state.scratch.tabFollow === true);
  ok('sample song: taps are inside the tab, in order, and match the tempo', anchors.length >= 2 && anchors.every((a, i) => a.charOffset < tab.length && (i === 0 || (a.time > anchors[i - 1].time && a.charOffset > anchors[i - 1].charOffset))) && doc.analysis.bpm === 100 && doc.analysis.beats[1] === 0.6);
}

// ---- importing Guitar Pro / MusicXML (src/import): scores made from alphaTex text, read back through the real typed-tab parser
{
  const at = await import('@coderline/alphatab');
  const { listTracks, playOrder, scoreToTab } = await import('../src/import/tabImport.ts');
  const { parseDrums } = await import('../src/lyrics/drumTab.ts');
  const score = (tex: string) => {
    const imp = new at.importer.AlphaTexImporter();
    imp.initFromString(tex, new at.Settings());
    return imp.readScore() as never;
  };
  // What every sounding note of a track should be, worked out from the score itself: [start in sixteenths, string row from the top, fret].
  const expected = (sc: any, ti: number, order: number[]) => {
    const out: string[] = [];
    let base = 0;
    for (const bi of order) {
      const mb = sc.masterBars[bi];
      const bar = sc.tracks[ti].staves[0].bars[bi];
      const voice = bar.voices.find((v: any) => v.beats.some((b: any) => !b.isRest && b.notes.length)) ?? bar.voices[0];
      for (const b of voice.beats) {
        if (b.isRest || b.graceType !== 0) continue;
        for (const n of b.notes) if (!n.isTieDestination) out.push(`${base + Math.round(b.playbackStart / 120) / 2}:${sc.tracks[ti].staves[0].tuning.length - n.string}:${n.isDead ? 'x' : n.fret}`);
      }
      base += mb.calculateDuration() / 240;
    }
    return out.sort();
  };
  const read = (text: string) =>
    parseScore(text)
      .notes.map((n) => `${n.start}:${n.string}:${n.fret === null ? 'x' : n.fret}`)
      .sort();

  const guitar = score(`\\title "Riff"\n\\tempo 96\n\\tuning (e4 b3 g3 d3 a2 e2)\n.\n\\ts 4 4\n\\ro :8 5.2 {h} 7.2 :4 5.2 {v} 0.1 |\n(0.1 2.2).4 r.4 :8 3.3 {pm} 5.3 {pm} :16 3.2 5.2 7.2 x.2 |\n\\rc 2 :4 7.1 {b (0 4)} 5.2 {sl} 7.2 {tu 3} 3.3 |\n:2 3.6 {h} 5.6 |`);
  const g = scoreToTab(guitar, 0);
  const order = playOrder((guitar as any).masterBars);
  ok('import: a guitar track comes in as the typed tab, every note on its own string and place', g.part === 'guitar' && JSON.stringify(read(g.text)) === JSON.stringify(expected(guitar, 0, order)));
  ok('import: repeats are written out, so the tab stays level with a recording that plays them', g.bars === order.length && order.length === 7 && parseScore(g.text).bars.length === 7);
  ok('import: hammer-on, slide, bend, vibrato and palm mute are written the way the tab format reads them', /5h7/.test(g.text) && /5\/7/.test(g.text) && /7b9/.test(g.text) && /5~/.test(g.text) && /PM/.test(g.text) && parseScore(g.text).notes.some((n) => n.link === 'h') && parseScore(g.text).notes.some((n) => n.link === '/') && parseScore(g.text).notes.some((n) => n.bend?.to === 9));
  ok('import: the first note is where its offset points', g.text[g.firstNote] === '5' && g.text.slice(0, g.firstNote).includes('B|'));
  ok('import: a triplet is rounded and the person is told', g.notes.some((n) => /half sixteenth/.test(n)));
  ok('import: every bar adds up to the bar', parseScore(g.text).bars.every((b) => b.length === 16));

  const bass = score(`\\tempo 90\n\\tuning (g2 d2 a1 e1)\n.\n\\ts 4 4\n:4 0.4 0.4 3.4 {h} 5.4 | :4 3.3 3.3 :8 5.3 5.3 5.3 5.3 |`);
  const b = scoreToTab(bass, 0);
  ok('import: a four-string track is the bass part', b.part === 'bass' && JSON.stringify(read(b.text)) === JSON.stringify(expected(bass, 0, playOrder((bass as any).masterBars))));

  const alt = score(`\\tempo 100\n\\tuning (e4 b3 g3 d3 a2 e2)\n.\n\\ts 4 4\n\\ro :4 1.1 2.1 3.1 4.1 | 5.1 6.1 7.1 8.1 | \\rc 3 \\ae (1 2) 9.1 10.1 | \\ae 3 0.2 |`);
  ok('import: numbered endings are played on their own passes', JSON.stringify(playOrder((alt as any).masterBars)) === JSON.stringify([0, 1, 2, 0, 1, 2, 0, 1, 3]));

  const drums = score(`\\tempo 100\n\\track "Drums"\n\\staff {score}\n\\instrument percussion\n\\ts 4 4\n:8 36 42 38 42 36 42 38 42 | :4 36 (38 42) 36 (38 46) | \\ts 3 4 :4 49 38 36 |`);
  const d = scoreToTab(drums, 0);
  ok('import: a percussion track is the drum grid, with the kit pieces on their own rows', d.part === 'drums' && /^HH\|--x---x---x---x-\|/m.test(d.text) && /^BD\|x-------x-------\|/m.test(d.text) && /^3\/4$/m.test(d.text));
  ok('import: the drum grid reads back as the same hits', parseDrums(d.text).notes.length === 8 + 6 + 3);
  ok('import: tracks are listed with what each becomes', JSON.stringify(listTracks(drums).map((t) => t.part)) === '["drums"]' && listTracks(guitar)[0].part === 'guitar' && listTracks(bass)[0].part === 'bass');

  // MusicXML with tab information (string and fret on each note)
  {
    const tun = [['E', 2], ['A', 2], ['D', 3], ['G', 3], ['B', 3], ['E', 4]].map(([st, o], i) => `<staff-tuning line="${i + 1}"><tuning-step>${st}</tuning-step><tuning-octave>${o}</tuning-octave></staff-tuning>`).join('');
    const note = (step: string, oct: number, str: number, fret: number) => `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>1</duration><type>quarter</type><notations><technical><string>${str}</string><fret>${fret}</fret></technical></notations></note>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines>${tun}</staff-details></attributes>${note('E', 2, 6, 0)}${note('A', 2, 5, 0)}${note('C', 3, 5, 3)}${note('G', 3, 3, 0)}</measure></part></score-partwise>`;
    const sc = at.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), new at.Settings()) as never;
    ok('import: a MusicXML file with tab information gives the same kind of tab', JSON.stringify(read(scoreToTab(sc, 0).text)) === JSON.stringify(['0:5:0', '12:2:0', '4:4:0', '8:4:3'].sort()));
  }

  // The same score saved as a Guitar Pro file and read back gives the same tab.
  const bytes = new at.exporter.Gp7Exporter().export(guitar as never, new at.Settings());
  const again = at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings()) as never;
  ok('import: a Guitar Pro (.gp) file gives the same tab as the score it was saved from', scoreToTab(again, 0).text === g.text);
}

// ---- auto tab: notes found in a stem -> a draft tab on the song's bar grid ----
{
  const steady = Array.from({ length: 80 }, (_, i) => i * 0.5); // 120 BPM
  ok('auto tab: beat position and time are each other\'s inverse, and carry on past the ends', Math.abs(beatPos(steady, beatTime(steady, 7.3)) - 7.3) < 1e-9 && Math.abs(beatTime(steady, -2) + 1) < 1e-9 && Math.abs(beatPos(steady, 41) - 82) < 1e-9);
  ok('auto tab: a constant lateness is found and a grid that already fits is left alone', Math.abs(fitOffset([0, 1, 2.25, 3.5].map((x) => x + 0.04), [0.5, 0.5, 0.5, 0.5], [1, 1, 1, 1]) + 0.02) < 0.006 && fitOffset([0, 1, 2.25, 3.5], [0.5, 0.5, 0.5, 0.5], [1, 1, 1, 1]) === 0);
  {
    const n = (start: number, end: number, pitch: number, amp: number) => ({ start, end, pitch, amp });
    const m = mergeRetriggers([n(0, 0.9, 33, 0.7), n(0.9, 1.1, 33, 0.3), n(1.1, 1.6, 33, 0.7), n(2, 2.3, 33, 0.3), n(2.4, 2.6, 36, 0.7), n(3, 3.2, 36, 0.7)]);
    ok('auto tab: a faint repeat of the same pitch right after a note is joined to it, but a faint note after a gap, or a firm repeat, stays', m.length === 5 && m[0].end === 1.1 && m.some((x) => x.start === 2) && m.some((x) => x.start === 3));
  }
  ok('auto tab: a straight run of bars needs two taps, a tempo change more', simplifyTimes([0, 2, 4, 6, 8], 0.03).length === 2 && simplifyTimes([0, 2, 4, 6, 9, 12], 0.03).length >= 3);

  // two bars of 4/4 bass: E1 on the beats of bar 1, then A1 / low D (below the E string: up an octave) on eighths in bar 2
  const mk = (t: number, pitch: number, len = 0.2, amp = 0.8) => ({ start: t, end: t + len, pitch, amp });
  const line = [mk(0, 28), mk(0.5, 28), mk(1, 31), mk(1.5, 33), mk(2, 28, 0.9), mk(3, 33, 0.9), mk(4, 33, 0.2), mk(4.25, 35, 0.2), mk(4.5, 38, 0.2), mk(5, 26, 0.4)];
  const late = line.map((n, i) => ({ ...n, start: n.start + 0.03 + (i % 3 - 1) * 0.008, end: n.end + 0.03 }));
  const grid = { beats: steady, downbeat: 0, perBar: 4 };
  const r = autoTab(late, grid, 'bass')!;
  ok('auto tab: a bass line comes back as a four-string tab', !!r && stringCount(r.imp.text) === 4 && r.stats.bars === 3);
  const back = parseScore(r.imp.text).notes.filter((n) => n.midi !== null).map((n) => `${n.start}:${n.midi}`);
  ok('auto tab: the notes sit on the right sixteenths with the right pitches (a note below the E string moved up an octave, the lateness removed)', JSON.stringify(back) === JSON.stringify(['0:28', '4:28', '8:31', '12:33', '16:28', '24:33', '32:33', '34:35', '36:38', '40:38']), back.join(' '));
  ok('auto tab: a steady song is timed by two taps, on the first and last bar, at the time the notes were really played', r.anchors.length === 2 && Math.abs(r.anchors[0].time - 0.03) < 0.012 && Math.abs(r.anchors[1].time - 4.03) < 0.012);
  ok('auto tab: bar starts are found in the text', barStartOffsets(r.imp.text).length === 3);
  ok('auto tab: what was changed is told', r.imp.notes.some((n) => /octave/.test(n)));
  {
    const at = (m: number) => parseScore(r.imp.text).notes.find((n) => n.midi === m);
    ok('auto tab: open strings and the lowest frets are preferred (G on the E string at 3, A open, the octave-moved note on the open D)', at(31)?.string === 3 && at(31)?.fret === 3 && at(33)?.string === 2 && at(33)?.fret === 0 && parseScore(r.imp.text).notes.filter((n) => n.midi === 38).every((n) => n.string === 1 && n.fret === 0));
  }

  // a song that speeds up: bar times follow it
  const accel: number[] = [];
  for (let t = 0, p = 0.5; accel.length < 80; t += p, p *= 0.985) accel.push(t);
  const fast = autoTab([0, 4, 8, 12, 16, 20].map((b) => mk(accel[b], 33)), { beats: accel, downbeat: 0, perBar: 4 }, 'bass')!;
  ok('auto tab: a drifting tempo gets taps along the way, the last at the last bar', fast.anchors.length >= 3 && Math.abs(fast.anchors[fast.anchors.length - 1].time - accel[20]) < 0.02);
  ok('auto tab: nothing to write gives nothing', autoTab([], grid, 'bass') === null && autoTab(line, { beats: [0, 0.5], downbeat: 0, perBar: 4 }, 'bass') === null);

  // guitar: an A minor chord on the first beat, then a single note
  const chord = [45, 52, 57, 60, 64].map((p) => mk(0, p, 0.9));
  const g = autoTab([...chord, mk(2, 67, 0.4)], grid, 'guitar')!;
  const gn = parseScore(g.imp.text).notes.filter((n) => n.midi !== null);
  ok('auto tab: a guitar chord is written as one shape on six strings', stringCount(g.imp.text) === 6 && JSON.stringify(gn.filter((n) => n.start === 0).map((n) => n.midi).sort()) === JSON.stringify([45, 52, 57, 60, 64]) && gn.filter((n) => n.start === 0).every((n) => (n.fret ?? 0) <= 5));
  ok('auto tab: each string holds one note of the chord', new Set(gn.filter((n) => n.start === 0).map((n) => n.string)).size === 5);
}

console.log(failed ? `\n${failed} FAILED` : '\nAll tests passed');

process.exit(failed ? 1 : 0);
