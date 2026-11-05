// The menu, which doubles as the pause screen: a top bar (title, Play | Settings tabs, map, Resume / Restart),
// the stage picker (a card grid: the featured stage on top, a boss's single attacks folded under it, endless and
// personal bests on each card) and the settings (index.html; app/settings.js binds them by id).
import './menu.css';
import { S, G } from '../app/state.js';
import { $, esc } from '../lib/dom.js';
import { formatTime } from '../lib/format.js';
import { getRecord } from '../app/records.js';
import { syncPlayState } from '../app/input.js';

const LONG_DESC = 110; // characters: past this a card gets a "more" toggle (and the full text as its tooltip)

// Build an element: el('div', 'cls', { title: 'x' }). Text goes in via textContent / esc, never raw.
function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export class Menu {
  constructor({ onPick, onResume, onRestart }) {
    this.onPick = onPick;
    $('#resume').addEventListener('click', () => onResume());
    $('#restart').addEventListener('click', () => onRestart());
    installTabs($('#menu .tabs'));
  }

  // Show the menu when paused (and no end card is up); Resume only when there is a run to go back to. This runs
  // on every pause / unpause, so the touch controls follow it too (syncPlayState).
  update() {
    const live = !!S.run && !S.run.done;
    $('#resume').hidden = !live;
    $('#restart').hidden = !S.run;
    const show = S.paused && !G.overlay?.open;
    const menu = $('#menu');
    const opening = show && menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !show);
    $('#hud').classList.toggle('hidden', !S.run);
    syncPlayState();
    if (opening && live) $('#resume').focus({ preventScroll: true });
  }

  build() {
    const list = $('#scenarios');
    list.replaceChildren();
    const byParent = new Map();
    S.scenarios.forEach((s, i) => {
      const p = s.parent || '';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(i);
    });
    // one flowing grid: the group shows as each card's kicker, so single-card groups don't leave empty rows
    for (const i of byParent.get('') || []) {
      const kids = byParent.get(S.scenarios[i].id) || [];
      list.append(kids.length ? this.family(i, kids) : this.card(i));
    }
    list.append(this.card(-1));
  }

  // A boss and its single attacks, folded (a native <details>, so it is keyboard and screen-reader friendly).
  // Opened, the family takes the grid's full width (menu.css).
  family(i, kids) {
    const s = S.scenarios[i];
    const box = el('div', 'family');
    const fold = el('details', 'attacks');
    const sum = el('summary');
    const label = el('span');
    label.textContent = s.childrenTitle || 'Single attacks';
    const count = el('span', 'count');
    count.textContent = String(kids.length);
    sum.append(label, count);
    const grid = el('div', 'attack-grid');
    for (const k of kids) grid.append(this.card(k, true));
    fold.append(sum, grid);
    box.append(this.card(i), fold);
    return box;
  }

  // One stage card. i = -1 is free roam. The main button starts the stage: its click handler stays synchronous
  // (G.play asks for pointer lock + fullscreen inside the click's user activation).
  card(i, child = false) {
    const s = i >= 0 ? S.scenarios[i] : { name: 'Free roam', group: 'Explore', description: 'Walk the map with its logic idle. Spawns at the first CT spawn.' };
    const kind = i < 0 ? ' free' : (s.featured && !child ? ' featured' : '') + (s.full ? ' full' : '') + (child ? ' child' : '');
    const card = el('div', 'stage' + kind);
    const main = el('button', 'stage-main', { type: 'button' });
    const desc = String(s.description || '');
    if (desc) main.title = desc;
    const tags = i < 0 ? [] : [s.featured && 'popular', s.bosses?.length && 'boss', s.full && 'full run'].filter(Boolean);
    const pb = i < 0 ? '' : personalBest(s.id);
    const kicker = !child && s.group ? `<span class="stage-kicker">${esc(s.group)}</span>` : '';
    main.innerHTML = kicker + `<b>${esc(s.name)}${tags.length ? `<span class="tags">${tags.map((t) => `<i>${esc(t)}</i>`).join('')}</span>` : ''}</b>`
      + (desc ? `<span class="stage-desc">${esc(desc)}</span>` : '')
      + (pb ? `<span class="stage-pb">${esc(pb)}</span>` : '');
    main.addEventListener('click', () => this.onPick(i, 'normal'));
    card.append(main);

    const rail = el('div', 'stage-rail');
    if (s.endless) {
      const e = el('button', 'endless', { type: 'button', title: 'Endless: keeps going until you die, for your longest survival', 'aria-label': `${s.name}: endless` });
      e.textContent = '∞';
      e.addEventListener('click', () => this.onPick(i, 'endless'));
      rail.append(e);
    }
    if (desc.length > LONG_DESC) {
      const m = el('button', 'more', { type: 'button', 'aria-expanded': 'false', 'aria-label': `${s.name}: full description` });
      m.textContent = '•••';
      m.addEventListener('click', () => m.setAttribute('aria-expanded', String(card.classList.toggle('open'))));
      rail.append(m);
    }
    if (rail.childElementCount) card.append(rail);
    return card;
  }
}

function personalBest(id) {
  const best = getRecord(S.map.name, id, 'normal');
  const bestE = getRecord(S.map.name, id, 'endless');
  return [best ? `best ${formatTime(best.time)}` : '', bestE ? `endless ${formatTime(bestE.time)}` : ''].filter(Boolean).join(' · ');
}

// WAI-ARIA tabs: click, or arrow keys / Home / End, select a tab and show its panel.
function installTabs(list) {
  const tabs = [...list.querySelectorAll('[role=tab]')];
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  };
  for (const t of tabs) t.addEventListener('click', () => select(t, false));
  list.addEventListener('keydown', (ev) => {
    const at = tabs.indexOf(document.activeElement);
    if (at < 0) return;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    select(tabs[(to + tabs.length) % tabs.length], true);
  });
}
