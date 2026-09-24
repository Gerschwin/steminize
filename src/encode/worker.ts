/// <reference lib="webworker" />
// Encodes stems / renders mixes off the UI thread.

import { encodeAudio, type OutputOptions } from './index.ts';
import { renderMix, type Stereo } from '../player/mixcore.ts';

export type EncodeReq =
  | { type: 'stems'; id: number; stems: { name: string; data: Stereo }[]; out: OutputOptions }
  | {
      type: 'mix';
      id: number;
      name: string;
      stems: Stereo[];
      gains: number[];
      start: number;
      end: number;
      tempo: number;
      pitch: number;
      out: OutputOptions;
    };

export type EncodeRes =
  | { id: number; type: 'file'; name: string; bytes: Uint8Array }
  | { id: number; type: 'done' }
  | { id: number; type: 'error'; message: string };

const post = (m: EncodeRes, t: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, t);

self.onmessage = (e: MessageEvent<EncodeReq>) => {
  const m = e.data;
  try {
    if (m.type === 'stems') {
      for (const s of m.stems) {
        const bytes = encodeAudio(s.data, m.out);
        post({ id: m.id, type: 'file', name: s.name, bytes }, [bytes.buffer as ArrayBuffer]);
      }
    } else {
      const mix = renderMix(m.stems, m.gains, m.start, m.end, m.tempo, m.pitch);
      const bytes = encodeAudio(mix, m.out);
      post({ id: m.id, type: 'file', name: m.name, bytes }, [bytes.buffer as ArrayBuffer]);
    }
    post({ id: m.id, type: 'done' });
  } catch (err) {
    post({ id: m.id, type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
