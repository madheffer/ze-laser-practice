// A map's leaderboard (ui/rankings.js's "map" view). Left: every map, searchable (a strip across the top on a
// phone). Right: the map's banner with Solo / Online, then two tabs:
//   Players  everyone ranked on the map: stages cleared (of the map's stages), records held (#1s), top 3 finishes
//            and ranked clears; the column headers sort it; you (or the profile you came from) are highlighted,
//            pinned under the list when further down
//   Stages   every stage in the stage list's order, with its record holder and time (and its endless record), and
//            how many are ranked on it; a row opens that stage's board
// Data: ui/board-data.js (server/api.js /api/maps/<map>/board). Text goes in as text only.
import { el, button, KIND, isMe, playerLink, place, segmented, tabs, skeleton, emptyState, mapArt, meter } from './rank-bits.js';
import { mapBoard, mapStages } from './board-data.js';
import { account } from '../app/account.js';
import { formatTime, plural, thousands } from '../lib/format.js';
import { displayName } from './maps.js';
import { mapShot } from './home-hero.js';
import { shotUrls } from './stage-card.js';

const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SORTS = [['cleared', 'Cleared'], ['records', 'Records'], ['wins', 'Wins']];
const KINDS = [['solo', KIND.solo], ['coop', KIND.coop]];

// "ze_mist_p" -> "Mist P": maps.js displayName, each word capitalised
export const mapTitle = (info, name) => displayName(info?.title || name).replace(/(^|\s)(\S)/g, (m, s, c) => s + c.toUpperCase());
// maps in the rail's order: by their shown title
export const byTitle = (a, b) => mapTitle(a, a.name).localeCompare(mapTitle(b, b.name));

export class MapBoardView {
  // args: { map, kind, tab, sort, highlight (a SteamID to point out) }
  constructor(body, args, nav) {
    this.nav = nav;
    this.alive = true;
    this.kind = args.kind === 'coop' ? 'coop' : 'solo';
    this.tab = args.tab === 'stages' ? 'stages' : 'players';
    this.sort = SORTS.some(([s]) => s === args.sort) ? args.sort : 'cleared';
    this.highlight = args.highlight || null;
    nav.title('Leaderboards');

    this.root = el('div', 'rk-mapview');
    this.rail = this.buildRail();
    this.main = el('div', 'rk-main');
    this.root.append(this.rail, this.main);
    body.append(this.root);
    this.setMap(args.map, false);
  }

  dispose() { this.alive = false; }

  buildRail() {
    const rail = el('nav', 'rk-rail');
    rail.setAttribute('aria-label', 'Maps');
    const maps = this.nav.maps().sort((a, b) => (b.scenarios > 0) - (a.scenarios > 0) || byTitle(a, b));
    this.mapButtons = new Map();
    if (maps.length > 6) {
      const search = el('input', 'rk-search');
      Object.assign(search, { type: 'search', placeholder: 'Find a map', autocomplete: 'off', spellcheck: false });
      search.setAttribute('aria-label', 'Find a map');
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        for (const [name, b] of this.mapButtons) b.hidden = !!q && !name.toLowerCase().includes(q) && !b.textContent.toLowerCase().includes(q);
      });
      rail.append(search);
    }
    const list = el('div', 'rk-rail-list');
    for (const m of maps) {
      const b = button('rk-rail-map', null, () => this.setMap(m.name, true));
      b.append(mapArt(mapShot(m), m.name, 'rk-rail-art'));
      const text = el('span', 'rk-rail-text');
      text.append(el('b', null, mapTitle(m, m.name)), el('small', null, m.scenarios ? plural(m.scenarios, 'stage') : 'No stages yet'));
      b.append(text);
      this.mapButtons.set(m.name, b);
      list.append(b);
    }
    rail.append(list);
    return rail;
  }

  setMap(map, user) {
    if (!map) { this.main.replaceChildren(emptyState('No maps on this server yet.')); return; }
    this.map = map;
    this.info = this.nav.mapInfo(map);
    for (const [name, b] of this.mapButtons) {
      if (name === map) { b.setAttribute('aria-current', 'true'); if (!user) b.scrollIntoView?.({ block: 'nearest', inline: 'center' }); } else b.removeAttribute('aria-current');
    }
    if (user) { this.highlight = null; this.nav.replace({ map, highlight: null }); }
    this.buildMain();
    this.load();
  }

  buildMain() {
    const info = this.info;
    const hero = el('header', 'rk-hero');
    hero.append(mapArt(mapShot(info), this.map, 'rk-hero-art'));
    const text = el('div', 'rk-hero-text');
    const h = el('h3', 'rk-hero-title', mapTitle(info, this.map));
    this.heroSub = el('p', 'rk-hero-sub', info?.scenarios ? plural(info.scenarios, 'stage') : '');
    text.append(el('span', 'rk-eyebrow', 'Map leaderboard'), h, this.heroSub);
    const side = el('div', 'rk-hero-side');
    side.append(segmented('Who played', KINDS, this.kind, (k) => { this.kind = k; this.nav.replace({ kind: k }); this.load(); }).root);
    if (info?.scenarios) side.append(button('rk-btn', 'Play this map', () => this.nav.play(this.map)));
    hero.append(text, side);

    this.tabs = tabs('Leaderboard', [['players', 'Players'], ['stages', 'Stages']], this.tab, (t) => { this.tab = t; this.nav.replace({ tab: t }); this.draw(); });
    this.panel = el('div', 'rk-tabpanel');
    this.panel.setAttribute('role', 'tabpanel');
    this.main.replaceChildren(hero, this.tabs.root, this.panel);
  }

  async load() {
    const map = this.map, kind = this.kind, sort = this.sort;
    this.data = null;
    this.panel.replaceChildren(skeleton(8));
    const player = this.highlight || account.user?.steamId || null;
    try {
      const [board, stages] = await Promise.all([mapBoard(map, { kind, sort, player }), mapStages(map)]);
      if (!this.alive || map !== this.map || kind !== this.kind || sort !== this.sort) return;
      this.data = { board, stages };
      const ranked = board.total;
      this.heroSub.textContent = [this.info?.scenarios ? plural(this.info.scenarios, 'stage') : '', `${thousands(ranked)} ranked ${ranked === 1 ? 'player' : 'players'}`].filter(Boolean).join(' · ');
      this.draw();
    } catch {
      if (!this.alive || map !== this.map) return;
      this.panel.replaceChildren(emptyState('Leaderboards need the server, and it isn’t reachable right now.', button('rk-btn', 'Try again', () => this.load())));
    }
  }

  draw() {
    if (!this.data) return;
    this.panel.replaceChildren(this.tab === 'stages' ? this.stagesPanel() : this.playersPanel());
  }

  // ---- Players
  playersPanel() {
    const { board } = this.data;
    const stagesOnMap = this.info?.scenarios || 0;
    if (!board.players.length) {
      return emptyState(`Nobody is ranked on this map ${this.kind === 'solo' ? 'solo' : 'online'} yet. Clear a stage signed in through Steam to be the first.`,
        this.info?.scenarios ? button('rk-btn primary', 'Play this map', () => this.nav.play(this.map)) : null);
    }
    const table = el('div', `rk-table rk-standings by-${this.sort}`); // by-*: which stat a phone keeps (rankings.css)
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Players on this map');
    const head = el('div', 'rk-tr rk-th');
    head.setAttribute('role', 'row');
    const cell = (cls, child) => { const c = el('span', `rk-td ${cls}`); c.setAttribute('role', 'columnheader'); if (child != null) c.append(child); return c; };
    head.append(cell('c-rank', '#'), cell('c-who', 'Player'));
    for (const [key, label] of SORTS) {
      const b = button(`rk-sort${this.sort === key ? ' on' : ''}`, label, () => this.setSort(key));
      b.title = `Rank by ${label.toLowerCase()}`;
      const c = cell(`c-${key}`, b);
      c.setAttribute('aria-sort', this.sort === key ? 'descending' : 'none');
      head.append(c);
      if (key === 'records') head.append(cell('c-podiums', 'Top 3'));
    }
    table.append(head);
    for (const p of board.players) table.append(this.standingRow(p, stagesOnMap));
    if (board.me) {
      table.append(el('div', 'rk-gap', '⋯'));
      table.append(this.standingRow(board.me, stagesOnMap));
    }
    // a phone has room for one stat column: the headers can't all show, so it gets a switch (rankings.css)
    const bar = el('div', 'rk-sortbar');
    bar.append('Rank by', segmented('Rank by', SORTS, this.sort, (k) => this.setSort(k)).root);
    const box = el('div');
    box.append(bar, table);
    if (board.total > board.players.length) box.append(el('p', 'rk-foot', `Top ${board.players.length} of ${thousands(board.total)} shown`));
    box.append(el('p', 'rk-foot', 'Cleared: stages with a ranked clear. Records: stage boards they hold #1 on (normal and endless). Wins: ranked clears.'));
    return box;
  }

  setSort(key) {
    if (this.sort === key) return;
    this.sort = key;
    this.nav.replace({ sort: key });
    this.load();
  }

  standingRow(p, stagesOnMap) {
    const row = el('div', 'rk-tr rk-row');
    row.setAttribute('role', 'row');
    if (isMe(p.steamId)) row.classList.add('me');
    if (this.highlight && p.steamId === this.highlight) row.classList.add('hl');
    const td = (cls, ...kids) => { const c = el('span', `rk-td ${cls}`); c.setAttribute('role', 'cell'); c.append(...kids); return c; };
    const cleared = el('span', 'rk-cleared');
    cleared.append(el('b', null, String(p.cleared)), stagesOnMap ? el('small', null, ` / ${stagesOnMap}`) : '');
    if (stagesOnMap) cleared.append(meter(p.cleared, stagesOnMap, `${p.cleared} of ${stagesOnMap} stages cleared`));
    row.append(
      td('c-rank', place(p.rank)),
      td('c-who', playerLink(p, (id) => this.nav.player(id))),
      td('c-cleared', cleared),
      td('c-records num', p.records ? String(p.records) : '–'),
      td('c-podiums num', p.podiums ? String(p.podiums) : '–'),
      td('c-wins num', thousands(p.wins)),
    );
    row.addEventListener('click', () => this.nav.player(p.steamId));
    return row;
  }

  // ---- Stages
  stagesPanel() {
    const { board, stages } = this.data;
    if (!stages.length) return emptyState('This map has no stages yet.');
    const thumbs = shotUrls(this.info);
    const box = el('div', 'rk-stages');
    for (const g of stages) {
      const sec = el('section', 'rk-group');
      const h = el('h4', 'rk-group-h');
      h.append(el('span', null, g.name), el('small', null, String(g.stages.length)));
      sec.append(h);
      const list = el('div', 'rk-stage-list');
      for (const s of g.stages) list.append(this.stageRow(s, board.stages, thumbs));
      sec.append(list);
      box.append(sec);
    }
    return box;
  }

  stageRow(s, records, thumbs) {
    const normal = records.get(`${s.id}\nnormal`), endless = records.get(`${s.id}\nendless`);
    // the row is a stretched link (its name's button covers it, rankings.css); the holders' names stay their own links
    const row = el('div', `rk-stage${s.part ? ' part' : ''}`);
    const open = () => this.nav.stage(this.map, s.id, { kind: this.kind, mode: normal || !endless ? 'normal' : 'endless', highlight: this.highlight });
    if (!s.part) {
      const url = thumbs(s.id);
      const art = el('span', `rk-stage-art${url ? '' : ' empty'}`);
      art.setAttribute('aria-hidden', 'true');
      if (url) {
        const img = el('img');
        img.src = url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
        img.addEventListener('error', () => { img.remove(); art.classList.add('empty'); }, { once: true });
        art.append(img);
      }
      row.append(art);
    }
    const name = el('span', 'rk-stage-name');
    const go = button('rk-stage-open', s.name, open);
    go.setAttribute('aria-label', `${s.name} leaderboard`);
    name.append(go);
    const count = Math.max(normal?.players || 0, endless?.players || 0);
    name.append(el('small', null, count ? `${thousands(count)} ranked` : 'No ranked clears yet'));
    row.append(name);
    const rec = el('span', 'rk-stage-rec');
    if (normal) rec.append(this.recordLine(normal, false));
    if (endless) rec.append(this.recordLine(endless, true));
    if (!normal && !endless) rec.append(el('span', 'rk-open', 'Open'));
    row.append(rec);
    const chev = el('span', 'rk-chev');
    chev.innerHTML = CHEVRON; // a constant
    row.append(chev);
    return row;
  }

  recordLine(r, endless) {
    const line = el('span', `rk-rec${endless ? ' endless' : ''}${isMe(r.top.steamId) ? ' mine' : ''}`);
    line.append(el('span', 'rk-rec-time', `${endless ? '∞ ' : ''}${formatTime(r.top.time)}`), playerLink(r.top, (id) => this.nav.player(id), 20));
    return line;
  }
}
