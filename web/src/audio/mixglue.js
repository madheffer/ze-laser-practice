// CS2's last stage before the speakers: the "FinalMixGlue" compressor of the main mix graph
// (pak01 sounds/graphs/__main__.vmix, CVMixDynamicsCompressorProcessorDesc; its enable and wet-mix heap slots 59 / 60
// are 1.0). Peak mode, threshold -6 dB, knee 3.125 dB, ratio 40, attack 4 ms, release 458 ms, no make-up gain: in
// effect a limiter, so a stack of identical sounds started on one tick (ze__hell_p's spikes: 8-12 Rod.crystal at once)
// is held to a clean level instead of summing past full scale and clipping into static.
//
// WebAudio's DynamicsCompressorNode is the nearest: its ratio stops at 20 (at a -6 dB threshold 20 and 40 differ by
// a fraction of a dB), and Chromium adds an automatic make-up gain that CS2 doesn't. That gain is measured once on an
// offline render of a quiet tone (below the threshold, so the compressor itself does nothing to it) and divided out.
export const GLUE = { threshold: -6, knee: 3.125, ratio: 40, attack: 0.004, release: 0.458 };

function compressor(ctx) {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = GLUE.threshold;
  c.knee.value = GLUE.knee;
  c.ratio.value = Math.min(GLUE.ratio, c.ratio.maxValue || 20);
  c.attack.value = GLUE.attack;
  c.release.value = GLUE.release;
  return c;
}

// input -> compressor -> make-up cancel -> output. Returns { input, output }; the cancel gain settles once measured.
export function createMixGlue(ctx) {
  const comp = compressor(ctx);
  const cancel = ctx.createGain();
  comp.connect(cancel);
  measureMakeup(ctx.sampleRate).then((g) => { if (g > 0.25 && g < 4) cancel.gain.value = 1 / g; }, () => {});
  return { input: comp, output: cancel };
}

// The compressor's own gain on a -40 dBFS 1 kHz tone, after it settles.
async function measureMakeup(rate) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) return 1;
  const n = Math.round(rate * 0.5);
  const ctx = new OAC(1, n, rate);
  const osc = ctx.createOscillator();
  osc.frequency.value = 1000;
  const amp = ctx.createGain();
  amp.gain.value = 0.01;
  osc.connect(amp).connect(compressor(ctx)).connect(ctx.destination);
  osc.start();
  const out = (await ctx.startRendering()).getChannelData(0);
  let peak = 0;
  for (let i = Math.round(n * 0.6); i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  return peak / 0.01;
}
