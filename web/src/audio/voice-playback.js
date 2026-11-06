// Everyone else's voice (app/voice.js): an Opus decoder per speaker and a small jitter buffer on the audio clock.
// Its own AudioContext, apart from the game's (audio/audio.js fades and suspends that one on pause; a teammate's
// voice plays on behind the menu, as in CS2).
//
// The jitter buffer: each 20 ms packet is scheduled right after the last, `lead` seconds ahead of now when a spurt
// starts. Packets come over the co-op socket (TCP), so none are lost, only some late: a gap (an underrun) raises the
// lead by a frame, each new spurt lowers it a little again, and audio that has drifted too far behind real time is
// dropped to catch up. A steady connection settles at MIN_LEAD: the delay is the server's one way trip and ~40 ms.
//
//   const out = new VoicePlayback()
//   out.push(id, first, opus)   out.volume = 0..1   out.speaking(id)  out.level(id)  out.drop(id)  out.close()
import { RATE, FRAME_US, decoderConfig, canDecode, level } from './voice-opus.js';

const MIN_LEAD = 0.04, START_LEAD = 0.06, MAX_LEAD = 0.25, STEP = 0.02; // seconds
const DRIFT = 0.12; // scheduled this far past the lead: too late to be worth hearing
const HOLD = 0.15; // the popup stays this long after their audio ends (one spurt's small gaps don't blink it)

export class VoicePlayback {
  constructor() {
    this.ok = canDecode();
    this.ctx = this.ok ? new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' }) : null;
    this.out = this.ctx?.createGain();
    this.out?.connect(this.ctx.destination);
    this.speakers = new Map(); // id -> { dec, next, lead, levels: [{ at, v }], ts }
    this.vol = 1;
    // a context made outside a click may start suspended: the next key or click lets it run
    this.wake = () => { if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); };
    addEventListener('keydown', this.wake, true);
    addEventListener('pointerdown', this.wake, true);
  }

  set volume(v) {
    this.vol = v;
    this.out?.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  speaker(id) {
    let sp = this.speakers.get(id);
    if (!sp) {
      sp = { dec: null, next: 0, lead: START_LEAD, levels: [], ts: 0 };
      this.speakers.set(id, sp);
    }
    if (!sp.dec || sp.dec.state === 'closed') {
      sp.dec = new AudioDecoder({ output: (d) => this.play(sp, d), error: () => { sp.dec = null; } });
      sp.dec.configure(decoderConfig);
    }
    return sp;
  }

  push(id, first, opus) {
    if (!this.ctx) return;
    const sp = this.speaker(id);
    if (first) { sp.next = 0; sp.lead = Math.max(MIN_LEAD, sp.lead - STEP / 2); }
    sp.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: sp.ts, data: opus }));
    sp.ts += FRAME_US;
  }

  play(sp, data) {
    if (sp.gone || !this.ctx) { data.close(); return; } // dropped meanwhile
    const n = data.numberOfFrames;
    const buf = this.ctx.createBuffer(1, n, data.sampleRate);
    const ch = buf.getChannelData(0);
    data.copyTo(ch, { planeIndex: 0, format: 'f32-planar' });
    data.close();
    const now = this.ctx.currentTime;
    if (sp.next < now) {
      if (sp.next > 0) sp.lead = Math.min(MAX_LEAD, sp.lead + STEP); // ran dry mid-spurt: keep more in hand
      sp.next = now + sp.lead;
    } else if (sp.next - now > sp.lead + DRIFT) return; // a burst after a stall: skip this one to catch up
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    src.start(sp.next);
    sp.levels.push({ at: sp.next, v: level(ch) });
    if (sp.levels.length > 32) sp.levels.splice(0, sp.levels.length - 32);
    sp.next += buf.duration;
  }

  // is their audio playing now (the popup follows what you hear, not when the packet came)
  speaking(id) {
    const sp = this.speakers.get(id);
    return !!sp && !!this.ctx && sp.next > 0 && this.ctx.currentTime < sp.next + HOLD;
  }

  // the loudness of what is playing now, 0..1
  level(id) {
    const sp = this.speakers.get(id);
    if (!sp || !this.ctx) return 0;
    const now = this.ctx.currentTime;
    let v = 0;
    for (const l of sp.levels) if (l.at <= now) v = l.v;
    return now < sp.next ? v : 0;
  }

  ids() { return [...this.speakers.keys()]; }

  drop(id) {
    const sp = this.speakers.get(id);
    if (!sp) return;
    this.speakers.delete(id);
    sp.gone = true;
    try { if (sp.dec?.state !== 'closed') sp.dec?.close(); } catch { /* closed */ }
  }

  close() {
    for (const id of this.ids()) this.drop(id);
    removeEventListener('keydown', this.wake, true);
    removeEventListener('pointerdown', this.wake, true);
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
