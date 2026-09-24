// Main-thread handle on the audio-to-MIDI worker. One job at a time;
// cancelling throws the worker away (a model run can't be interrupted).

import type { NoteEvent, NoteOptions } from './basicPitch.ts';
import type { TranscribeOut } from './transcribeWorker.ts';

let worker: Worker | null = null;
let id = 0;
let current: { id: number; reject: (e: Error) => void } | null = null;

export function cancelTranscribe() {
  if (!current) return;
  worker?.terminate();
  worker = null;
  const e = new Error('Cancelled');
  e.name = 'Cancelled';
  current.reject(e);
  current = null;
}

export function transcribe(mono: Float32Array, onProgress: (done: number, total: number) => void, opts?: NoteOptions) {
  cancelTranscribe();
  worker ??= new Worker(new URL('./transcribeWorker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const my = ++id;
  return new Promise<NoteEvent[]>((resolve, reject) => {
    current = { id: my, reject };
    w.onmessage = (e: MessageEvent<TranscribeOut>) => {
      const m = e.data;
      if (m.id !== my) return;
      if (m.type === 'progress') onProgress(m.done, m.total);
      else {
        current = null;
        if (m.type === 'done') resolve(m.notes);
        else reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      current = null;
      worker = null;
      reject(new Error(e.message || 'Transcription crashed'));
    };
    w.postMessage({ type: 'transcribe', id: my, mono, opts }, [mono.buffer as ArrayBuffer]);
  });
}
