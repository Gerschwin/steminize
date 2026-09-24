/// <reference lib="webworker" />
// Audio-to-MIDI worker: runs Basic Pitch (bundled, ~230 KB) on one part at a time.

import * as ort from 'onnxruntime-web/webgpu';
import { BP_PITCHES, BP_WINDOW, bpNotes, bpUnwrap, bpWindows, type NoteEvent, type NoteOptions } from './basicPitch.ts';
import { decimate2 } from './resample.ts';

export type TranscribeIn = { type: 'transcribe'; id: number; mono: Float32Array; opts?: NoteOptions };
export type TranscribeOut =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'done'; id: number; notes: NoteEvent[] }
  | { type: 'error'; id: number; message: string };

const post = (m: TranscribeOut) => (self as DedicatedWorkerGlobalScope).postMessage(m);

ort.env.wasm.numThreads = (self as any).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.logLevel = 'error';

let session: Promise<ort.InferenceSession> | null = null;
const getSession = () =>
  (session ??= (async () => {
    const res = await fetch(new URL('./models/basic-pitch.onnx', import.meta.url));
    if (!res.ok) throw new Error(`Couldn't load the transcription model (${res.status})`);
    return ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
  })());

async function transcribe(m: TranscribeIn) {
  const s = await getSession();
  const audio = decimate2(m.mono, 63); // 44.1 → 22.05 kHz
  const windows = bpWindows(audio);
  const notes: Float32Array[] = [];
  const onsets: Float32Array[] = [];
  for (let i = 0; i < windows.length; i++) {
    const r = await s.run({ 'serving_default_input_2:0': new ort.Tensor('float32', windows[i], [1, BP_WINDOW, 1]) });
    notes.push(r['StatefulPartitionedCall:1'].data as Float32Array);
    onsets.push(r['StatefulPartitionedCall:2'].data as Float32Array);
    post({ type: 'progress', id: m.id, done: i + 1, total: windows.length });
  }
  const n = bpUnwrap(notes, BP_PITCHES, audio.length);
  const o = bpUnwrap(onsets, BP_PITCHES, audio.length);
  return bpNotes(n.data, o.data, n.frames, m.opts);
}

// ONNX Runtime starts its WASM threads from this same script: leave those alone.
if (!(self.name ?? '').startsWith('em-pthread'))
  self.onmessage = async (e: MessageEvent<TranscribeIn>) => {
    const m = e.data;
    try {
      post({ type: 'done', id: m.id, notes: await transcribe(m) });
    } catch (err) {
      post({ type: 'error', id: m.id, message: String((err as Error)?.message ?? err) });
    }
  };
