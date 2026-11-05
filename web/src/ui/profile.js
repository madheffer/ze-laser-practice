// A player's public profile (ui/rankings.js's "player" view; GET /api/players/<SteamID64>, server/players-http.js):
// their Steam name and avatar, since when they play here, then their numbers (wins, stages cleared, records held,
// top 3 finishes, runs) and two tabs:
//   Maps    one card per map they played, most wins first: wins, stages cleared of the map's stages, records and
//           best placing; open one for its stages, each with their best time and where it places them (#2 of 14),
//           a stage opening its board with them highlighted, and the map's whole leaderboard
//   Recent  their latest listed runs, with Watch when the replay is public
// Opened from your account on the home page, a name on a board or in the live feed, or ?player=<SteamID64>.
// Everything came from the server and is cleaned in ui/board-data.js; it reaches the DOM only as text.
import { el, button, KIND, isMe, avatar, place, tabs, skeleton, emptyState, mapArt, meter, shortDate } from './rank-bits.js';
import { profile } from './board-data.js';
import { formatTime, plural, thousands, ago } from '../lib/format.js';
import { mapShot } from './home-hero.js';
import { mapTitle } from './board.js';
import { playButton, viewsBadge } from './replay-buttons.js';
import { RESULT } from './home-history.js';

const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4.5L12 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class ProfileView {
  // args: { steamId, tab }
  constructor(body, args, nav) {
    this.nav = nav;
    this.alive = true;
    this.steamId = args.steamId;
    this.tab = args.tab === 'recent' ? 'recent' : 'maps';
    this.openMaps = new Set(args.openMaps || []);
    this.root = el('div', 'rk-profile');
    body.append(this.root);
    nav.title('Profile');
    this.load();
  }

  dispose() { this.alive = false; }

  async load() {
    this.root.replaceChildren(this.headSkeleton(), skeleton(5));
    let p = null, msg = 'This player isn’t here.';
    try { p = await profile(this.steamId); } catch (e) { if (!/: 404$/.test(e.message)) msg = 'Profiles need the server, and it isn’t reachable right now.'; }
    if (!this.alive) return;
    if (!p) { this.root.replaceChildren(emptyState(msg, button('rk-btn', 'Try again', () => this.load()))); return; }
    this.p = p;
    this.nav.title(isMe(this.steamId) ? 'Your profile' : p.player.name);
    if (!this.openMaps.size && p.maps[0]) this.openMaps.add(p.maps[0].map);
    this.tabs = tabs('Profile', [['maps', 'Maps', p.maps.length], ['recent', 'Recent runs', p.recent.length]], this.tab, (t) => { this.tab = t; this.nav.replace({ tab: t }); this.draw(); });
    this.panel = el('div', 'rk-tabpanel');
    this.panel.setAttribute('role', 'tabpanel');
    this.root.replaceChildren(this.head(p.player), this.numbers(p.totals), this.tabs.root, this.panel);
    this.draw();
  }

  headSkeleton() {
    const h = el('header', 'rk-phead loading');
    h.append(el('span', 'rk-av rk-skel-av'), el('div', 'rk-skel-lines'));
    return h;
  }

  head(player) {
    const head = el('header', 'rk-phead');
    head.append(avatar(player.avatar, player.name, 88));
    const who = el('div', 'rk-pwho');
    const h = el('h3', 'rk-pname-big', player.name);
    if (isMe(player.steamId)) h.append(el('span', 'rk-you', 'You'));
    const since = player.since ? `Playing since ${new Date(player.since).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : 'Steam player';
    const acts = el('div', 'rk-pacts');
    const copy = button('rk-btn small', 'Copy link', () => {
      navigator.clipboard?.writeText(`${location.origin}/?player=${player.steamId}`)
        .then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy link'; }, 1400); }, () => {});
    });
    const steam = el('a', 'rk-btn small ghost', 'Steam profile');
    steam.href = `https://steamcommunity.com/profiles/${player.steamId}`; // a checked SteamID64 (ui/board-data.js)
    steam.target = '_blank';
    steam.rel = 'noopener noreferrer';
    acts.append(copy, steam);
    who.append(h, el('p', 'rk-since', since), acts);
    head.append(who);
    return head;
  }

  numbers(t) {
    const box = el('dl', 'rk-tiles');
    const split = [['solo', KIND.solo], ['coop', KIND.coop], ['versus', KIND.versus]].filter(([k]) => t[k]).map(([k, w]) => `${thousands(t[k])} ${w.toLowerCase()}`).join(' · ');
    for (const [n, label, sub, cls] of [
      [t.wins, t.wins === 1 ? 'Win' : 'Wins', 'stage clears', 'win'],
      [t.cleared, 'Stages cleared', 'ranked, all maps'],
      [t.records, t.records === 1 ? 'Record' : 'Records', 'boards held at #1', 'gold'],
      [t.podiums, 'Top 3', 'board finishes'],
      [t.runs, t.runs === 1 ? 'Run' : 'Runs', split || 'finished'],
    ]) {
      const d = el('div', `rk-tile${cls ? ` ${cls}` : ''}`);
      d.append(el('dt', null, label), el('dd', null, thousands(n)), el('span', 'rk-tile-sub', sub));
      box.append(d);
    }
    return box;
  }

  draw() {
    this.panel.replaceChildren(this.tab === 'recent' ? this.recentList(this.p.recent) : this.mapList(this.p));
  }

  // ---- Maps
  mapList(p) {
    if (!p.maps.length) return emptyState(isMe(this.steamId) ? 'No runs yet. Clear a stage and your maps show up here.' : 'No shared runs yet.');
    const best = new Map(); // map -> its best rows
    for (const b of p.best) { if (!best.has(b.map)) best.set(b.map, []); best.get(b.map).push(b); }
    const list = el('div', 'rk-pmaps');
    for (const m of p.maps) list.append(this.mapCard(m, best.get(m.map) || []));
    return list;
  }

  mapCard(m, rows) {
    const info = this.nav.mapInfo(m.map);
    const stages = info?.scenarios || 0;
    const card = el('section', 'rk-pmap');
    const id = `rk-pm-${m.map}`;
    const head = button('rk-pmap-head', null, () => toggle());
    head.setAttribute('aria-controls', id);
    head.append(mapArt(mapShot(info), m.map, 'rk-pmap-art'));
    const title = el('span', 'rk-pmap-title');
    title.append(el('b', null, mapTitle(info, m.map)));
    const cleared = el('span', 'rk-pmap-cleared');
    cleared.append(`${m.cleared}${stages ? ` / ${stages}` : ''} stages cleared`);
    if (stages) cleared.append(meter(m.cleared, stages, `${m.cleared} of ${stages} stages cleared`));
    title.append(cleared);
    const stats = el('span', 'rk-pmap-stats');
    const stat = (n, label, cls = '') => { const s = el('span', `rk-stat ${cls}`); s.append(el('b', null, n), el('small', null, label)); return s; };
    stats.append(stat(thousands(m.wins), m.wins === 1 ? 'win' : 'wins', 'win'));
    stats.append(stat(m.records ? String(m.records) : '–', m.records === 1 ? 'record' : 'records', m.records ? 'gold' : ''));
    stats.append(stat(m.bestPlace ? `#${m.bestPlace}` : '–', 'best'));
    const chev = el('span', 'rk-chev down');
    chev.innerHTML = CHEVRON; // a constant
    head.append(title, stats, chev);

    const body = el('div', 'rk-pmap-body');
    body.id = id;
    const toggle = (open = !this.openMaps.has(m.map)) => {
      if (open) this.openMaps.add(m.map); else this.openMaps.delete(m.map);
      head.setAttribute('aria-expanded', String(open));
      card.classList.toggle('open', open);
      body.hidden = !open;
      if (open && !body.childElementCount) body.append(...this.mapBody(m, rows));
      this.nav.replace({ openMaps: [...this.openMaps] });
    };
    card.append(head, body);
    toggle(this.openMaps.has(m.map));
    return card;
  }

  mapBody(m, rows) {
    const out = [];
    if (rows.length) {
      const list = el('div', 'rk-pbest');
      for (const b of rows) list.append(this.bestRow(b));
      out.push(list);
    } else {
      out.push(el('p', 'rk-note', 'No ranked clears on this map yet.'));
    }
    const foot = el('div', 'rk-pmap-foot');
    foot.append(button('rk-btn small', 'Map leaderboard', () => this.nav.map(m.map, { highlight: this.steamId })));
    out.push(foot);
    return out;
  }

  bestRow(b) {
    const row = button('rk-pbrow', null, () => this.nav.stage(b.map, b.stageId, { mode: b.mode, kind: b.kind === 'coop' ? 'coop' : 'solo', highlight: this.steamId }));
    row.title = `${b.stage}: the stage’s leaderboard`;
    const name = el('span', 'rk-pb-name');
    name.append(el('b', null, b.stage));
    const tags = [b.mode === 'endless' ? 'Endless' : '', b.kind !== 'solo' ? KIND[b.kind] : ''].filter(Boolean);
    for (const t of tags) name.append(el('span', 'rk-tag', t));
    const where = el('span', 'rk-pb-place');
    where.append(place(b.place), el('small', null, b.of ? `of ${thousands(b.of)}` : ''));
    const time = el('span', 'rk-time');
    time.append(el('b', null, `${b.mode === 'endless' ? '∞ ' : ''}${formatTime(b.time)}`));
    if (b.mode !== 'endless' && b.hits != null) time.append(el('small', null, plural(b.hits, 'hit')));
    row.append(where, name, time, el('span', 'rk-pb-when', b.at != null ? shortDate(b.at) : ''));
    return row;
  }

  // ---- Recent runs
  recentList(recent) {
    if (!recent.length) return emptyState('No shared runs yet.');
    const ol = el('ol', 'hf-list rk-recent');
    for (const r of recent) {
      const li = el('li', `hf-row hh-row tone-${r.result === 'win' ? 'win' : r.result === 'over' ? 'endless' : 'lose'}`);
      const body = el('div', 'hf-body');
      const line = el('p', 'hf-line');
      line.append(el('b', 'hf-what', r.stage), ` · ${RESULT[r.result]}${r.kind !== 'solo' ? ` · ${KIND[r.kind]}` : ''}`);
      const meta = el('p', 'hf-meta');
      meta.append(el('span', null, [r.map ? mapTitle(this.nav.mapInfo(r.map), r.map) : '', r.hits != null ? plural(r.hits, 'hit') : ''].filter(Boolean).join(' · ')));
      body.append(line, meta);
      const side = el('div', 'hf-side');
      if (r.time != null) side.append(el('span', 'hf-stat', formatTime(r.time)));
      if (r.at != null) side.append(el('span', 'hf-when', ago(Date.now() - r.at)));
      const act = el('div', 'hf-act');
      if (r.replay) {
        meta.append(viewsBadge(r.views));
        const watch = () => this.nav.watch(r.replay);
        act.append(playButton(`Watch the run on ${r.stage}`, watch));
        li.classList.add('has-replay');
        li.addEventListener('click', watch);
      }
      li.append(el('span', 'hf-icon hh-dot'), body, side, act);
      ol.append(li);
    }
    return ol;
  }
}
