// End-of-run cards: "You died" and "Stage cleared" (and the end of an endless run). The game is paused behind
// them. Buttons are passed in, so the card knows nothing about game state.
import './overlay.css';
import { esc } from '../lib/dom.js';

// formatTime lives in lib/format.js; re-exported for ui/menu.js, which imports it from here
export { formatTime } from '../lib/format.js';

export class Overlay {
  constructor(root) {
    this.root = root;
    this.onKey = null;
    root.className = 'overlay hidden';
    document.addEventListener('keydown', (ev) => {
      if (this.root.classList.contains('hidden') || !this.onKey) return;
      this.onKey(ev);
    });
  }

  get open() { return !this.root.classList.contains('hidden'); }

  // card: { kind: 'dead'|'win'|'endless', title, subtitle, stats: [[label, value, highlight?]], record?: string,
  //         buttons: [{ label, key?, primary?, onClick }] }
  show(card) {
    const r = this.root;
    r.className = `overlay ${card.kind}`;
    r.innerHTML = `
      <div class="ov-card">
        <div class="ov-kicker">${esc(card.kicker || '')}</div>
        <h2>${esc(card.title)}</h2>
        ${card.subtitle ? `<div class="ov-sub">${esc(card.subtitle)}</div>` : ''}
        ${card.record ? `<div class="ov-record">${esc(card.record)}</div>` : ''}
        <dl class="ov-stats">${(card.stats || []).map(([k, v, hi]) => `<div class="${hi ? 'hi' : ''}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <div class="ov-buttons">${card.buttons.map((b, i) => `<button data-i="${i}" class="${b.primary ? 'primary' : 'ghost'}">${esc(b.label)}${b.key ? ` <kbd>${esc(b.key)}</kbd>` : ''}</button>`).join('')}</div>
      </div>`;
    r.querySelectorAll('button').forEach((el) => el.addEventListener('click', () => card.buttons[+el.dataset.i].onClick()));
    this.onKey = (ev) => {
      const b = card.buttons.find((x) => x.key && (x.key === ev.key || x.key.toLowerCase() === ev.key.toLowerCase() || (x.key === 'Enter' && ev.code === 'Enter')));
      if (b) { ev.preventDefault(); b.onClick(); }
    };
  }

  hide() {
    this.root.className = 'overlay hidden';
    this.root.innerHTML = '';
    this.onKey = null;
  }
}
