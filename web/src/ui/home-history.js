// "Your runs" beside the live feed (ui/home-feed.js's second tab): every run you finished while signed in through
// Steam (GET /api/me/runs), newest first, each with its replay: Watch it, Share it (anyone with the link can watch,
// and it is kept for good) or take the share back. Signed out, a way to sign in.
// Rows come from the server; they reach the DOM only as text.
import { fetchJson } from '../lib/fetch.js';
import { cleanText } from '../lib/room-rules.js';
import { isMapName } from '../lib/paths.js';
import { formatTime } from '../lib/format.js';
import { account, onAccount } from '../app/account.js';
import { steamButton } from './steam-button.js';
import { displayName } from './maps.js';
import { ago } from '../lib/format.js';
import { playButton, shareButton, viewsBadge } from './replay-buttons.js';

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

export const RESULT = { win: 'Cleared', lose: 'Failed', over: 'Endless', draw: 'Draw' };

function cleanRun(x) {
  if (!x || typeof x !== 'object' || !Number.isInteger(x.id) || x.id < 1) return null;
  return {
    id: x.id, kind: ['solo', 'coop', 'versus'].includes(x.kind) ? x.kind : 'solo', map: isMapName(x.map) ? x.map : '',
    stage: cleanText(x.stageName, 60) || 'a stage', result: RESULT[x.result] ? x.result : 'lose', won: x.won === true,
    time: Number.isFinite(x.time) ? x.time : null, hits: Number.isInteger(x.hits) ? x.hits : null,
    at: Number.isFinite(x.finishedAt) ? x.finishedAt : Date.now(),
    replay: x.replay && typeof x.replay === 'object' ? { public: x.replay.public === true, views: Number.isInteger(x.replay.views) ? x.replay.views : 0 } : null,
  };
}

export class HomeHistory {
  // mapTitle(name); onWatch(id)
  constructor({ mapTitle, onWatch }) {
    this.mapTitle = mapTitle;
    this.onWatch = onWatch;
    this.root = el('div', 'hh');
    this.list = el('ol', 'hf-list hh-list');
    this.note = el('div', 'hf-empty');
    this.root.append(this.list, this.note);
    onAccount(() => { if (this.shown) this.load(); });
  }

  async load() {
    this.shown = true;
    if (!account.user) { this.renderSignedOut(); return; }
    this.note.hidden = false;
    this.note.replaceChildren(el('p', null, 'Loading your runs…'));
    try {
      const j = await fetchJson('/api/me/runs?limit=60', { cache: 'no-store' });
      const runs = (Array.isArray(j?.runs) ? j.runs : []).map(cleanRun).filter(Boolean);
      this.list.replaceChildren(...runs.map((r) => this.row(r)));
      this.note.hidden = runs.length > 0;
      this.note.replaceChildren(el('p', null, 'No runs yet. Every stage you finish from now on lands here, replay included.'));
    } catch {
      this.list.replaceChildren();
      this.note.hidden = false;
      this.note.replaceChildren(el('p', null, 'Your runs need the server, and it isn’t reachable right now.'));
    }
  }

  renderSignedOut() {
    this.list.replaceChildren();
    this.note.hidden = false;
    this.note.replaceChildren(el('p', null, 'Sign in through Steam to keep every run you finish with its replay, be ranked on the leaderboards and share your runs. Guest runs are not saved.'), steamButton({ size: 'large' }));
  }

  row(r) {
    const li = el('li', `hf-row hh-row tone-${r.result === 'win' ? 'win' : r.result === 'over' ? 'endless' : 'lose'}`);
    const body = el('div', 'hf-body');
    const line = el('p', 'hf-line');
    line.append(el('b', 'hf-what', r.stage), ` · ${RESULT[r.result]}${r.kind !== 'solo' ? (r.kind === 'versus' ? ' · Versus' : ' · Online') : ''}`);
    const meta = el('p', 'hf-meta');
    const bits = [r.map ? displayName(this.mapTitle(r.map)) : '', r.hits != null ? `${r.hits} hit${r.hits === 1 ? '' : 's'}` : ''];
    meta.append(el('span', null, bits.filter(Boolean).join(' · ')));
    body.append(line, meta);
    const side = el('div', 'hf-side');
    if (r.time != null) side.append(el('span', 'hf-stat', formatTime(r.time)));
    side.append(el('span', 'hf-when', ago(Date.now() - r.at)));
    const act = el('div', 'hf-act');
    if (r.replay) {
      meta.append(viewsBadge(r.replay.views));
      act.append(playButton(`Watch your run on ${r.stage}`, () => this.onWatch(r.id)), shareButton(r.replay.public, () => this.share(r)));
      li.classList.add('has-replay');
      li.addEventListener('click', () => this.onWatch(r.id));
    }
    li.append(el('span', 'hf-icon hh-dot'), body, side, act);
    return li;
  }

  // make it public (once), then copy its link -> true when the link is on the clipboard
  async share(r) {
    if (!r.replay.public) {
      const ok = await fetch(`/api/replays/${r.id}/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) })
        .then((x) => (x.ok ? x.json() : null)).then((j) => j?.ok === true, () => false);
      if (!ok) return false;
      r.replay.public = true;
    }
    return navigator.clipboard ? navigator.clipboard.writeText(`${location.origin}/?replay=${r.id}`).then(() => true, () => false) : false;
  }
}
