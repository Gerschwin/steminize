/// <reference lib="webworker" />
// Separation worker: owns ONNX Runtime sessions and runs the model off the UI thread.

// The ONNX Runtime build is injected by workerGpu.ts / workerCpu.ts (see initWorker).
import type * as OrtT from 'onnxruntime-web/webgpu';
import { MODELS, neededFiles, type ModelFile, type ModelId, type Precision } from '../models.ts';
import { fixFloat64 } from './fixfloat64.ts';
import { CancelledError, SEGMENT, pickStems, separate, type Member, type Stereo } from './separate.ts';
import type { Device } from '../settings.ts';

export interface SeparateJob {
  type: 'separate';
  id: string;
  mix: Stereo;
  model: ModelId;
  precision: Precision;
  device: Device;
  shifts: number;
  overlap: number;
  twoStems: string;
  skip: string[];
}

export type WorkerIn = SeparateJob | { type: 'cancel'; id: string } | { type: 'model-bytes'; key: string; bytes: ArrayBuffer | null };

export type WorkerOut =
  | { type: 'need-model'; key: string }
  | { type: 'backend'; backend: 'webgpu' | 'wasm'; threads: number; note?: string }
  | { type: 'progress'; id: string; done: number; total: number; stage: string }
  | { type: 'done'; id: string; stems: { name: string; data: Stereo }[] }
  | { type: 'error'; id: string; message: string; cancelled?: boolean };

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

let ort: typeof OrtT;
const isolated = (self as any).crossOriginIsolated === true;

/**
 * Called by the entry file once it has imported an ONNX Runtime build. Two builds exist because the
 * WebGPU one ships an asyncify-instrumented WASM binary that makes WebKitGTK (the Linux desktop
 * webview, which has no WebGPU) allocate without bound while creating a session, and get OOM-killed.
 */
export function initWorker(o: typeof OrtT) {
  ort = o;
  ort.env.wasm.numThreads = isolated ? Math.min(8, Math.max(1, navigator.hardwareConcurrency || 4)) : 1;
  ort.env.logLevel = 'error';
}

// ---- model bytes come from the main thread (which owns the cache/download UI)
const pending = new Map<string, (b: ArrayBuffer | null) => void>();
function requestModel(key: string): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    pending.set(key, resolve);
    post({ type: 'need-model', key });
  });
}

// ---- backend choice
let gpuOk: boolean | null = null;
async function hasWebGPU() {
  if (gpuOk !== null) return gpuOk;
  try {
    const gpu = (navigator as any).gpu;
    gpuOk = !!(gpu && (await gpu.requestAdapter()));
  } catch {
    gpuOk = false;
  }
  return gpuOk;
}

async function chooseBackend(pref: Device): Promise<'webgpu' | 'wasm'> {
  if (pref === 'cpu') return 'wasm';
  return (await hasWebGPU()) ? 'webgpu' : 'wasm';
}

// Graph optimisation must stay off: ONNX Runtime's constant folding expands
// these Demucs exports from ~1.2 GB to ~4.3 GB peak, past the 4 GB WASM limit
// ("std::bad_alloc"). Measured cost of leaving it off: ~30% slower.
const SESSION_OPTS: OrtT.InferenceSession.SessionOptions = { graphOptimizationLevel: 'disabled' };

// ---- session cache (keep several on big machines, one on small ones)
const sessions = new Map<string, OrtT.InferenceSession>();
const maxSessions = ((navigator as any).deviceMemory ?? 4) >= 8 ? 4 : 1;
let lastBackend = '';

async function getSession(f: ModelFile, backend: 'webgpu' | 'wasm'): Promise<{ s: OrtT.InferenceSession; backend: 'webgpu' | 'wasm' }> {
  const id = `${f.key}|${backend}`;
  const hit = sessions.get(id);
  if (hit) {
    sessions.delete(id);
    sessions.set(id, hit); // LRU bump
    return { s: hit, backend };
  }
  while (sessions.size >= maxSessions) {
    const [k, old] = sessions.entries().next().value!;
    sessions.delete(k);
    await old.release();
  }
  const raw = await requestModel(f.key);
  if (!raw) throw new Error(`Model ${f.key} is not downloaded`);
  // Some exports use float64 maths the browser engine lacks; convert to float32.
  const bytes = fixFloat64(new Uint8Array(raw)).bytes;
  let s: OrtT.InferenceSession;
  let used = backend;
  let note: string | undefined;
  try {
    s = await ort.InferenceSession.create(bytes, { executionProviders: [backend], ...SESSION_OPTS });
  } catch (e) {
    if (backend !== 'webgpu') throw e;
    note = `GPU failed (${(e as Error).message}); using CPU`;
    used = 'wasm';
    s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], ...SESSION_OPTS });
  }
  const key = `${used}`;
  if (key !== lastBackend || note) {
    lastBackend = key;
    post({ type: 'backend', backend: used, threads: ort.env.wasm.numThreads as number, note });
  }
  sessions.set(`${f.key}|${used}`, s);
  return { s, backend: used };
}

function runner(s: OrtT.InferenceSession) {
  const inName = s.inputNames[0];
  const outName = s.outputNames[0];
  return async (input: Float32Array) => {
    const tensor = new ort.Tensor('float32', input, [1, 2, SEGMENT]);
    const out = await s.run({ [inName]: tensor });
    const y = out[outName];
    const data = (await y.getData()) as Float32Array;
    y.dispose();
    return data;
  };
}

// ---- jobs
const cancelled = new Set<string>();

function share(a: Float32Array): Float32Array {
  if (!isolated) return a;
  const s = new Float32Array(new SharedArrayBuffer(a.byteLength));
  s.set(a);
  return s;
}

async function run(job: SeparateJob) {
  const info = MODELS[job.model];
  const chosen = neededFiles(job.model, job.precision, job.twoStems, job.skip);
  const backend = await chooseBackend(job.device);
  let stage = 'Separating';

  const members: Member[] = chosen.map((f, i) => ({
    rows: f.rows,
    load: async () => {
      stage = chosen.length > 1 ? `Model ${i + 1}/${chosen.length}` : 'Separating';
      post({ type: 'progress', id: job.id, done: -1, total: 0, stage: 'Loading model' });
      const { s } = await getSession(f, backend);
      return {
        run: runner(s),
        release: async () => {
          // Specialists are big: drop them straight away on small machines.
          if (maxSessions === 1) {
            for (const [k, v] of sessions) if (v === s) sessions.delete(k);
            await s.release();
          }
        },
      };
    },
  }));

  const raw = await separate(job.mix, {
    members,
    numSources: info.stems.length,
    shifts: job.shifts,
    overlap: job.overlap,
    isCancelled: () => cancelled.has(job.id),
    onProgress: (done, total) => post({ type: 'progress', id: job.id, done, total, stage }),
  });
  const computed = chosen.flatMap((f) => f.rows);
  const stems = pickStems(raw, info.stems, job.mix, job.twoStems, computed, job.skip).map((s) => ({
    name: s.name,
    data: [share(s.data[0]), share(s.data[1])] as Stereo,
  }));
  const transfer = isolated ? [] : stems.flatMap((s) => [s.data[0].buffer as ArrayBuffer, s.data[1].buffer as ArrayBuffer]);
  post({ type: 'done', id: job.id, stems }, transfer);
}

// ONNX Runtime starts its WASM threads from this same script (named "em-pthread*").
// Those must keep ORT's own message handler, so only install ours in the main worker.
const isThreadHelper = (self.name ?? '').startsWith('em-pthread');

if (!isThreadHelper) self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.type === 'model-bytes') {
    pending.get(m.key)?.(m.bytes);
    pending.delete(m.key);
  } else if (m.type === 'cancel') {
    cancelled.add(m.id);
  } else if (m.type === 'separate') {
    try {
      await run(m);
    } catch (err) {
      const c = err instanceof CancelledError;
      post({ type: 'error', id: m.id, message: c ? 'Cancelled' : String((err as Error)?.message ?? err), cancelled: c });
    } finally {
      cancelled.delete(m.id);
    }
  }
};
