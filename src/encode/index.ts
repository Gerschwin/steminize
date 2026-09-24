import { applyClip, type Channels } from './pcm.ts';
import { encodeWav } from './wav.ts';
import { encodeFlac } from './flac.ts';
import { encodeMp3 } from './mp3.ts';
import type { Settings } from '../settings.ts';

export type OutputOptions = Pick<Settings, 'format' | 'wavDepth' | 'flacDepth' | 'mp3Bitrate' | 'clip'>;

export function encodeAudio(ch: Channels, o: OutputOptions, sampleRate = 44100): Uint8Array {
  // 'none' keeps overs in 32-bit float WAV; integer formats then saturate at full scale.
  const c = applyClip(ch, o.clip);
  if (o.format === 'flac') return encodeFlac(c, o.flacDepth === '24' ? 24 : 16, sampleRate);
  if (o.format === 'mp3') return encodeMp3(c, o.mp3Bitrate, sampleRate);
  return encodeWav(c, o.wavDepth, sampleRate);
}
