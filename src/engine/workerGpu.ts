// Worker entry for browsers that expose WebGPU: uses the WebGPU-capable ONNX Runtime build.
import * as ort from 'onnxruntime-web/webgpu';
import { initWorker } from './worker.ts';

initWorker(ort);
