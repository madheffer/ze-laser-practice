// Per-voice shaping the csgo_mega stack does, as WebAudio automation (sound events from lasers-bake, audio/audio.js):
//  - time_volume_mapping_curve: the volume over the time since the voice started (soundscape loops fade in over 1 s)
//  - fadetime_volume_mapping_curve: the volume over the time since it was stopped; it keeps playing until the curve's
//    last x (stop_elapsed_time_less_than_fade_curve -> should_continue_playing). An empty curve stops it at once
//  - randomize_position_min / max_radius (+ _hemisphere): a random point that far from where it plays
// Curves are [[x, y], ...] (seconds, gain), linear between points.

// Schedule `param` to follow curve from time t0 (the curve's x = 0), times scale.
export function followCurve(param, curve, t0, scale = 1) {
  if (!Array.isArray(curve) || !curve.length) return;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(curve[0][1] * scale, t0 + Math.max(0, curve[0][0]));
  for (let i = 1; i < curve.length; i++) param.linearRampToValueAtTime(curve[i][1] * scale, t0 + Math.max(0, curve[i][0]));
}

// The stop fade from time t: from the current value along the curve (its y relative to the curve's start); returns
// how long the voice keeps sounding (the curve's last x), 0 when it has none.
export function fadeOut(param, curve, t) {
  if (!Array.isArray(curve) || curve.length < 2) return 0;
  const from = param.value;
  const y0 = curve[0][1] || 1;
  param.cancelScheduledValues(t);
  param.setValueAtTime(from, t);
  for (let i = 1; i < curve.length; i++) param.linearRampToValueAtTime(from * curve[i][1] / y0, t + Math.max(0, curve[i][0]));
  return Math.max(0, curve[curve.length - 1][0]);
}

// a point between min and max units from base, uniform over the sphere (z >= 0 with hemisphere)
export function randomAround(base, [min, max, hemisphere]) {
  const z = hemisphere ? Math.random() : Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const d = min + Math.random() * Math.max(0, max - min);
  return [base[0] + Math.cos(a) * r * d, base[1] + Math.sin(a) * r * d, base[2] + z * d];
}
