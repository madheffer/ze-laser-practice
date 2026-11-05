// A player's public profile (GET /api/players/<SteamID64>, server/players-http.js), over the home page: their Steam
// name and avatar, since when they play here, their totals, their best time on every stage and their latest runs,
// each with its replay when it is public. Opened from your account in the home page's top bar and from a signed-in
// player's name in the live feed; ?player=<SteamID64> opens it from a link.
//
// Everything in it came from the server (names from Steam, stage names from scenarios): it is cleaned here and only
// ever reaches the DOM as text. The avatar is used only when it is a Steam CDN URL (lib/steam.js).
import './profile.css';
import { fetchJson } from '../lib/fetch.js';
import { cleanText } from '../lib/room-rules.js';
import { isMapName } from '../lib/paths.js';
import { isSteamId, isAvatarUrl } from '../lib/steam.js';
import { formatTime, plural, thousands, ago } from '../lib/format.js';
import { displayName } from './maps.js';
import { playButton, viewsBadge } from './replay-buttons.js';
import { RESULT } from './home-history.js';

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

const KIND = { solo: 'Solo', coop: 'Co-op', versus: 'Versus' };
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const kindOf = (v) => (KIND[v] ? v : 'solo');

// the server's answer, cleaned -> { player, totals, best, recent } or null
function cleanProfile(j, steamId) {
  const p = j?.player;
  if (!p || p.steamId !== steamId) return null;
  const t = j.totals || {};
  return {
    player: { steamId, name: cleanText(p.name, 32) || 'Steam player', avatar: isAvatarUrl(p.avatar) ? p.avatar : '', since: num(p.since) },
    totals: { runs: count(t.runs), wins: count(t.wins), cleared: count(t.cleared), solo: count(t.solo), coop: count(t.coop), versus: count(t.versus) },
    best: (Array.isArray(j.best) ? j.best : []).slice(0, 200).filter((b) => b && isMapName(b.map) && num(b.time) != null).map((b) => ({
      map: b.map, stage: cleanText(b.stageName, 60) || 'a stage', endless: b.mode === 'endless', kind: kindOf(b.kind),
      time: b.time, hits: Number.isInteger(b.hits) ? b.hits : null, at: num(b.at),
    })),
    recent: (Array.isArray(j.recent) ? j.recent : []).slice(0, 50).filter((r) => r && Number.isInteger(r.id)).map((r) => ({
      map: isMapName(r.map) ? r.map : '', stage: cleanText(r.stageName, 60) || 'a stage', kind: kindOf(r.kind),
      result: RESULT[r.result] ? r.result : 'lose', time: num(r.time), hits: Number.isInteger(r.hits) ? r.hits : null, at: num(r.at),
      replay: Number.isInteger(r.replay) && r.replay > 0 ? r.replay : null, views: count(r.views),
    })),
  };
}

export class Profile {
  // parent: where the panel lives (the home page's root); mapTitle(name); onWatch(replay id)
  constructor(parent, { mapTitle, onWatch }) {
    this.mapTitle = mapTitle;
    this.onWatch = onWatch;
    this.root = el('div', 'pf');
    this.root.hidden = true;
    this.root.addEventListener('click', (ev) => { if (ev.target === this.root) this.close(); });
    this.root.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); this.close(); } });
    this.card = el('section', 'pf-card');
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', 'pf-name');
    this.root.append(this.card);
    parent.append(this.root);
  }

  get open() { return !this.root.hidden; }

  async show(steamId) {
    if (!isSteamId(steamId)) return;
    this.steamId = steamId;
    if (!this.open) this.back = document.activeElement;
    this.root.hidden = false;
    this.setLink(steamId);
    this.render(null, 'Loading…');
    let p = null, msg = 'This player isn’t here.';
    try { p = cleanProfile(await fetchJson(`/api/players/${steamId}`, { cache: 'no-store' }), steamId); }
    catch (e) { if (!/: 404$/.test(e.message)) msg = 'Profiles need the server, and it isn’t reachable right now.'; }
    if (this.steamId === steamId && this.open) this.render(p, msg);
  }

  close() {
    if (!this.open) return;
    this.root.hidden = true;
    this.steamId = null;
    this.setLink(null);
    this.back?.focus?.({ preventScroll: true });
  }

  // ?player=<id> while it's open, so the address bar is a link to it
  setLink(steamId) {
    const url = new URL(location.href);
    if (steamId) url.searchParams.set('player', steamId); else url.searchParams.delete('player');
    history.replaceState(history.state, '', url);
  }

  render(p, msg) {
    const close = el('button', 'pf-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close profile');
    close.addEventListener('click', () => this.close());
    if (!p) {
      const h = el('h2', 'pf-name', 'Player');
      h.id = 'pf-name';
      this.card.replaceChildren(close, h, el('p', 'pf-note', msg));
      close.focus({ preventScroll: true });
      return;
    }
    this.card.replaceChildren(close, this.head(p), this.numbers(p.totals), this.bestList(p.best), this.recentList(p.recent));
    close.focus({ preventScroll: true });
  }

  head({ player }) {
    const head = el('header', 'pf-head');
    const pic = el('div', 'pf-pic');
    if (player.avatar) {
      const img = el('img');
      img.src = player.avatar; img.alt = ''; img.width = img.height = 72; img.referrerPolicy = 'no-referrer'; img.decoding = 'async';
      img.addEventListener('error', () => img.remove());
      pic.append(img);
    }
    const who = el('div', 'pf-who');
    const h = el('h2', 'pf-name', player.name);
    h.id = 'pf-name';
    const since = player.since ? `Playing since ${new Date(player.since).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : '';
    const copy = el('button', 'home-link pf-copy', 'Copy link');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(`${location.origin}/?player=${player.steamId}`)
        .then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy link'; }, 1400); }, () => {});
    });
    who.append(h, el('p', 'pf-since', since || 'Steam player'), copy);
    head.append(pic, who);
    return head;
  }

  numbers(t) {
    const dl = el('dl', 'home-stats pf-stats');
    const split = [['solo', 'solo'], ['coop', 'co-op'], ['versus', 'versus']].filter(([k]) => t[k]).map(([k, w]) => `${thousands(t[k])} ${w}`).join(' · ');
    for (const [n, label, sub] of [[t.runs, t.runs === 1 ? 'run' : 'runs', split], [t.wins, t.wins === 1 ? 'clear' : 'clears'], [t.cleared, 'stages cleared']]) {
      const d = el('div');
      d.append(el('dt', null, label), el('dd', null, thousands(n)));
      if (sub) d.append(el('span', 'pf-sub', sub));
      dl.append(d);
    }
    return dl;
  }

  // best times, by map
  bestList(best) {
    const box = el('section', 'pf-section');
    box.append(el('h3', 'pf-h', 'Best times'));
    if (!best.length) { box.append(el('p', 'pf-note', 'No ranked clears yet.')); return box; }
    const list = el('div', 'pf-best');
    let map = null;
    for (const b of best) {
      if (b.map !== map) { map = b.map; list.append(el('h4', 'pf-map', displayName(this.mapTitle(map)))); }
      const row = el('div', 'pf-brow');
      const tags = [b.endless ? 'Endless' : '', b.kind !== 'solo' ? KIND[b.kind] : ''].filter(Boolean).join(' · ');
      const name = el('span', 'pf-stage', b.stage);
      if (tags) name.append(el('span', 'pf-tag', tags));
      row.append(name, el('span', 'pf-hits', b.hits != null && !b.endless ? plural(b.hits, 'hit') : ''), el('span', 'hf-stat', formatTime(b.time)));
      list.append(row);
    }
    box.append(list);
    return box;
  }

  recentList(recent) {
    const box = el('section', 'pf-section');
    box.append(el('h3', 'pf-h', 'Latest runs'));
    if (!recent.length) { box.append(el('p', 'pf-note', 'No shared runs yet.')); return box; }
    const ol = el('ol', 'hf-list pf-list');
    for (const r of recent) {
      const li = el('li', `hf-row hh-row tone-${r.result === 'win' ? 'win' : r.result === 'over' ? 'endless' : 'lose'}`);
      const body = el('div', 'hf-body');
      const line = el('p', 'hf-line');
      line.append(el('b', 'hf-what', r.stage), ` · ${RESULT[r.result]}${r.kind !== 'solo' ? ` · ${KIND[r.kind]}` : ''}`);
      const meta = el('p', 'hf-meta');
      meta.append(el('span', null, [r.map ? displayName(this.mapTitle(r.map)) : '', r.hits != null ? plural(r.hits, 'hit') : ''].filter(Boolean).join(' · ')));
      body.append(line, meta);
      const side = el('div', 'hf-side');
      if (r.time != null) side.append(el('span', 'hf-stat', formatTime(r.time)));
      if (r.at != null) side.append(el('span', 'hf-when', ago(Date.now() - r.at)));
      const act = el('div', 'hf-act');
      if (r.replay) {
        meta.append(viewsBadge(r.views));
        const watch = () => { this.close(); this.onWatch(r.replay); };
        act.append(playButton(`Watch the run on ${r.stage}`, watch));
        li.classList.add('has-replay');
        li.addEventListener('click', watch);
      }
      li.append(el('span', 'hf-icon hh-dot'), body, side, act);
      ol.append(li);
    }
    box.append(ol);
    return box;
  }
}
