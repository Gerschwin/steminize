interface SignalsmithModule {
  HEAP8: Int8Array;
  _configure(channels: number, blockSamples: number, intervalSamples: number, splitComputation: number): void;
  _setBuffers(channels: number, length: number): number;
  _setTransposeSemitones(semitones: number, tonalityLimit: number): void;
  _inputLatency(): number;
  _reset(): void;
  _process(inputFrames: number, outputFrames: number): void;
}

declare const createModule: () => Promise<SignalsmithModule>;
export default createModule;
