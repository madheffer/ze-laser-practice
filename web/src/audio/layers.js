// CS2's mix layers: the temporary volume changes over the Default_Mix levels (scripts/soundmixers.txt MixLayers,
// generated into lib/sound-mix-cs2.js). soundsystem.dll FUN_1800324b0 folds them into one factor per group: it starts
// at 1, and for each layer with amount a > 0 that lists the group at vol v, factor = clamp01(factor + (v - 1) * w),
// w = a * a / (sum of the amounts of the layers listing that group); one layer alone is lerp(1, v, a).
// The factor multiplies the group's level, and a group's level carries its parent's (audio/mix.js).
// Who sets the amounts: the game (DeathFadeLayer on the death cam, client.dll cl_deathcam_audio_mix_*), and a layer's
// triggers: while a sound of the trigger's mix group plays louder than its threshold the layer goes to mixamount over
// `attack` s, back to 0 over `release` s when none does.
import { MIX_LAYERS } from '../lib/sound-mix-cs2.js';

export class MixLayers {
  constructor() {
    this.amount = new Map(); // layer -> current amount
    this.ramps = new Map(); // layer -> { from, to, t0, dur }
    this.version = 0; // bumped when any factor may have changed (audio.js re-levels its voices)
  }

  // the current amount, after any ramp at time now (seconds)
  current(name, now) {
    const r = this.ramps.get(name);
    if (r) {
      const k = r.dur > 0 ? Math.min(1, (now - r.t0) / r.dur) : 1;
      const a = r.from + (r.to - r.from) * k;
      this.amount.set(name, a);
      if (k >= 1) this.ramps.delete(name);
      return a;
    }
    return this.amount.get(name) || 0;
  }

  // ramp layer `name` to `to` over `dur` s from now
  set(name, to, dur, now) {
    if (!MIX_LAYERS[name]) return;
    const from = this.current(name, now);
    if (from === to && !this.ramps.has(name)) return;
    this.ramps.set(name, { from, to: Math.max(0, Math.min(1, to)), t0: now, dur: Math.max(0, dur) });
    this.version++;
  }

  clear() { this.amount.clear(); this.ramps.clear(); this.version++; }

  // triggers: groupsLoud is the set of mix groups with a voice playing above zero right now (lower-case names)
  tick(now, groupLevel) {
    for (const [name, layer] of Object.entries(MIX_LAYERS)) {
      for (const t of layer.triggers) {
        const on = groupLevel(String(t.trigger).toLowerCase()) > (t.threshold || 0);
        const target = on ? t.mixamount : 0;
        const r = this.ramps.get(name);
        if ((r ? r.to : this.current(name, now)) !== target) this.set(name, target, on ? t.attack : t.release, now);
      }
    }
    if (this.ramps.size) this.version++;
  }

  // the factor for mix group `group` (exact name) at time now
  factor(group, now) {
    let total = 0;
    const active = [];
    for (const [name, layer] of Object.entries(MIX_LAYERS)) {
      if (!(group in layer.mixers)) continue;
      const a = this.current(name, now);
      if (a > 0) { total += a; active.push([a, layer.mixers[group]]); }
    }
    let f = 1;
    for (const [a, v] of active) f = Math.max(0, Math.min(1, f + (v - 1) * (a / total) * a));
    return f;
  }
}

// CS2's death-cam fade (client.dll FUN_180d0ef50 and its cvars' defaults): DeathFadeLayer ramps to
// cl_deathcam_audio_mix_phase1_fade_amount 0.15 over cl_deathcam_audio_mix_phase1_fade_time 2 s while the death cam
// runs, then to phase2's 0.5 over 0.4 s as it fades out, and back to 0 once you are spectating.
export const DEATH_FADE = { phase1: [0.15, 2], phase2: [0.5, 0.4] };
