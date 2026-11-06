// The microphone tap for voice (audio/voice-capture.js), on the audio thread: while on, cuts the mic into 20 ms
// mono frames and posts each one (transferred, not copied). Off, it only passes time. No imports: an AudioWorklet
// module is loaded on its own.
const FRAME_S = 0.02;

class VoiceTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.size = Math.round(sampleRate * FRAME_S);
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.port.onmessage = (ev) => { this.on = !!ev.data?.on; if (!this.on) this.n = 0; };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!this.on || !ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('voice-tap', VoiceTap);
