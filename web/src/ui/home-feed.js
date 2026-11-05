// The home page's live feed (server/activity.js): every run anyone finishes on this server, newest on top, sliding
// in as it happens, with relative times that keep ticking. Plus the server's numbers (online, open rooms, rounds
// live) for the home page's header and stats row.
//
// Every row came from the server, and a solo row from another player's page: the fields are cleaned here and
// only ever reach the DOM as text.
import { cleanText } from '../lib/room-rules.js';
import { isMapName } from '../lib/paths.js';
import { formatTime } from '../lib/format.js';
import { displayName } from './maps.js';
import { sharesRuns, setSharesRuns } from '../app/activity.js';

const SHOW = 30; // rows on screen
const RETRY_MS = [3000, 6000, 15000, 30000, 60000];
const RESULTS = new Set(['win', 'lose', 'over', 'draw']);
const KINDS = new Set(['solo', 'coop', 'versus']);

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

// one row off the wire, or null
function cleanItem(x) {
  if (!x || typeof x !== 'object' || !Number.isInteger(x.id) || !KINDS.has(x.kind) || !RESULTS.has(x.result)) return null;
  const names = (v) => (Array.isArray(v) ? v.slice(0, 8).map((n) => cleanText(n, 24)).filter(Boolean) : []);
  return {
    id: x.id, at: Number.isFinite(x.at) ? x.at : Date.now(), kind: x.kind, result: x.result,
    map: isMapName(x.map) ? x.map : '', stage: cleanText(x.stage, 60) || 'a stage', mode: x.mode === 'endless' ? 'endless' : 'normal',
    time: Number.isFinite(x.time) && x.time >= 0 ? x.time : null, hits: Number.isInteger(x.hits) ? x.hits : null,
    names: names(x.names), winners: names(x.winners), room: cleanText(x.room, 32), cause: cleanText(x.cause, 40),
    players: Number.isInteger(x.players) ? Math.max(1, Math.min(8, x.players)) : 1,
  };
}

const list = (names, n) => (names.length <= 2 ? names.join(' & ') : `${names.slice(0, 2).join(', ')} +${(n || names.length) - 2}`);

// a row's words: [who, verb, what] + a tone for its icon
function describe(it) {
  const t = it.time != null ? formatTime(it.time) : '';
  if (it.kind === 'solo') {
    const who = it.names[0] || 'Player';
    if (it.result === 'win') return { tone: 'win', who, verb: 'cleared', what: it.stage, stat: t };
    if (it.result === 'over') return { tone: 'endless', who, verb: 'survived endless on', what: it.stage, stat: t };
    return { tone: 'lose', who, verb: 'died on', what: it.stage, stat: t, cause: it.cause };
  }
  const squad = it.names.length ? list(it.names, it.players) : it.players > 1 ? `A private squad of ${it.players}` : 'A private room';
  if (it.kind === 'versus') {
    if (it.result === 'win' && it.winners.length) return { tone: 'crown', who: it.winners[0], verb: 'won versus on', what: it.stage, stat: t };
    if (it.result === 'win') return { tone: 'crown', who: squad, verb: 'finished versus on', what: it.stage, stat: t };
    return { tone: 'draw', who: squad, verb: 'drew on', what: it.stage, stat: t };
  }
  if (it.result === 'win') return { tone: 'win', who: squad, verb: 'cleared', what: it.stage, stat: t };
  if (it.result === 'over') return { tone: 'endless', who: squad, verb: 'lasted on', what: it.stage, stat: t };
  return { tone: 'lose', who: squad, verb: 'wiped on', what: it.stage, stat: t };
}

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const ICONS = { // constant SVG, never data
  win: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lose: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  endless: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 8c-1.5-2-2.6-3-4-3a3 3 0 0 0 0 6c1.4 0 2.5-1 4-3zm0 0c1.5 2 2.6 3 4 3a3 3 0 0 0 0-6c-1.4 0-2.5 1-4 3z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  crown: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 11.5l-.5-6 3.5 2.5L8 3.5l2.5 4.5L14 5.5l-.5 6z" fill="currentColor"/></svg>',
  draw: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6h8M4 10h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

export class HomeFeed {
  // net: CoopClient; mapTitle(name) -> display title; onStats(stats | null) for the header (null = offline)
  constructor({ net, mapTitle, onStats }) {
    this.net = net;
    this.mapTitle = mapTitle;
    this.onStats = onStats;
    this.rows = new Map(); // id -> { li, at, time }
    this.offset = 0; // our clock - the server's
    this.watching = false;
    this.retry = 0;
    this.root = this.build();
    net.on('feed', (m) => this.fill(m));
    net.on('act', (m) => { const it = cleanItem(m.item); if (it) this.add(it, true); });
    net.on('stats', (m) => this.stats(m.stats));
    net.on('status', (s) => this.status(s));
  }

  build() {
    const root = el('section', 'hf');
    root.setAttribute('aria-labelledby', 'hf-title');
    const head = el('header', 'hf-head');
    const title = el('h2', 'hf-title');
    title.id = 'hf-title';
    title.append(el('span', 'hf-live', 'Live'), 'Activity');
    this.state = el('span', 'hf-state');
    head.append(title, this.state);
    this.list = el('ol', 'hf-list');
    this.list.setAttribute('aria-live', 'polite');
    this.list.setAttribute('aria-relevant', 'additions');
    this.empty = el('div', 'hf-empty');
    this.emptyText = el('p', null, '');
    this.empty.append(el('span', 'hf-pulse'), this.emptyText);
    const foot = el('footer', 'hf-foot');
    const sw = el('label', 'hf-switch');
    this.share = el('input');
    this.share.type = 'checkbox';
    this.share.checked = sharesRuns();
    this.share.addEventListener('change', () => setSharesRuns(this.share.checked));
    sw.append(this.share, el('span', 'hf-track'), el('span', null, 'Share my solo runs here'));
    foot.append(sw);
    root.append(head, this.list, this.empty, foot);
    this.status(this.net.status);
    return root;
  }

  // the page shows the feed: subscribe (and keep trying while it's up); hidden: stop the clock and the retries
  start() {
    this.watching = true;
    this.net.watchFeed(true);
    clearInterval(this.clock);
    this.clock = setInterval(() => this.tickTimes(), 10000);
  }
  stop() {
    this.watching = false;
    clearInterval(this.clock);
    clearTimeout(this.retryT);
    this.net.watchFeed(false);
  }

  status(s) {
    if (s === 'online') { this.retry = 0; this.state.textContent = ''; }
    else if (s === 'connecting') this.state.textContent = 'Connecting…';
    else {
      this.state.textContent = 'Offline';
      this.onStats(null);
      if (this.watching) {
        clearTimeout(this.retryT);
        this.retryT = setTimeout(() => { if (this.watching) this.net.watchFeed(true); }, RETRY_MS[Math.min(this.retry++, RETRY_MS.length - 1)]);
      }
    }
    this.root?.classList.toggle('offline', s === 'offline');
    this.renderEmpty();
  }

  fill(m) {
    if (Number.isFinite(m.now)) this.offset = Date.now() - m.now;
    const items = Array.isArray(m.items) ? m.items.slice(0, SHOW).map(cleanItem).filter(Boolean) : [];
    this.list.replaceChildren();
    this.rows.clear();
    for (const it of items.reverse()) this.add(it, false);
    this.stats(m.stats);
  }

  stats(s) {
    if (!s || typeof s !== 'object') return;
    const n = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 99999) : 0);
    this.onStats({ online: n(s.online), rooms: n(s.rooms), rounds: n(s.rounds), playing: n(s.playing) });
  }

  add(it, fresh) {
    if (this.rows.has(it.id)) return;
    const d = describe(it);
    const li = el('li', `hf-row tone-${d.tone}${fresh ? ' fresh' : ''}`);
    const icon = el('span', 'hf-icon');
    icon.innerHTML = ICONS[d.tone]; // a constant
    const body = el('div', 'hf-body');
    const line = el('p', 'hf-line');
    line.append(el('b', 'hf-who', d.who), ` ${d.verb} `, el('b', 'hf-what', d.what));
    const meta = el('p', 'hf-meta');
    const bits = [it.map ? displayName(this.mapTitle(it.map)) : '', it.kind === 'solo' ? 'Solo' : it.kind === 'versus' ? 'Versus' : 'Co-op'];
    if (d.cause) bits.push(`to ${d.cause}`);
    meta.append(el('span', null, bits.filter(Boolean).join(' · ')));
    const when = el('time', 'hf-when');
    body.append(line, meta);
    const side = el('div', 'hf-side');
    if (d.stat) side.append(el('span', 'hf-stat', d.stat));
    side.append(when);
    li.append(icon, body, side);
    this.rows.set(it.id, { li, at: it.at, when });
    this.setWhen(this.rows.get(it.id));
    this.list.prepend(li);
    if (fresh) li.addEventListener('animationend', () => li.classList.remove('fresh'), { once: true });
    while (this.list.childElementCount > SHOW) {
      const last = this.list.lastElementChild;
      for (const [id, r] of this.rows) if (r.li === last) this.rows.delete(id);
      last.remove();
    }
    this.renderEmpty();
  }

  setWhen(r) {
    const local = r.at + this.offset;
    r.when.textContent = ago(Date.now() - local);
    r.when.dateTime = new Date(local).toISOString();
  }
  tickTimes() { for (const r of this.rows.values()) this.setWhen(r); }

  renderEmpty() {
    if (!this.empty) return;
    const none = !this.rows.size;
    this.empty.hidden = !none;
    this.emptyText.textContent = this.net.status === 'offline'
      ? 'The live feed needs the co-op server, and it isn’t reachable right now. Solo practice works offline.'
      : this.net.status === 'online' ? 'No runs yet. Clear a stage and you’ll show up here.' : 'Connecting to the live feed…';
  }
}
