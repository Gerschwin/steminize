import { ALL_FILES } from '../models.ts';
import { getModelBytes } from '../modelstore.ts';
import type { SeparateJob, WorkerOut } from './worker.ts';
import type { Stereo } from './separate.ts';

export type Progress = { done: number; total: number; stage: string };
type Pending = {
  resolve: (s: { name: string; data: Stereo }[]) => void;
  reject: (e: Error) => void;
  onProgress: (p: Progress) => void;
};

export class Engine {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private jobs = new Map<string, Pending>();
  onBackend: (b: { backend: string; threads: number; note?: string }) => void = () => {};

  constructor() {
    this.worker.onmessage = async (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'need-model') {
        const f = ALL_FILES.find((x) => x.key === m.key);
        const bytes = f ? await getModelBytes(f) : null;
        this.worker.postMessage({ type: 'model-bytes', key: m.key, bytes }, bytes ? [bytes] : []);
      } else if (m.type === 'backend') {
        this.onBackend(m);
      } else if (m.type === 'progress') {
        this.jobs.get(m.id)?.onProgress(m);
      } else if (m.type === 'done') {
        this.jobs.get(m.id)?.resolve(m.stems);
        this.jobs.delete(m.id);
      } else if (m.type === 'error') {
        const err = new Error(m.message);
        if (m.cancelled) err.name = 'Cancelled';
        this.jobs.get(m.id)?.reject(err);
        this.jobs.delete(m.id);
      }
    };
    this.worker.onerror = (e) => {
      for (const j of this.jobs.values()) j.reject(new Error(e.message || 'Worker crashed (out of memory?)'));
      this.jobs.clear();
    };
  }

  separate(job: Omit<SeparateJob, 'type'>, onProgress: (p: Progress) => void) {
    return new Promise<{ name: string; data: Stereo }[]>((resolve, reject) => {
      this.jobs.set(job.id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: 'separate', ...job }, [job.mix[0].buffer as ArrayBuffer, job.mix[1].buffer as ArrayBuffer]);
    });
  }

  cancel(id: string) {
    this.worker.postMessage({ type: 'cancel', id });
  }
}
