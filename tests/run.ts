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

// ---- 6. encoders, decoded by ffmpeg
let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
  console.log('SKIP  encoder checks (ffmpeg not installed)');
}
if (hasFfmpeg) {
  const dir = mkdtempSync(join(tmpdir(), 'stemdeck-'));
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

console.log(failed ? `\n${failed} FAILED` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
