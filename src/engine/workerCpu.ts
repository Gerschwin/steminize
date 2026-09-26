// Worker entry for browsers without WebGPU (e.g. the Linux desktop webview): uses the CPU-only
// ONNX Runtime build. See initWorker in worker.ts for why this must be a separate build.
import * as ort from 'onnxruntime-web/wasm';
import { initWorker } from './worker.ts';

initWorker(ort);
