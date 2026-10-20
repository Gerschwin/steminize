`signalsmith-core.mjs` is the WebAssembly core from the official
[Signalsmith Stretch web release](https://github.com/Signalsmith-Audio/signalsmith-stretch/tree/main/web/release).
It was extracted from `SignalsmithStretch.mjs` in the `signalsmith-stretch@1.3.2`
npm package, up to `function registerWorkletProcessor`, and given a default export.
The release's AudioWorklet and AudioNode wrappers are omitted because Steminize
already has its own player worklet. The upstream MIT licence is in `LICENSE.txt`.
