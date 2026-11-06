// Screen fades (env_fade requests, world/entities/classes/fade.js) as Source's client runs them (CViewEffects::Fade /
// FadeCalculate, view_effects.cpp), on the game clock so a pause freezes them:
//   fade TO the colour:   alpha climbs 0 -> a over `duration`, holds `hold` s, then the fade is gone (no ramp back)
//   fade FROM the colour: alpha a for `hold` s, then falls a -> 0 over `duration`
//   stay out: never removed (a map's final fade to black)
// Several at once: their alphas add (capped at 255), their colours average. Modulate multiplies the scene instead.
// Drawn as one full-screen element over the world, under the HUD (Source draws the fade before vgui).
const MAX_FADES = 16;

export class ScreenFade {
  constructor(el) { this.el = el; this.fades = []; this.last = ''; }

  clear() { this.fades.length = 0; this.draw(0, [0, 0, 0], false); }

  // ev: the engine's request; now: the game clock (s)
  request(ev, now) {
    if (!ev || this.fades.length >= MAX_FADES) return;
    const { duration, hold } = ev;
    // Fade(): End / Reset as Source sets them, and the signed speed (alpha / duration)
    const f = { color: ev.color, alpha: ev.alpha, fadeIn: ev.fadeIn, modulate: ev.modulate, stayOut: ev.stayOut };
    if (duration > 0) {
      if (ev.fadeIn) { f.speed = ev.alpha / duration; f.reset = now + hold; f.end = f.reset + duration; }
      else { f.speed = -ev.alpha / duration; f.end = now + duration; f.reset = f.end + hold; }
    } else { f.speed = 0; f.end = 0; f.reset = hold; } // as Source: not moved onto the clock, so gone at once unless stay out
    this.fades.push(f);
  }

  // FadeCalculate: drop the finished ones, sum the rest; then draw
  frame(now) {
    let a = 0, mod = false;
    const rgb = [0, 0, 0];
    for (let i = this.fades.length - 1; i >= 0; i--) {
      const f = this.fades[i];
      if (f.stayOut) f.reset = now + 0.1;
      if (now > f.reset && now > f.end) this.fades.splice(i, 1);
    }
    for (const f of this.fades) {
      let fa = f.speed * (f.end - now);
      if (!f.fadeIn) fa += f.alpha; // "flip so we fade out instead of in"
      a += Math.max(0, Math.min(f.alpha, fa));
      for (let k = 0; k < 3; k++) rgb[k] += f.color[k];
      if (f.modulate) mod = true;
    }
    if (this.fades.length) for (let k = 0; k < 3; k++) rgb[k] /= this.fades.length;
    this.draw(Math.min(255, a), rgb, mod);
  }

  draw(alpha, rgb, mod) {
    const css = alpha <= 0 ? '' : `rgba(${rgb.map(Math.round).join(',')},${(alpha / 255).toFixed(3)})|${mod ? 'm' : ''}`;
    if (css === this.last) return;
    this.last = css;
    this.el.hidden = !css;
    if (!css) return;
    const [color, m] = css.split('|');
    this.el.style.background = color;
    this.el.style.mixBlendMode = m ? 'multiply' : 'normal';
  }
}
