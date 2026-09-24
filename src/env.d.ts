declare module 'soundtouchjs' {
  export class FifoSampleBuffer {
    readonly frameCount: number;
    putSamples(samples: Float32Array, position: number, numFrames: number): void;
    receiveSamples(output: Float32Array, numFrames: number): void;
    clear(): void;
  }
  export class SoundTouch {
    tempo: number;
    pitchSemitones: number;
    readonly inputBuffer: FifoSampleBuffer;
    readonly outputBuffer: FifoSampleBuffer;
    process(): void;
    clear(): void;
  }
}

// AudioWorklet globals (not part of the DOM lib).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
