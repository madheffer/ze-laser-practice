// DOM helpers. Anything from a map, a scenario, the URL or localStorage goes through esc() before it reaches
// innerHTML (or use textContent).

export const $ = (s) => document.querySelector(s);

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

// Restart a CSS animation class (the hit flash, HUD jitter): remove, force a reflow, add again.
export function replayClass(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
