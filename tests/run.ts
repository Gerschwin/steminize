// Run with: npm test   (Node 22+, uses --experimental-strip-types)
// Checks the separation maths with a fake network, and the encoders against ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEGMENT, SR, countRuns, pickStems, separate, type Member, type Stereo } from '../src/engine/separate.ts';
import { encodeFlac } from '../src/encode/flac.ts';
import { encodeWav } from '../src/encode/wav.ts';
import { encodeMp3 } from '../src/encode/mp3.ts';
import { applyClip } from '../src/encode/pcm.ts';
import { MixSource, panMatrix, renderMix } from '../src/player/mixcore.ts';
import { FLAT, PRESETS, responseDb } from '../src/player/eq.ts';
import { DEFAULT_PRACTICE, Transport } from '../src/player/transport.ts';
import { Renderer } from '../src/player/mixcore.ts';
import { analyse } from '../src/analysis/beats.ts';
import { detectKey, keyName } from '../src/analysis/key.ts';
import { BINS, CQT_FPS, NOTE_LO, cqt } from '../src/analysis/cqt.ts';
import { chordName, chordSheet, detectChords, mergeSame, prefersSharps } from '../src/analysis/chords.ts';
import { BP_PITCHES, BP_WINDOW, bpNotes, bpUnwrap, bpWindows, singleLine } from '../src/analysis/basicPitch.ts';
import { decimate2 } from '../src/analysis/resample.ts';
import { writeMidi } from '../src/encode/midi.ts';
import { detectPitch, freqToNote } from '../src/analysis/pitch.ts';
import { isNewer, parseVersion } from '../src/version.ts';
import { lineAt, parseLrc } from '../src/lyrics/lrc.ts';
import { addAnchor, charOffsetAt, coordToPlace, isLockedAt, moveAnchor, offsetToCoord, removeAnchor, rowCol, tabBlocks, tabPositionAt, toggleAnchorLock, type TabAnchor } from '../src/lyrics/tabSync.ts';
import { moveItem, nextSong, parseSetlists, prevSong, pruneSongs, totalSeconds, uniqueName, type Setlist } from '../src/setlists.ts';
import { detectLatency } from '../src/player/latency.ts';
import { placeTake } from '../src/player/placement.ts';

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

console.log(failed ? `\n${failed} FAILED` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
