// AudioWorklet tap: forwards mono Float32 audio blocks from the render thread to the offscreen
// document, which resamples to 16 kHz s16le PCM and ships them over the meeting WebSocket.
// Buffers ~2048 samples per post (native rate) to keep message traffic low. Runs in
// AudioWorkletGlobalScope (no window/DOM), authored as a classic script.
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.stream = (options && options.processorOptions && options.processorOptions.stream) || "tab";
    this.buf = new Float32Array(2048);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          const out = this.buf.slice(0, this.n);
          this.port.postMessage({ stream: this.stream, samples: out }, [out.buffer]);
          this.n = 0;
        }
      }
    }
    return true; // keep the node alive even during silence
  }
}

registerProcessor("pa-pcm-tap", PcmTap);
