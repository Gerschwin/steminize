// Worklet that hands the input's samples back to the page, tagged with the audio-clock frame each block
// arrived at. Player.measureLatency() plays clicks at known frames and looks for them in this stream.
class InputProbe extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]) {
    const ch = inputs[0]?.[0];
    if (ch?.length) this.port.postMessage({ frame: currentFrame, samples: ch.slice() });
    return true;
  }
}

registerProcessor('input-probe', InputProbe);
