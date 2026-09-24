import { Mp3Encoder } from '@breezystack/lamejs';
import { toInt, type Channels } from './pcm.ts';

export function encodeMp3(ch: Channels, kbps: number, sampleRate: number): Uint8Array {
  const enc = new Mp3Encoder(2, sampleRate, kbps);
  const l = Int16Array.from(toInt(ch[0], 16));
  const r = Int16Array.from(toInt(ch[1], 16));
  const parts: Uint8Array[] = [];
  const step = 1152 * 16;
  for (let i = 0; i < l.length; i += step) {
    const b = enc.encodeBuffer(l.subarray(i, i + step), r.subarray(i, i + step));
    if (b.length) parts.push(b.slice());
  }
  parts.push(enc.flush().slice());
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}
