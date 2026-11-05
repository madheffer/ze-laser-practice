// The sliders' filled track (ui/controls.css reads --p): kept in step on every input anywhere, and on demand after
// values are set from code (settings load, a form render).
import './controls.css';

export function fillSlider(el) {
  const min = Number(el.min || 0), max = Number(el.max || 100), v = Number(el.value);
  el.style.setProperty('--p', `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`);
}

export function fillSliders(root = document) {
  for (const el of root.querySelectorAll('input[type=range]')) fillSlider(el);
}

document.addEventListener('input', (ev) => { if (ev.target instanceof HTMLInputElement && ev.target.type === 'range') fillSlider(ev.target); }, true);
// a number box next to a slider (settings.js bindPair) moves the slider from code: refresh on change too
document.addEventListener('change', () => fillSliders(), true);
