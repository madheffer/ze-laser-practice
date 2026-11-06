// The picked map's stages (the Play tab's second view, ui/menu.js): a header (the map's title and line, a row of
// part chips that filter the list, the heal option), then one section per part (a scenario's group, ordered by
// lib/stage-groups.js: Main stages, the ending, special modes, Mini bosses; free roam last), each a grid of compact cards (ui/stage-card.js): about five a row on a desktop, two on a
// phone. A boss's single attacks fold into a drawer under its part's grid. Arrow keys move between cards.
import './stage-list.css';
import { S, G } from '../app/state.js';
import { $ } from '../lib/dom.js';
import { groupStages } from '../lib/stage-groups.js';
import { settings, saveSettings } from '../app/settings.js';
import { displayName } from './maps.js';
import { mapLoadout } from '../world/items.js';
import { el, stageCard, shotUrls, personalBest, showDetails, hideDetails, FREE_ROAM } from './stage-card.js';

// the card renderers, for other screens (the room picker): pure functions, styled by stage-list.css
export { stageCard, stageGrid, shotUrls, personalBest, FREE_ROAM } from './stage-card.js';

// the part a map's list was filtered to, per map, for this page load only (never saved)
const lastPart = new Map();

// info: { title, description } of the map; onPick(i, mode) starts a stage (i = -1: free roam)
export function renderStageList(info, onPick) {
  hideDetails();
  const list = $('#scenarios');
  const head = $('#map-head');
  const byParent = new Map();
  S.scenarios.forEach((s, i) => {
    const p = s.parent || '';
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(i);
  });
  const parts = groupStages(S.scenarios);
  parts.push({ name: 'Explore', items: [-1] });

  const map = S.map.name;
  const thumbUrl = shotUrls(S.mapIndex?.find((m) => m.name === map));
  const best = (i, s) => (i >= 0 ? personalBest(map, s.id) : '');
  const details = (i, s, from) => showDetails(i, s, from, onPick, best(i, s));
  const sections = parts.map((p, n) => section(p, n, { byParent, thumbUrl, best, onPick, details }));
  list.replaceChildren(...sections);
  list.classList.add('sl');

  const title = el('h2', 'map-title', {}, displayName(info.title || S.map.name));
  const sub = el('p', 'map-sub', {}, info.description || S.map.name);
  // this map's leaderboard (ui/rankings.js), beside its title
  const boards = el('button', 'sl-boards', { type: 'button', title: 'Who holds the records on this map' }, 'Leaderboard');
  boards.addEventListener('click', () => G.rankings?.showMap(map));
  const row = el('div', 'map-title-row');
  row.append(title, boards);
  head.replaceChildren(row, sub);
  if (parts.length > 2) head.append(chips(parts, sections));
  head.append(...itemOptions());
  installGridKeys(list);
}

function section(p, n, ctx) {
  const id = `part-${n}`;
  const sec = el('section', 'sl-sec', { id, 'aria-labelledby': id + '-h' });
  const count = p.items.reduce((k, i) => k + 1 + (i >= 0 ? (ctx.byParent.get(S.scenarios[i].id) || []).length : 0), 0);
  const h = el('h3', 'sl-h', { id: id + '-h' });
  h.append(el('span', '', {}, p.name), el('small', '', {}, String(count)));
  const grid = el('div', 'sl-grid');
  const drawers = [];
  for (const i of p.items) {
    const s = i >= 0 ? S.scenarios[i] : FREE_ROAM;
    const kids = i >= 0 ? ctx.byParent.get(s.id) || [] : [];
    const drawer = kids.length ? drills(s, kids, ctx) : null;
    if (drawer) drawers.push(drawer);
    grid.append(stageCard(s, {
      index: i, shotUrl: i >= 0 ? ctx.thumbUrl(s.id) : null, best: ctx.best(i, s), onPick: ctx.onPick, onDetails: ctx.details,
      drills: drawer && { count: kids.length, open: () => openDrawer(drawer) },
    }));
  }
  sec.append(h, grid, ...drawers);
  return sec;
}

// A boss's single attacks: a native <details> (keyboard and screen-reader friendly) with a denser grid of cards.
function drills(s, kids, ctx) {
  const box = el('details', 'sl-drills');
  const sum = el('summary');
  sum.append(el('span', '', {}, `${s.name}: ${s.childrenTitle || 'single attacks'}`), el('span', 'count', {}, String(kids.length)));
  const grid = el('div', 'sl-grid mini');
  for (const k of kids) grid.append(stageCard(S.scenarios[k], { index: k, mini: true, best: ctx.best(k, S.scenarios[k]), onPick: ctx.onPick, onDetails: ctx.details }));
  box.append(sum, grid);
  return box;
}

function openDrawer(d) {
  d.open = true;
  d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  d.querySelector('summary').focus({ preventScroll: true });
}

// The part chips: All, then each part. A chip shows only that part (and scrolls back to the top of the list).
function chips(parts, sections) {
  const nav = el('div', 'sl-chips', { role: 'toolbar', 'aria-label': 'Show a part of the map' });
  const all = [{ name: 'All', n: -1 }, ...parts.map((p, n) => ({ name: p.name, n }))];
  const buttons = all.map((c) => {
    const b = el('button', 'sl-chip', { type: 'button', 'aria-pressed': 'false' }, c.name);
    b.addEventListener('click', () => select(c.n));
    return b;
  });
  const select = (n) => {
    lastPart.set(S.map.name, n);
    all.forEach((c, k) => buttons[k].setAttribute('aria-pressed', String(c.n === n)));
    sections.forEach((sec, k) => { sec.hidden = n >= 0 && k !== n; });
    $('#menu .tab-panels').scrollTo({ top: 0 });
  };
  const keep = lastPart.get(S.map.name);
  select(keep != null && keep < parts.length ? keep : -1);
  nav.append(...buttons);
  return nav;
}

// Arrow keys between cards, by what is on screen: left / right the previous / next card, up / down the nearest
// card in the row above / below. Tab still walks every control in order.
function installGridKeys(list) {
  if (list.dataset.keys) return;
  list.dataset.keys = '1';
  list.addEventListener('keydown', (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key) || !ev.target.classList.contains('sl-main')) return;
    const cards = [...list.querySelectorAll('.sl-main')].filter((b) => b.offsetParent && !b.closest('details:not([open])'));
    const at = cards.indexOf(ev.target);
    if (at < 0) return;
    let to = null;
    if (ev.key === 'ArrowLeft') to = cards[at - 1];
    else if (ev.key === 'ArrowRight') to = cards[at + 1];
    else {
      const r = ev.target.getBoundingClientRect();
      const down = ev.key === 'ArrowDown';
      let best = Infinity;
      for (const c of cards) {
        const q = c.getBoundingClientRect();
        const dy = down ? q.top - r.bottom : r.top - q.bottom;
        if (dy < -1) continue;
        const d = dy * 4 + Math.abs(q.left - r.left);
        if (d < best) { best = d; to = c; }
      }
    }
    if (!to) return;
    ev.preventDefault();
    to.focus();
    to.scrollIntoView({ block: 'nearest' });
  });
}

// The map's item options, on a map that has them (world/items.js mapLoadout: EntWatch / the map's data), named after
// the item. You hold ONE item at most: the heal, or the ultima (E sets it off). Or a teammate holds the ultima and sets
// it off a set time into the stage, so you practise the lasers through its blast. The map's own logic does the rest.
function itemOptions() {
  const { heal, ultima } = mapLoadout(S.map?.items);
  const out = [];
  let healBox = null, ultSel = null;
  if (heal) {
    const label = el('label', 'heal-toggle');
    healBox = el('input', '', { type: 'checkbox' });
    healBox.checked = !!settings.healItem && settings.ultimaItem !== 'hold';
    healBox.addEventListener('change', () => {
      settings.healItem = healBox.checked;
      if (healBox.checked && settings.ultimaItem === 'hold') { settings.ultimaItem = 'none'; if (ultSel) ultSel.sync(); }
      saveSettings();
    });
    const text = el('span');
    text.append('Hold the heal: ', el('b', '', {}, heal.name), ' ', el('kbd', 'kb', {}, 'E'));
    text.append(el('small', '', {}, `${heal.cooldown ? `${heal.cooldown} s cooldown · ` : ''}works where the map allows it (bosses, finales)`));
    label.append(healBox, text);
    out.push(label);
  }
  if (ultima) {
    const box = el('div', 'heal-toggle ultima-pick');
    const sel = el('select', '', { 'aria-label': `${ultima.name}: who sets it off` });
    for (const [v, t] of [['none', 'Off'], ['hold', 'You hold it (E)'], ['auto', 'Teammate sets it off']]) sel.append(el('option', '', { value: v }, t));
    const at = el('input', '', { type: 'number', min: '0', max: '300', step: '1', 'aria-label': 'Seconds after the stage starts' });
    const atWrap = el('span', 'ultima-at');
    atWrap.append(at, ' s in');
    const text = el('span');
    text.append('Ultima: ', el('b', '', {}, ultima.name), ' ', sel, ' ', atWrap);
    text.append(el('small', '', {}, `${ultima.ultima} s countdown, then a blast that fills the screen · 0 s = at the start, before the lasers`));
    box.append(text);
    const sync = () => { sel.value = settings.ultimaItem; at.value = String(settings.ultimaAt); atWrap.hidden = settings.ultimaItem !== 'auto'; };
    sel.addEventListener('change', () => {
      settings.ultimaItem = sel.value;
      // one item: holding the ultima puts the heal down
      if (sel.value === 'hold' && healBox?.checked) { healBox.checked = false; settings.healItem = false; }
      saveSettings(); sync();
    });
    at.addEventListener('change', () => { const v = Math.round(Number(at.value)); settings.ultimaAt = Number.isFinite(v) ? Math.min(300, Math.max(0, v)) : 0; saveSettings(); sync(); });
    ultSel = { sync };
    sync();
    out.push(box);
  }
  return out;
}
