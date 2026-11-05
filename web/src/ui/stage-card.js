// A stage card and a grid of them: pure renderers (no game state read here), shared by the stage list
// (ui/stage-list.js) and the room screen's picker. A card: a 16:9 thumbnail (the stage's own spawn view,
// maps/<map>/stages/<id>.webp, web/src/dev/capture-stage-shots.js), the name, the scenario's one-line `summary`, one badge
// (Full run / Boss / Endless) and a personal best. The long technical `description` is only in the details panel:
// the (i) button, a right click, or a long press on touch. Scenario text goes in through textContent, never innerHTML.
// Styles: ui/stage-list.css, class-scoped (.sl-*), so a card looks the same in #menu and in a .sheet.
import { formatTime, plural } from '../lib/format.js';
import { getRecord } from '../app/records.js';
import { isMapName, isStageId, versioned } from '../lib/paths.js';

// el('div', 'cls', { title: 'x' }, 'text'): attributes are set as strings, text as textContent
export function el(tag, cls, attrs = {}, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = String(text);
  return e;
}

export const FREE_ROAM = { name: 'Free roam', summary: 'Walk the map with its logic idle', description: 'Walk the map with its logic idle. Spawns at the first CT spawn.' };

// the one badge a card carries: what kind of stage it is
export function badgeOf(s, index = 0) {
  if (index < 0) return null;
  if (s.full) return { cls: 'full', text: 'Full run' };
  if (s.bosses?.length) return { cls: 'boss', text: 'Boss' };
  if (s.endless) return { cls: 'endless', text: 'Endless' };
  return null;
}

// "Best 1:23.40 · ∞ 2:10.00" from the local records, or ''
export function personalBest(map, id) {
  const best = getRecord(map, id, 'normal');
  const bestE = getRecord(map, id, 'endless');
  return [best ? `Best ${formatTime(best.time)}` : '', bestE ? `∞ ${formatTime(bestE.time)}` : ''].filter(Boolean).join(' · ');
}

// (id) => the thumbnail URL for a map's stage, or null. mapInfo: the map's maps/index.json entry (tools/index-maps.mjs:
// stageShots lists the ids that have one, so only existing files are requested; the URL carries the manifest
// version and stageShotsVersion).
export function shotUrls(mapInfo) {
  const map = mapInfo?.name;
  if (!isMapName(map)) return () => null;
  const have = new Set((Array.isArray(mapInfo.stageShots) ? mapInfo.stageShots : []).filter(isStageId));
  const v = [mapInfo.version, mapInfo.stageShotsVersion].filter((x) => x != null && x !== '').join('.');
  return (id) => (have.has(id) ? versioned(`maps/${map}/stages/${id}.webp`, v || null) : null);
}

// A fixed 16:9 box with a neutral colour; the image fades in over it, so nothing moves while it loads.
function thumb(url, label) {
  const box = el('span', 'sl-thumb' + (url ? '' : ' empty'), { 'aria-hidden': 'true' });
  if (url) {
    const img = el('img', '', { src: url, alt: '', width: '320', height: '180', loading: 'lazy', decoding: 'async' });
    img.addEventListener('load', () => box.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => { img.remove(); box.classList.add('empty'); }, { once: true });
    box.append(img);
  } else if (label) {
    box.append(el('span', 'sl-thumb-label', {}, label));
  }
  return box;
}

// One card. scenario: a scenario object (FREE_ROAM for free roam, index -1). opts:
//   index    passed back to onPick (S.scenarios index; -1 = free roam)
//   onPick(index, mode)   mode 'normal' | 'endless'; called inside the click (G.play needs its user activation)
//   shotUrl  thumbnail URL or null (a placeholder box);  mini: no thumbnail (a boss's single attacks)
//   best     personal-best text ('' for none);  onDetails(index, scenario, fromEl): default = the details popover
//   drills   { count, open() }: a "N attacks" button (the boss's single attacks drawer)
export function stageCard(scenario, opts = {}) {
  const s = scenario;
  const index = opts.index ?? 0;
  const onPick = opts.onPick || (() => {});
  const onDetails = opts.onDetails || ((i, sc, from) => showDetails(i, sc, from, onPick, opts.best));
  const badge = badgeOf(s, index);
  const card = el('div', 'sl-card' + (opts.mini ? ' mini' : '') + (index < 0 ? ' free' : '') + (s.featured && !opts.mini ? ' featured' : '') + (badge ? ` is-${badge.cls}` : ''));
  const main = el('button', 'sl-main', { type: 'button' });
  if (!opts.mini) main.append(thumb(opts.shotUrl || null, index < 0 ? 'Explore' : null));
  const body = el('span', 'sl-body');
  body.append(el('span', 'sl-name', {}, s.name));
  if (s.summary) body.append(el('span', 'sl-sum', {}, s.summary));
  main.append(body);
  main.addEventListener('click', () => onPick(index, 'normal'));
  card.append(main);

  const foot = el('div', 'sl-foot');
  if (badge) foot.append(el('span', `sl-badge ${badge.cls}`, {}, badge.text));
  if (opts.best) foot.append(el('span', 'sl-pb', {}, opts.best));
  foot.append(el('span', 'sl-gap'));
  if (opts.drills) {
    const d = el('button', 'sl-tool drills', { type: 'button', 'aria-label': `${s.name}: ${plural(opts.drills.count, 'single attack')}` }, plural(opts.drills.count, 'attack'));
    d.addEventListener('click', () => opts.drills.open());
    foot.append(d);
  }
  if (s.endless) {
    const e = el('button', 'sl-tool endless', { type: 'button', title: 'Endless: keeps going until you die', 'aria-label': `${s.name}: endless` }, '∞');
    e.addEventListener('click', () => onPick(index, 'endless'));
    foot.append(e);
  }
  if (s.description) {
    const m = el('button', 'sl-tool info', { type: 'button', title: 'Details', 'aria-label': `${s.name}: details`, 'aria-haspopup': 'dialog' }, 'i');
    m.addEventListener('click', () => onDetails(index, s, m));
    foot.append(m);
    // a right click, or a long press on touch (it fires contextmenu), opens the details too
    card.addEventListener('contextmenu', (ev) => { ev.preventDefault(); onDetails(index, s, main); });
  }
  // the footer's empty space plays too, so the whole card reads as one target
  foot.addEventListener('click', (ev) => { if (ev.target === foot || ev.target.classList.contains('sl-gap')) main.click(); });
  card.append(foot);
  return card;
}

// A grid of cards. scenarios: [{ scenario, index? }] or plain scenarios (index = position). opts: { map (for the
// personal bests; omit for none), shotUrl(id) (shotUrls(mapInfo)), onPick, onDetails, mini }.
export function stageGrid(scenarios, opts = {}) {
  const grid = el('div', 'sl-grid' + (opts.mini ? ' mini' : ''));
  scenarios.forEach((item, k) => {
    const s = item?.scenario || item;
    const index = item?.scenario ? item.index ?? k : k;
    grid.append(stageCard(s, {
      index, onPick: opts.onPick, onDetails: opts.onDetails, mini: opts.mini,
      shotUrl: index >= 0 && opts.shotUrl ? opts.shotUrl(s.id) : null,
      best: index >= 0 && opts.map ? personalBest(opts.map, s.id) : '',
    }));
  });
  return grid;
}

// The details panel: one shared popover (light dismiss, Esc) with the full description and Play / Endless. It lives
// in the screen that opened it (#menu's panel or a .sheet), so that screen's button styles apply.
let panel = null;
let returnFocus = null;
export function showDetails(index, s, from, onPick, best = '') {
  if (!panel) {
    panel = el('div', 'sl-details', { popover: 'auto', role: 'dialog', 'aria-labelledby': 'sl-details-h' });
    panel.addEventListener('toggle', (ev) => { if (ev.newState === 'closed' && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
  }
  const host = from?.closest?.('.sheet, #menu .panel') || document.querySelector('#menu .panel') || document.body;
  if (panel.parentNode !== host) { hideDetails(); host.append(panel); }
  returnFocus = from;
  const badge = badgeOf(s, index);
  const head = el('div', 'sl-details-head');
  head.append(el('h3', '', { id: 'sl-details-h' }, s.name));
  if (badge) head.append(el('span', `sl-badge ${badge.cls}`, {}, badge.text));
  const close = el('button', 'sl-details-x', { type: 'button', 'aria-label': 'Close' }, '×');
  close.addEventListener('click', () => panel.hidePopover());
  head.append(close);
  const parts = [head];
  if (s.summary) parts.push(el('p', 'sl-details-sum', {}, s.summary));
  parts.push(el('p', 'sl-details-desc', {}, s.description || ''));
  if (best) parts.push(el('p', 'sl-pb', {}, best));
  const act = el('div', 'sl-details-act');
  const play = el('button', 'primary', { type: 'button' }, 'Play');
  play.addEventListener('click', () => { panel.hidePopover(); onPick(index, 'normal'); });
  act.append(play);
  if (s.endless) {
    const e = el('button', 'ghost', { type: 'button' }, '∞ Endless');
    e.addEventListener('click', () => { panel.hidePopover(); onPick(index, 'endless'); });
    act.append(e);
  }
  parts.push(act);
  panel.replaceChildren(...parts);
  if (!panel.matches(':popover-open')) panel.showPopover();
  play.focus({ preventScroll: true });
}

export function hideDetails() {
  if (panel?.isConnected && panel.matches(':popover-open')) panel.hidePopover();
}
