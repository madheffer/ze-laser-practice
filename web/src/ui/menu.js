// The menu, which doubles as the pause screen: a top bar (title, Play | Settings tabs, Maps / current map,
// Resume / Restart), the Play tab's two views (the map picker, ui/maps.js; then the picked map's stages, one
// section per part of the map with a jump bar, a boss's single attacks folded under it, endless and personal
// bests on each card) and the settings (index.html; app/settings.js binds them by id).
import './menu.css';
import { S, G } from '../app/state.js';
import { $, esc } from '../lib/dom.js';
import { formatTime } from '../lib/format.js';
import { getRecord } from '../app/records.js';
import { syncPlayState } from '../app/input.js';
import { displayName } from './maps.js';
import { settings, saveSettings } from '../app/settings.js';

const LONG_DESC = 110; // characters: past this a card gets a "more" toggle (and the full text as its tooltip)

// Build an element: el('div', 'cls', { title: 'x' }). Text goes in via textContent / esc, never raw.
function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export class Menu {
  constructor({ onPick, onResume, onRestart, onMaps }) {
    this.onPick = onPick;
    this.view = 'maps';
    $('#resume').addEventListener('click', () => onResume());
    $('#restart').addEventListener('click', () => onRestart());
    $('#maps-back').addEventListener('click', () => onMaps());
    this.selectTab = installTabs($('#menu .tabs'));
  }

  // The Play tab's view: 'maps' (the picker) or 'stages' (the loaded map's parts). Picking a view also brings
  // the Play tab forward.
  show(view) {
    this.view = view;
    $('#maps').hidden = view !== 'maps';
    $('#stages').hidden = view !== 'stages';
    $('#maps-back').hidden = view !== 'stages';
    $('#map-name').textContent = view === 'stages' && S.map ? S.map.name : '';
    this.selectTab($('#tab-play'));
    $('#menu .tab-panels').scrollTop = 0;
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

  // The loaded map's stages: a header (title, what the map is, a jump bar of its parts), then one section per
  // part (a scenario's group, in file order), free roam last.
  build(info = {}) {
    const list = $('#scenarios');
    list.replaceChildren();
    const byParent = new Map();
    S.scenarios.forEach((s, i) => {
      const p = s.parent || '';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(i);
    });
    const parts = [];
    for (const i of byParent.get('') || []) {
      const g = String(S.scenarios[i].group || 'Stages');
      let p = parts.find((x) => x.name === g);
      if (!p) parts.push((p = { name: g, items: [] }));
      p.items.push(i);
    }
    parts.push({ name: 'Explore', items: [-1] });

    const head = $('#map-head');
    head.replaceChildren();
    const title = el('h2', 'map-title');
    title.textContent = displayName(info.title || S.map.name);
    const sub = el('p', 'map-sub');
    sub.textContent = info.description || S.map.name;
    const nav = el('nav', 'part-nav', { 'aria-label': 'Parts of the map' });
    head.append(title, sub, nav);
    const heal = healToggle();
    if (heal) head.append(heal);

    parts.forEach((p, n) => {
      const id = `part-${n}`;
      const sec = el('section', 'part-sec', { id, 'aria-labelledby': id + '-h' });
      const h = el('h3', 'part-h', { id: id + '-h' });
      const count = p.items.reduce((k, i) => k + 1 + (i >= 0 ? (byParent.get(S.scenarios[i].id) || []).length : 0), 0);
      h.innerHTML = `${esc(p.name)}<small>${count}</small>`;
      const grid = el('div', 'part-grid');
      for (const i of p.items) {
        const kids = i >= 0 ? byParent.get(S.scenarios[i].id) || [] : [];
        grid.append(kids.length ? this.family(i, kids) : this.card(i));
      }
      sec.append(h, grid);
      list.append(sec);
      const jump = el('button', 'part-jump', { type: 'button' });
      jump.textContent = p.name;
      jump.addEventListener('click', () => sec.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      nav.append(jump);
    });
    if (parts.length <= 2) nav.hidden = true; // one part + free roam: nothing to jump between
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
    main.innerHTML = `<b>${esc(s.name)}${tags.length ? `<span class="tags">${tags.map((t) => `<i>${esc(t)}</i>`).join('')}</span>` : ''}</b>`
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

// The map's heal option: only on a map that has a heal item (world/items.js: EntWatch / the map's data), named after it.
// You hold it from the stage start and E uses it; the map's own logic decides where it works (mist: not in the escape).
function healToggle() {
  const heals = (S.map?.items || []).filter((it) => it.heal);
  if (!heals.length) return null;
  const it = heals[0];
  const label = el('label', 'heal-toggle');
  const box = el('input', '', { type: 'checkbox' });
  box.checked = !!settings.healItem;
  box.addEventListener('change', () => { settings.healItem = box.checked; saveSettings(); });
  const text = el('span');
  text.innerHTML = `Hold the heal: <b>${esc(it.name)}</b> <kbd class="kb">E</kbd>`
    + `<small>${it.cooldown ? `${esc(it.cooldown)} s cooldown · ` : ''}works where the map allows it (bosses, finales)</small>`;
  label.append(box, text);
  return label;
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
  return (tab) => select(tab, false);
}
