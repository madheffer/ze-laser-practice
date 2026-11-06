// Your microphone for voice (app/voice.js): the mic -> a 20 ms tap on the audio thread (voice-worklet.js) -> the
// browser's Opus encoder -> onPacket(first, bytes). The mic opens once (the permission prompt, and a warm device, so
// the first word after a press isn't cut) and only frames while you talk are encoded.
//
//   const mic = new VoiceCapture({ onPacket: (first, opus) => ... })
//   await mic.open()      // throws 'unsupported' / 'denied' / 'no-mic'
//   mic.talk(true|false)  // push to talk; a release keeps sending TAIL_MS so the last syllable isn't clipped
//   mic.level             // your loudness 0..1 while talking (the popup's sound bars)
//   mic.close()
import { RATE, encoderConfig, canEncode, level } from './voice-opus.js';

const TAIL_MS = 200; // CS2 keeps the mic open a moment after +voicerecord goes up as well
const WORKLET = new URL('./voice-worklet.js', import.meta.url);

export class VoiceCapture {
  constructor({ onPacket }) {
    this.onPacket = onPacket;
    this.ctx = null; this.stream = null; this.node = null; this.enc = null;
    this.on = false; this.first = false; this.ts = 0; this.level = 0;
    this.tailT = 0;
    this.opening = null;
  }

  get isOpen() { return !!this.enc; }

  open() { return (this.opening ||= this.openNow().catch((e) => { this.close(); throw e; })); }

  async openNow() {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') throw new Error('unsupported');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: { ideal: RATE }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      throw new Error(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : 'no-mic');
    }
    // the context at Opus' own 48 kHz (the browser resamples the mic); where a mic at another rate can't be joined
    // to one (older Firefox), the mic's own rate and the encoder resamples
    let src;
    try {
      this.ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
      src = this.ctx.createMediaStreamSource(this.stream);
    } catch {
      await this.ctx?.close().catch(() => {});
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      src = this.ctx.createMediaStreamSource(this.stream);
    }
    const rate = this.ctx.sampleRate;
    if (!(await canEncode(rate))) throw new Error('unsupported');
    await this.ctx.audioWorklet.addModule(WORKLET);
    this.node = new AudioWorkletNode(this.ctx, 'voice-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    src.connect(this.node);
    this.node.connect(this.ctx.destination); // silent (the tap writes nothing): only so the graph pulls it
    this.enc = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        const first = this.first;
        this.first = false;
        this.onPacket(first, bytes);
      },
      error: () => { this.enc = null; this.close(); },
    });
    this.enc.configure(encoderConfig(rate));
    this.node.port.onmessage = (ev) => this.frame(ev.data, rate);
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    if (this.on) this.node.port.postMessage({ on: true }); // pressed while the prompt was up
  }

  frame(samples, rate) {
    if (!this.enc || this.enc.state !== 'configured') return;
    this.level = level(samples);
    const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: samples.length, numberOfChannels: 1, timestamp: this.ts, data: samples });
    this.ts += Math.round((samples.length / rate) * 1e6);
    this.enc.encode(data);
    data.close();
  }

  talk(down) {
    clearTimeout(this.tailT);
    if (down) {
      if (!this.on) this.first = true; // a new spurt: the listeners line their buffer up again
      this.on = true;
      this.ctx?.resume().catch(() => {});
      this.node?.port.postMessage({ on: true });
      return;
    }
    if (!this.on) return;
    this.tailT = setTimeout(() => {
      this.on = false;
      this.level = 0;
      this.node?.port.postMessage({ on: false });
      if (this.enc?.state === 'configured') this.enc.flush().catch(() => {}); // the spurt's last packet goes now, not with the next
    }, TAIL_MS);
  }

  close() {
    clearTimeout(this.tailT);
    this.on = false; this.level = 0;
    try { if (this.enc?.state !== 'closed') this.enc?.close(); } catch { /* already closed */ }
    this.enc = null;
    this.node?.disconnect();
    this.node = null;
    for (const t of this.stream?.getTracks() || []) t.stop(); // the browser's recording dot goes away
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.opening = null;
  }
}
