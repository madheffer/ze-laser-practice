// The kill feed, CS2's top-right list: one row per death in a co-op / versus round ("<cause> ☠ <victim>"),
// plus notices (left the game, last one alive). Rows about you get CS2's red outline; each fades after a few
// seconds. Everything shown is a player name or a hazard name: text only, never HTML.
import './killfeed.css';

const SHOW_MS = 7000;
const MAX_ROWS = 6;
const SKULL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1C4.1 1 1.5 3.6 1.5 7c0 2 .9 3.6 2.5 4.5V14h2v-1.5h1V14h2v-1.5h1V14h2v-2.5c1.6-.9 2.5-2.5 2.5-4.5C14.5 3.6 11.9 1 8 1zM5.3 9.6a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2zm5.4 0a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2z"/></svg>';

export class Killfeed {
  constructor(root) {
    this.root = root;
    root.className = 'killfeed';
    root.setAttribute('aria-live', 'polite');
  }

  // { victim, cause?, self?, note? }: a death row, or a notice row when `note` is set
  push({ victim, cause, self = false, note }) {
    const row = document.createElement('div');
    row.className = 'kf-row' + (self ? ' self' : '') + (note ? ' note' : '');
    if (note) {
      const n = document.createElement('span');
      n.className = 'kf-note';
      n.textContent = note;
      row.append(n);
    } else {
      if (cause) {
        const c = document.createElement('span');
        c.className = 'kf-cause';
        c.textContent = cause;
        row.append(c);
      }
      const icon = document.createElement('i');
      icon.className = 'kf-skull';
      icon.innerHTML = SKULL; // a constant
      const v = document.createElement('span');
      v.className = 'kf-victim';
      v.textContent = victim;
      row.append(icon, v);
    }
    this.root.prepend(row);
    while (this.root.childElementCount > MAX_ROWS) this.root.lastElementChild.remove();
    setTimeout(() => { row.classList.add('out'); setTimeout(() => row.remove(), 400); }, SHOW_MS);
  }

  clear() { this.root.replaceChildren(); }
}
