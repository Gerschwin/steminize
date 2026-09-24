// Compact FLAC encoder: fixed linear predictors (orders 0-4), adaptive
// stereo decorrelation and partitioned Rice coding. Output is lossless and
// typically within ~5% of `flac -5` in size.

import { toInt, type Channels } from './pcm.ts';

const BLOCK = 4096;

class BitWriter {
  buf = new Uint8Array(1 << 20);
  pos = 0;
  private acc = 0;
  private n = 0;

  private grow(extra: number) {
    if (this.pos + extra <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra));
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
  /** Write the low `bits` bits of a non-negative value (bits <= 24). */
  private put(value: number, bits: number) {
    this.acc = this.acc * (1 << bits) + value;
    this.n += bits;
    this.grow(4);
    while (this.n >= 8) {
      this.n -= 8;
      const p = 2 ** this.n;
      const byte = Math.floor(this.acc / p);
      this.buf[this.pos++] = byte;
      this.acc -= byte * p;
    }
  }
  bits(value: number, bits: number) {
    if (bits > 24) {
      this.put(Math.floor(value / 2 ** 24), bits - 24);
      this.put(value % 2 ** 24, 24);
    } else if (bits > 0) this.put(value, bits);
  }
  signed(value: number, bits: number) {
    this.bits(value < 0 ? value + 2 ** bits : value, bits);
  }
  unary(zeros: number) {
    while (zeros >= 24) {
      this.put(0, 24);
      zeros -= 24;
    }
    this.put(1, zeros + 1);
  }
  align() {
    if (this.n) this.put(0, 8 - this.n);
  }
  bytes(from = 0) {
    return this.buf.subarray(from, this.pos);
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
const crc8 = (b: Uint8Array) => b.reduce((c, x) => CRC8[c ^ x], 0);
const crc16 = (b: Uint8Array) => {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]];
  return c;
};

/** Residual of a fixed predictor of the given order. */
function residual(x: Int32Array | Float64Array, order: number, out: Float64Array) {
  const n = x.length;
  for (let i = order; i < n; i++) {
    switch (order) {
      case 0: out[i] = x[i]; break;
      case 1: out[i] = x[i] - x[i - 1]; break;
      case 2: out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
  }
}

/** Pick the best fixed order by total absolute residual (libFLAC's heuristic). */
function bestOrder(x: Int32Array | Float64Array): { order: number; cost: number } {
  const n = x.length;
  if (n <= 4) return { order: -1, cost: Infinity };
  const s = [0, 0, 0, 0, 0];
  for (let i = 4; i < n; i++) {
    const e0 = x[i];
    const e1 = e0 - x[i - 1];
    const e2 = e1 - (x[i - 1] - x[i - 2]);
    const e3 = e2 - (x[i - 1] - 2 * x[i - 2] + x[i - 3]);
    const e4 = e3 - (x[i - 1] - 3 * x[i - 2] + 3 * x[i - 3] - x[i - 4]);
    s[0] += Math.abs(e0); s[1] += Math.abs(e1); s[2] += Math.abs(e2); s[3] += Math.abs(e3); s[4] += Math.abs(e4);
  }
  let order = 0;
  for (let o = 1; o < 5; o++) if (s[o] < s[order]) order = o;
  const mean = (2 * s[order]) / (n - 4) + 1;
  const k = Math.max(0, Math.floor(Math.log2(mean)));
  return { order, cost: n * (k + 1) + (2 * s[order]) / 2 ** k };
}

const riceBits = (sum: number, count: number, k: number) => count * (k + 1) + Math.floor(sum / 2 ** k);
function riceParam(sum: number, count: number, max: number) {
  if (count === 0 || sum === 0) return 0;
  const k = Math.max(0, Math.floor(Math.log2(sum / count)));
  return Math.min(max, k);
}

function writeSubframe(w: BitWriter, x: Int32Array | Float64Array, bps: number) {
  const n = x.length;
  const { order } = bestOrder(x);
  let allSame = true;
  for (let i = 1; i < n && allSame; i++) allSame = x[i] === x[0];
  if (allSame) {
    w.bits(0, 8); // CONSTANT
    w.signed(x[0], bps);
    return;
  }
  if (order < 0) {
    w.bits(1 << 1, 8); // VERBATIM
    for (let i = 0; i < n; i++) w.signed(x[i], bps);
    return;
  }
  const res = new Float64Array(n);
  residual(x, order, res);
  const u = new Float64Array(n);
  let maxU = 0;
  for (let i = order; i < n; i++) {
    const r = res[i];
    u[i] = r >= 0 ? 2 * r : -2 * r - 1;
    if (u[i] > maxU) maxU = u[i];
  }
  // 24-bit audio can need Rice parameters above 14, which require the 5-bit variant.
  const wide = bps > 17 || maxU >= 2 ** 30;
  const maxK = wide ? 30 : 14;

  // Choose the partition order with the fewest estimated bits.
  let bestP = 0;
  let bestBits = Infinity;
  for (let p = 0; p <= 8; p++) {
    const parts = 1 << p;
    if (n % parts || n / parts <= order) break;
    const size = n / parts;
    let bits = 0;
    for (let q = 0; q < parts; q++) {
      const from = q === 0 ? order : q * size;
      let sum = 0;
      for (let i = from; i < (q + 1) * size; i++) sum += u[i];
      const count = (q + 1) * size - from;
      bits += riceBits(sum, count, riceParam(sum, count, maxK)) + (wide ? 5 : 4);
    }
    if (bits < bestBits) [bestBits, bestP] = [bits, p];
  }
  if (bestBits + order * bps > n * bps) {
    w.bits(1 << 1, 8); // VERBATIM is smaller (noise-like block)
    for (let i = 0; i < n; i++) w.signed(x[i], bps);
    return;
  }

  w.bits((0b001000 | order) << 1, 8); // FIXED
  for (let i = 0; i < order; i++) w.signed(x[i], bps);
  w.bits(wide ? 1 : 0, 2);
  w.bits(bestP, 4);
  const parts = 1 << bestP;
  const size = n / parts;
  for (let q = 0; q < parts; q++) {
    const from = q === 0 ? order : q * size;
    const to = (q + 1) * size;
    let sum = 0;
    for (let i = from; i < to; i++) sum += u[i];
    const k = riceParam(sum, to - from, maxK);
    w.bits(k, wide ? 5 : 4);
    const div = 2 ** k;
    for (let i = from; i < to; i++) {
      const q2 = Math.floor(u[i] / div);
      w.unary(q2);
      w.bits(u[i] - q2 * div, k);
    }
  }
}

function utf8Number(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let lead = 0xc0;
  let room = 0x1f;
  for (;;) {
    bytes.unshift(0x80 | (n & 0x3f));
    n = Math.floor(n / 64);
    if (n <= room) break;
    lead = 0x80 | (lead >> 1);
    room >>= 1;
  }
  bytes.unshift(lead | n);
  return bytes;
}

export function encodeFlac(ch: Channels, depth: 16 | 24, sampleRate: number): Uint8Array {
  const L = toInt(ch[0], depth);
  const R = toInt(ch[1], depth);
  const total = L.length;
  const w = new BitWriter();

  // Header + STREAMINFO (min/max frame size and MD5 left as "unknown").
  for (const c of 'fLaC') w.bits(c.charCodeAt(0), 8);
  w.bits(0x80, 8); // last metadata block, type 0
  w.bits(34, 24);
  w.bits(BLOCK, 16);
  w.bits(BLOCK, 16);
  w.bits(0, 24);
  w.bits(0, 24);
  w.bits(sampleRate, 20);
  w.bits(1, 3); // 2 channels
  w.bits(depth - 1, 5);
  w.bits(total, 36);
  for (let i = 0; i < 8; i++) w.bits(0, 16); // MD5 (unknown)

  const rateCode = sampleRate === 44100 ? 9 : sampleRate === 48000 ? 10 : 0;
  const sizeCode = depth === 16 ? 4 : 6;

  for (let start = 0, frame = 0; start < total; start += BLOCK, frame++) {
    const n = Math.min(BLOCK, total - start);
    const l = L.subarray(start, start + n);
    const r = R.subarray(start, start + n);
    const mid = new Float64Array(n);
    const side = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      side[i] = l[i] - r[i];
      mid[i] = Math.floor((l[i] + r[i]) / 2);
    }
    const [cl, cr, cm, cs] = [l, r, mid, side].map((x) => bestOrder(x).cost);
    const options: [number, number][] = [[1, cl + cr], [8, cl + cs], [9, cr + cs], [10, cm + cs]];
    const mode = n > 4 ? options.reduce((a, b) => (b[1] < a[1] ? b : a))[0] : 1;

    const frameStart = w.pos;
    w.bits(0b11111111111110, 14);
    w.bits(0, 2);
    const sizeBits = n === BLOCK ? 12 : 7;
    w.bits(sizeBits, 4);
    w.bits(rateCode, 4);
    w.bits(mode, 4);
    w.bits(sizeCode, 3);
    w.bits(0, 1);
    for (const b of utf8Number(frame)) w.bits(b, 8);
    if (sizeBits === 7) w.bits(n - 1, 16);
    w.bits(crc8(w.bytes(frameStart)), 8);

    const [a, b, ba, bb] =
      mode === 1 ? [l, r, depth, depth] :
      mode === 8 ? [l, side, depth, depth + 1] :
      mode === 9 ? [side, r, depth + 1, depth] :
      [mid, side, depth, depth + 1];
    writeSubframe(w, a, ba);
    writeSubframe(w, b, bb);
    w.align();
    w.bits(crc16(w.bytes(frameStart)), 16);
  }
  return w.bytes().slice();
}
