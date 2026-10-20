import createModule from './vendor/signalsmith-core.mjs';
import { DEFAULT_STRETCH, type StretchConfig } from './stretchConfig.ts';

/** Stereo wrapper around Signalsmith's planar WebAssembly buffers. */
export class Stretch {
  private capacity = 0;
  private pointer = 0;
  private heap: Float32Array = new Float32Array(0);

  private constructor(private module: Awaited<ReturnType<typeof createModule>>, config: StretchConfig) {
    this.configure(config);
  }

  static async create(config: StretchConfig = DEFAULT_STRETCH) {
    return new Stretch(await createModule(), config);
  }

  configure(config: StretchConfig) {
    const block = Math.round(44.1 * config.blockMs);
    const interval = Math.round(block / config.overlap);
    this.module._configure(2, block, interval, Number(config.split));
  }

  get inputLatency() {
    return this.module._inputLatency();
  }

  reset() {
    this.module._reset();
  }

  setPitch(semitones: number) {
    this.module._setTransposeSemitones(semitones, 0);
  }

  process(input: Float32Array, inputFrames: number, output: Float32Array, outputFrames: number) {
    const length = Math.max(inputFrames, outputFrames);
    if (length > this.capacity) {
      this.capacity = Math.max(length, this.capacity * 2);
      this.pointer = this.module._setBuffers(2, this.capacity) / 4;
    }
    if (this.heap.buffer !== this.module.HEAP8.buffer) this.heap = new Float32Array(this.module.HEAP8.buffer);
    let heap = this.heap;
    const leftIn = this.pointer;
    const rightIn = leftIn + this.capacity;
    for (let i = 0; i < inputFrames; i++) {
      heap[leftIn + i] = input[2 * i];
      heap[rightIn + i] = input[2 * i + 1];
    }
    this.module._process(inputFrames, outputFrames);
    if (this.heap.buffer !== this.module.HEAP8.buffer) this.heap = new Float32Array(this.module.HEAP8.buffer);
    heap = this.heap;
    const leftOut = rightIn + this.capacity;
    const rightOut = leftOut + this.capacity;
    for (let i = 0; i < outputFrames; i++) {
      output[2 * i] = heap[leftOut + i];
      output[2 * i + 1] = heap[rightOut + i];
    }
  }
}
