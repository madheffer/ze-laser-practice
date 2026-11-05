// A short message at the top of the screen that goes away by itself ("Your run on Deadcore was saved"). Text only
// (textContent), one at a time: a new one replaces the last.
//   toast(text, { ms = 4000, tone = 'ok' | 'warn' })
import './toast.css';

let el = null, timer = 0;

export function toast(text, { ms = 4000, tone = 'ok' } = {}) {
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.append(el);
  }
  el.textContent = String(text);
  el.dataset.tone = tone;
  el.classList.add('on');
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('on'), ms);
}
