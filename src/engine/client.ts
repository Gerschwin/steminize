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
  private worker!: Worker;
  private jobs = new Map<string, Pending>();
  onBackend: (b: { backend: string; threads: number; note?: string }) => void = () => {};

  constructor() {
    this.start();
  }

  private start() {
    // The entry must be chosen synchronously: ONNX Runtime re-loads this same script for its threads.
    this.worker = (navigator as any).gpu
      ? new Worker(new URL('./workerGpu.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./workerCpu.ts', import.meta.url), { type: 'module' });
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

  /**
   * Stop a job immediately. A model run can't be interrupted part-way, so
   * rather than waiting for it, throw the worker away and start a fresh one
   * (the next job reloads the model, which takes a few seconds).
   */
  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.worker.terminate();
    this.jobs.delete(id);
    const err = new Error('Cancelled');
    err.name = 'Cancelled';
    job.reject(err);
    for (const j of this.jobs.values()) j.reject(new Error('Interrupted'));
    this.jobs.clear();
    this.start();
  }
}
