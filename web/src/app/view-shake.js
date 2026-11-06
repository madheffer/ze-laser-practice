// Screen shakes (env_shake requests, world/entities/classes/sparks.js) as Source's client runs them (CViewEffects:
// Shake / CalcShake). A start, for this player: amplitude x (1 - distance / radius) inside the radius (everywhere
// with radius 0), nothing beyond it, nothing while airborne unless the shake says so. Each frame per shake:
//   every 1 / frequency s a new random offset in +-amplitude (and a roll of +-amplitude / 4)
//   fraction = (end - now) / duration, frequency / fraction, fraction^2 x sin(now x that) scales the offset
//   amplitude -= amplitude x frametime / (duration x frequency)
// StopShake ends them; Amplitude / Frequency change the running ones. The view origin gets the summed offset (the
// roll is kept, unused: the camera has no roll).
const MAX_SHAKES = 32;

export class ViewShake {
  constructor() { this.shakes = []; this.offset = [0, 0, 0]; this.roll = 0; }

  clear() { this.shakes.length = 0; this.offset.fill(0); this.roll = 0; }

  // ev: the engine's request; at: the player's centre; onGround; now: the game clock (s)
  request(ev, at, onGround, now) {
    if (!ev || ev.noView) return;
    if (ev.cmd === 'stop') { this.clear(); return; }
    let amp = Number(ev.amplitude) || 0;
    if (ev.radius > 0) {
      const d = Math.hypot(ev.pos[0] - at[0], ev.pos[1] - at[1], ev.pos[2] - at[2]);
      if (d > ev.radius) return;
      amp *= 1 - d / ev.radius;
    }
    if (!onGround && !ev.inAir) return;
    if (ev.cmd === 'amplitude') { for (const s of this.shakes) s.amplitude = amp; return; }
    if (ev.cmd === 'frequency') { for (const s of this.shakes) s.frequency = Number(ev.frequency) || 0; return; }
    if (ev.cmd !== 'start' || this.shakes.length >= MAX_SHAKES) return;
    const duration = Number(ev.duration) || 0, frequency = Number(ev.frequency) || 0;
    this.shakes.push({ amplitude: amp, frequency, duration, end: now + duration, next: now, offset: [0, 0, 0], angle: 0 });
  }

  // the view offset this frame
  frame(now, dt) {
    this.offset.fill(0);
    this.roll = 0;
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const s = this.shakes[i];
      if (now > s.end || s.duration <= 0 || s.amplitude <= 0 || s.frequency <= 0) { this.shakes.splice(i, 1); continue; }
      if (now > s.next) {
        s.next = now + 1 / s.frequency;
        for (let k = 0; k < 3; k++) s.offset[k] = (Math.random() * 2 - 1) * s.amplitude;
        s.angle = (Math.random() * 2 - 1) * s.amplitude * 0.25;
      }
      let fraction = (s.end - now) / s.duration;
      const freq = fraction ? s.frequency / fraction : 0;
      fraction *= fraction;
      fraction *= Math.sin(now * freq);
      for (let k = 0; k < 3; k++) this.offset[k] += s.offset[k] * fraction;
      this.roll += s.angle * fraction;
      s.amplitude -= s.amplitude * (dt / (s.duration * s.frequency));
    }
    return this.offset;
  }
}
