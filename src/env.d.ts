// AudioWorklet globals (not part of the DOM lib).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
}
declare const currentFrame: number; // frame index of the block being processed, on the AudioContext clock
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
