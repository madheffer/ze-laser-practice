// The item HUD under the minimap, as GFL's EntWatch draws it: one line per held map item,
//   <state> <short name> <holder>     state: R ready, seconds left on the cooldown, x/y uses left, E used up
// in the item's EntWatch colour. Your own item, the team's ultima when it goes off by itself, plus in a room everyone
// else's (S.mp.itemRows(): who holds the heal, the ultima).
import { S } from '../app/state.js';
import { esc } from '../lib/dom.js';
import { itemState } from '../world/items.js';

// EntWatch / CS2 chat colour names (CS2Fixes) -> CSS
const COLORS = {
  white: '#ffffff', red: '#ff4040', lightred: '#ff7070', darkred: '#b31010', bluegrey: '#b0c2d8', blue: '#5b8cff',
  darkblue: '#3a5fd0', purple: '#b06cff', orchid: '#e070e0', yellow: '#ffe14d', gold: '#e8b94a', lightgreen: '#9cff8a',
  green: '#4cd964', lime: '#a8ff3a', grey: '#a0a0a0', gray: '#a0a0a0', grey2: '#c8c8c8', olive: '#b5c94f', orange: '#ff9a3c',
  pink: '#ff8ad0', cyan: '#5ce1e6',
};
const colorOf = (name) => COLORS[String(name || '').toLowerCase()] || '#ffffff';

export class ItemHud {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'hud-items';
    root.append(this.el);
    this.last = '';
  }

  update() {
    const { run, engine } = S;
    const rows = [];
    if (run && engine) {
      const me = S.mp?.myName?.() || 'You';
      for (const it of run.items || []) rows.push({ state: itemState(it, engine.time), short: it.shortname, color: it.color, holder: me });
      // the team's ultima going off by itself (nobody's: world/items.js giveMates autoAt)
      for (const m of run.mates || []) if (m.autoAt != null) for (const it of m.items) rows.push({ state: itemState(it, engine.time), short: it.shortname, color: it.color, holder: 'Team' });
      for (const r of S.mp?.itemRows?.() || []) rows.push(r);
    }
    const html = rows.map((r) => `<div class="it-row"><span class="it-state">${esc(r.state)}</span><b style="color:${colorOf(r.color)}">${esc(r.short)}</b><span class="it-holder">${esc(r.holder)}</span></div>`).join('');
    if (html !== this.last) { this.el.innerHTML = html; this.last = html; }
    this.el.hidden = !rows.length;
  }
}
