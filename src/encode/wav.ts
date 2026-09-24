import { toInt, type Channels } from './pcm.ts';

export function encodeWav(ch: Channels, depth: '16' | '24' | '32f', sampleRate: number): Uint8Array {
  const n = ch[0].length;
  const bytesPer = depth === '16' ? 2 : depth === '24' ? 3 : 4;
  const dataLen = n * 2 * bytesPer;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, depth === '32f' ? 3 : 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2 * bytesPer, true);
  v.setUint16(32, 2 * bytesPer, true);
  v.setUint16(34, bytesPer * 8, true);
  str(36, 'data');
  v.setUint32(40, dataLen, true);

  let o = 44;
  if (depth === '32f') {
    for (let i = 0; i < n; i++, o += 8) {
      v.setFloat32(o, ch[0][i], true);
      v.setFloat32(o + 4, ch[1][i], true);
    }
  } else if (depth === '16') {
    const [l, r] = [toInt(ch[0], 16), toInt(ch[1], 16)];
    for (let i = 0; i < n; i++, o += 4) {
      v.setInt16(o, l[i], true);
      v.setInt16(o + 2, r[i], true);
    }
  } else {
    const bytes = new Uint8Array(buf);
    const [l, r] = [toInt(ch[0], 24), toInt(ch[1], 24)];
    for (let i = 0; i < n; i++) {
      for (const s of [l[i], r[i]]) {
        bytes[o++] = s & 0xff;
        bytes[o++] = (s >> 8) & 0xff;
        bytes[o++] = (s >> 16) & 0xff;
      }
    }
  }
  return new Uint8Array(buf);
}
