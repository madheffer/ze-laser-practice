// One stage's board (ui/rankings.js's "stage" view): the stage's shot and name, Normal / Endless (when the stage has
// an endless mode) and Solo / Online, then everyone's best: place, player, time, hits, when, and Watch when that
// run's replay is public. You (or the profile you came from) are highlighted, pinned under the list when further
// down. ‹ › step through the map's stages in the stage list's order without going back.
// Data: ui/board-data.js (server/api.js /api/leaderboard). Text goes in as text only.
import { el, button, KIND, isMe, playerLink, place, segmented, skeleton, emptyState, shortDate } from './rank-bits.js';
import { stageBoard, mapStages } from './board-data.js';
import { account } from '../app/account.js';
import { formatTime, plural, thousands, ago } from '../lib/format.js';
import { playButton } from './replay-buttons.js';
import { shotUrls } from './stage-card.js';
import { mapTitle } from './board.js';

const ARROW = { // constant SVG
  prev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const WEEK = 7 * 86400000;

export class StageBoardView {
  // args: { map, stage, mode, kind, highlight }
  constructor(body, args, nav) {
    this.nav = nav;
    this.alive = true;
    this.map = args.map;
    this.info = nav.mapInfo(this.map);
    this.mode = args.mode === 'endless' ? 'endless' : 'normal';
    this.kind = args.kind === 'coop' ? 'coop' : 'solo';
    this.highlight = args.highlight || null;
    this.root = el('div', 'rk-stageview');
    body.append(this.root);
    nav.title(mapTitle(this.info, this.map));
    mapStages(this.map).then((groups) => {
      if (!this.alive) return;
      this.order = groups.flatMap((g) => g.stages.map((s) => ({ ...s, group: g.name })));
      this.setStage(args.stage, false);
    });
  }

  dispose() { this.alive = false; }

  setStage(id, user) {
    const i = this.order.findIndex((s) => s.id === id);
    this.stage = this.order[i] || { id, name: id, endless: false, group: '' };
    this.index = i;
    if (!this.stage.endless) this.mode = 'normal';
    if (user) this.nav.replace({ stage: id, mode: this.mode });
    this.build();
    this.load();
  }

  build() {
    const s = this.stage;
    const hero = el('header', 'rk-hero rk-stage-hero');
    const url = shotUrls(this.info)(s.id);
    const art = el('span', 'rk-art rk-hero-art');
    art.setAttribute('aria-hidden', 'true');
    if (url) {
      const img = el('img');
      img.src = url; img.alt = ''; img.decoding = 'async';
      img.addEventListener('load', () => art.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
      art.append(img);
    }
    const text = el('div', 'rk-hero-text');
    const crumb = button('rk-eyebrow rk-crumb', [mapTitle(this.info, this.map), s.group].filter(Boolean).join(' · '), () => this.nav.map(this.map, { tab: 'stages', kind: this.kind, highlight: this.highlight }));
    crumb.title = 'This map’s leaderboard';
    const h = el('h3', 'rk-hero-title', s.name);
    this.sub = el('p', 'rk-hero-sub', '');
    text.append(crumb, h, this.sub);
    const side = el('div', 'rk-hero-side');
    if (s.endless) side.append(segmented('Mode', [['normal', 'Normal'], ['endless', 'Endless']], this.mode, (m) => { this.mode = m; this.nav.replace({ mode: m }); this.load(); }).root);
    side.append(segmented('Who played', [['solo', KIND.solo], ['coop', KIND.coop]], this.kind, (k) => { this.kind = k; this.nav.replace({ kind: k }); this.load(); }).root);
    hero.append(art, text, side);

    // ‹ previous / next › stage
    const step = el('div', 'rk-step');
    const prev = this.order[this.index - 1], next = this.order[this.index + 1];
    const stepBtn = (dir, to) => {
      const b = button(`rk-step-b ${dir}`, null, () => this.setStage(to.id, true));
      b.innerHTML = ARROW[dir]; // a constant
      b.append(el('span', null, to.name));
      b.title = `${dir === 'prev' ? 'Previous' : 'Next'} stage: ${to.name}`;
      return b;
    };
    step.append(prev ? stepBtn('prev', prev) : el('span'), next ? stepBtn('next', next) : el('span'));

    this.panel = el('div', 'rk-tabpanel');
    this.root.replaceChildren(hero, step, this.panel);
  }

  async load() {
    const key = `${this.stage.id}|${this.mode}|${this.kind}`;
    this.key = key;
    this.panel.replaceChildren(skeleton(8));
    const player = this.highlight || account.user?.steamId || null;
    try {
      const b = await stageBoard(this.map, this.stage.id, { mode: this.mode, kind: this.kind, player });
      if (!this.alive || this.key !== key) return;
      const top = b.rows[0];
      this.sub.textContent = top
        ? `Record ${formatTime(top.time)} by ${top.name} · ${thousands(b.total)} ranked`
        : `${this.mode === 'endless' ? 'Endless' : 'Normal'} · ${KIND[this.kind]} · no ranked runs yet`;
      this.panel.replaceChildren(this.table(b));
    } catch {
      if (!this.alive || this.key !== key) return;
      this.panel.replaceChildren(emptyState('Leaderboards need the server, and it isn’t reachable right now.', button('rk-btn', 'Try again', () => this.load())));
    }
  }

  table(b) {
    if (!b.rows.length) {
      return emptyState(this.mode === 'endless' ? 'Nobody has a ranked endless run here yet.' : 'Nobody has a ranked clear here yet. Be the first.',
        button('rk-btn primary', 'Play this map', () => this.nav.play(this.map)));
    }
    const endless = this.mode === 'endless';
    const t = el('div', `rk-table rk-times${endless ? ' endless' : ''}`);
    t.setAttribute('role', 'table');
    t.setAttribute('aria-label', `${this.stage.name} leaderboard`);
    const head = el('div', 'rk-tr rk-th');
    head.setAttribute('role', 'row');
    for (const [cls, text] of [['c-rank', '#'], ['c-who', 'Player'], ['c-time', endless ? 'Survived' : 'Time'], ['c-hits', endless ? '' : 'Hits'], ['c-when', 'When'], ['c-act', '']]) {
      const c = el('span', `rk-td ${cls}`, text);
      c.setAttribute('role', 'columnheader');
      head.append(c);
    }
    t.append(head);
    const best = b.rows[0].time;
    for (const r of b.rows) t.append(this.row(r, best));
    if (b.me) { t.append(el('div', 'rk-gap', '⋯')); t.append(this.row(b.me, best)); }
    const box = el('div');
    box.append(t);
    if (b.total > b.rows.length) box.append(el('p', 'rk-foot', `Top ${b.rows.length} of ${thousands(b.total)} shown`));
    box.append(el('p', 'rk-foot', endless ? 'Each player’s longest survival. Only Steam accounts rank; runs with cheat rules never do.'
      : 'Each player’s fastest clear, fewest hits breaking a tie. Only Steam accounts rank; runs with cheat rules never do.'));
    return box;
  }

  row(r, best) {
    const endless = this.mode === 'endless';
    const row = el('div', 'rk-tr rk-row');
    row.setAttribute('role', 'row');
    if (isMe(r.steamId)) row.classList.add('me');
    if (this.highlight && r.steamId === this.highlight) row.classList.add('hl');
    const td = (cls, ...kids) => { const c = el('span', `rk-td ${cls}`); c.setAttribute('role', 'cell'); c.append(...kids); return c; };
    const time = el('span', 'rk-time');
    time.append(el('b', null, formatTime(r.time)));
    if (r.rank > 1) time.append(el('small', null, `${endless ? '−' : '+'}${formatTime(Math.abs(r.time - best))}`));
    const when = r.at != null ? (Date.now() - r.at < WEEK ? ago(Date.now() - r.at) : shortDate(r.at)) : '';
    const act = el('span', 'rk-act');
    if (r.replay) act.append(playButton(`Watch ${r.name}’s run`, () => this.nav.watch(r.replay)));
    row.append(
      td('c-rank', place(r.rank)),
      td('c-who', playerLink(r, (id) => this.nav.player(id))),
      td('c-time', time),
      td('c-hits num', endless || r.hits == null ? '' : plural(r.hits, 'hit')),
      td('c-when', when),
      td('c-act', act),
    );
    row.addEventListener('click', () => this.nav.player(r.steamId));
    return row;
  }
}
