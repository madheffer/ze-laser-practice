// CS2's room reverb (RoomDSP). The main mix graph (sounds/graphs/__main__.vmix) feeds a reverb sub-mix whose preset
// is the RoomDSP input; its default (heap slot 3, token 64003126) is "core_null": no reverb. A sound event with
// override_dsp_preset switches RoomDSP to its dsp_preset (csgo_mega vmix_mixgraph_input_dsp_preset), as a soundscape
// does; each voice sends to it by its mix group's dsp value (@mixer.output_dsp, audio/mix.js mixGroupDsp).
// None of the 9 baked maps switches it (ze__hell_p's soundscape is Valve's dust.Indoors with the preset removed), so
// they play dry, as in CS2.
//
// A preset is a chain of mix processors (lib/sound-mix-cs2.js DSP_PRESETS, from sounds/graphs/reverb_*.vmix): its
// impulse response is rendered once, offline, through WebAudio nodes built from those numbers, and played through a
// ConvolverNode. Delay (direct / delayed / feedback taps, feedback low-pass) and Filter (type, cutoff, Q, slope) are
// built as the graph states them; Diffusor (Schroeder allpasses sized by m_flSize, m_flComplexity of them, m_flFeedback)
// and Boxverb (parallel combs spread over m_flSizeMin..m_flSizeMax units, m_flFeedbackScale, its damping filter) are
// approximations of Valve's processors, which aren't documented.
import { DSP_PRESETS } from '../lib/sound-mix-cs2.js';

const IR_SECONDS = 4;
const db = (x) => Math.pow(10, (Number(x) || 0) / 20);
const UNIT_MS = 0.0254 / 343 * 1000; // a Source unit (an inch) of sound path, in ms

function biquadType(t) {
  switch (String(t || '')) {
    case 'FILTER_HIGHPASS': return 'highpass';
    case 'FILTER_BANDPASS': return 'bandpass';
    case 'FILTER_NOTCH': return 'notch';
    case 'FILTER_PEAKING_EQ': return 'peaking';
    case 'FILTER_LOW_SHELF': return 'lowshelf';
    case 'FILTER_HIGH_SHELF': return 'highshelf';
    default: return 'lowpass';
  }
}
// a Filter desc as a chain of biquads (12 dB/oct each; 48 dB = 4), or null when disabled
function filterChain(ctx, f, input) {
  if (!f || f.m_bEnabled === false) return input;
  const slope = String(f.m_nFilterSlope || '');
  const n = /48dB/.test(slope) ? 4 : /36dB/.test(slope) ? 3 : /24dB/.test(slope) ? 2 : 1;
  let node = input;
  for (let i = 0; i < n; i++) {
    const b = ctx.createBiquadFilter();
    b.type = biquadType(f.m_nFilterType);
    b.frequency.value = Math.min(ctx.sampleRate / 2 - 100, Math.max(10, Number(f.m_flCutoffFreq) || 22000));
    b.Q.value = Number(f.m_flQ) || 0.707;
    if (f.m_fldbGain) b.gain.value = Number(f.m_fldbGain);
    node.connect(b);
    node = b;
  }
  return node;
}

// each processor: (ctx, desc, input node) -> output node
const PROCESSORS = {
  Delay(ctx, d, input) {
    const out = ctx.createGain();
    const direct = ctx.createGain(); direct.gain.value = db(d.m_flDirectGain);
    input.connect(direct).connect(out);
    const line = ctx.createDelay(4);
    line.delayTime.value = Math.min(4, Math.max(0.001, (Number(d.m_flDelay) || 0) / 1000));
    const wet = ctx.createGain(); wet.gain.value = db(d.m_flDelayGain);
    input.connect(line);
    line.connect(wet).connect(out);
    const fb = ctx.createGain(); fb.gain.value = Math.min(0.98, db(d.m_flFeedbackGain));
    const loop = d.m_bEnableFilter ? filterChain(ctx, d.m_feedbackFilter, line) : line;
    loop.connect(fb).connect(line);
    return out;
  },
  Diffusor(ctx, d, input) {
    const size = Math.max(0.05, Number(d.m_flSize) || 1);
    const g = Math.min(0.9, db(d.m_flFeedback));
    const stages = Math.max(1, Math.min(12, Math.round(Number(d.m_flComplexity) || 4)));
    const BASE_MS = [4.77, 3.59, 12.73, 9.31, 7.11, 5.23, 15.97, 11.07, 6.37, 8.53, 13.39, 10.19];
    let node = input;
    for (let i = 0; i < stages; i++) {
      // y = -g x + x[n-D] + g y[n-D]
      const sum = ctx.createGain();
      const line = ctx.createDelay(1);
      line.delayTime.value = BASE_MS[i] * size / 1000;
      const ff = ctx.createGain(); ff.gain.value = -g;
      const fb = ctx.createGain(); fb.gain.value = g;
      const pre = ctx.createGain();
      node.connect(pre);
      fb.connect(pre);
      pre.connect(line);
      node.connect(ff).connect(sum);
      line.connect(sum);
      sum.connect(fb);
      node = sum;
    }
    const out = ctx.createGain(); out.gain.value = db(d.m_flOutputGain);
    node.connect(out);
    return out;
  },
  Boxverb(ctx, d, input) {
    const lo = Math.max(1, Number(d.m_flSizeMin) || 20), hi = Math.max(lo, Number(d.m_flSizeMax) || 100);
    const n = Math.max(2, Math.min(16, Math.round(Number(d.m_flComplexity) || 8)));
    const fbScale = Math.min(0.97, Math.max(0, Number(d.m_flFeedbackScale ?? 0.9)));
    const out = ctx.createGain(); out.gain.value = db(d.m_flOutputGain) / Math.sqrt(n);
    for (let i = 0; i < n; i++) {
      // delays spread across the box's sizes, detuned so the combs don't line up
      const units = lo + (hi - lo) * (n > 1 ? i / (n - 1) : 0.5);
      const line = ctx.createDelay(1);
      line.delayTime.value = Math.max(0.001, units * UNIT_MS * (1 + 0.137 * ((i * 7) % 5) / 5) / 1000 * 4);
      const fb = ctx.createGain(); fb.gain.value = fbScale;
      input.connect(line);
      const damped = filterChain(ctx, d.m_filterType, line);
      damped.connect(fb).connect(line);
      damped.connect(out);
    }
    return out;
  },
  Filter(ctx, d, input) { return filterChain(ctx, d, input); },
};

const cache = new Map(); // preset -> Promise<AudioBuffer | null>

// the preset's impulse response (null for core_null / unknown presets / no OfflineAudioContext)
export function presetImpulse(name, sampleRate) {
  const key = String(name || '').toLowerCase();
  const chain = DSP_PRESETS[key];
  const OAC = globalThis.OfflineAudioContext;
  if (!chain || !OAC) return Promise.resolve(null);
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const ctx = new OAC(2, Math.round(sampleRate * IR_SECONDS), sampleRate);
      const imp = ctx.createBuffer(1, 2, sampleRate);
      imp.getChannelData(0)[0] = 1;
      const src = ctx.createBufferSource();
      src.buffer = imp;
      let node = src;
      for (const p of chain) if (PROCESSORS[p.class]) node = PROCESSORS[p.class](ctx, p.desc || {}, node);
      node.connect(ctx.destination);
      src.start();
      return ctx.startRendering();
    })().catch(() => null));
  }
  return cache.get(key);
}

// The reverb bus: voices send into `input`; the current RoomDSP preset's convolver feeds `output`.
export class RoomDsp {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.preset = 'core_null';
    this.conv = null;
  }

  async setPreset(name) {
    const key = String(name || 'core_null').toLowerCase();
    if (key === this.preset) return;
    this.preset = key;
    const ir = await presetImpulse(key, this.ctx.sampleRate);
    if (this.preset !== key) return; // switched again meanwhile
    if (this.conv) { try { this.input.disconnect(this.conv); this.conv.disconnect(); } catch { /* gone */ } this.conv = null; }
    if (!ir) return; // core_null / unknown: dry
    const conv = this.ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = ir;
    this.input.connect(conv).connect(this.output);
    this.conv = conv;
  }
}
