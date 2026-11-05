// Leaderboards and profiles: one panel over whatever is on screen (the home page, the menu), with a stack of
// views you move through and Back out of:
//   map     a map's leaderboard: its players ranked, and every stage's record (ui/board.js)
//   stage   one stage's board: everyone's best time on it (ui/stage-board.js)
//   player  a player's profile: their maps, wins, records and placings, their latest runs (ui/profile.js)
// Every player name opens their profile, every map and stage on a profile opens its board, so you can walk from a
// record to its holder to their other records. The address bar follows the top view (?board=<map>[&stage=<id>],
// ?player=<SteamID64>), so any of them is a link; app/replay-boot.js opens one from a link.
import './rankings.css';
import { el, button } from './rank-bits.js';
import { isMapName, isStageId } from '../lib/paths.js';
import { isSteamId } from '../lib/steam.js';
import { MapBoardView, byTitle } from './board.js';
import { StageBoardView } from './stage-board.js';
import { ProfileView } from './profile.js';

const VIEWS = { map: MapBoardView, stage: StageBoardView, player: ProfileView };
const PARAMS = ['board', 'stage', 'player'];
const BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export class Rankings {
  // maps(): the map index (maps/index.json entries); onWatch(replay id); onPlay(map) opens a map's stage list
  constructor({ maps, onWatch, onPlay }) {
    this.maps = maps;
    this.onWatch = onWatch;
    this.onPlay = onPlay;
    this.stack = []; // [{ type, args }]
    this.lastMap = null; // the map the leaderboards last showed, this page load only
    this.root = el('div', 'rk');
    this.root.hidden = true;
    this.root.addEventListener('pointerdown', (ev) => { this.downOnBackdrop = ev.target === this.root; });
    this.root.addEventListener('click', (ev) => { if (ev.target === this.root && this.downOnBackdrop) this.close(); });
    this.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.close(); }
      if (ev.key === 'Backspace' && this.stack.length > 1 && !/^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) { ev.preventDefault(); this.back(); }
      ev.stopPropagation(); // the game's own keys (app/input.js) stay out of the panel
    });

    this.panel = el('section', 'rk-panel');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-labelledby', 'rk-title');
    const bar = el('header', 'rk-bar');
    this.backBtn = button('rk-icon rk-back', null, () => this.back(), 'Back');
    this.backBtn.innerHTML = BACK; // a constant
    this.backLabel = el('span', 'rk-back-l');
    this.backBtn.append(this.backLabel);
    this.title = el('h2', 'rk-title');
    this.title.id = 'rk-title';
    const close = button('rk-icon rk-close', null, () => this.close(), 'Close');
    close.innerHTML = CLOSE; // a constant
    bar.append(this.backBtn, this.title, close);
    this.body = el('div', 'rk-body');
    this.panel.append(bar, this.body);
    this.root.append(this.panel);
    document.body.append(this.root);
  }

  get open() { return !this.root.hidden; }

  // the views' way around: every link in a board or a profile goes through here
  get nav() {
    return {
      map: (map, opts) => this.push('map', { map, ...opts }),
      stage: (map, stage, opts) => this.push('stage', { map, stage, ...opts }),
      player: (steamId) => this.push('player', { steamId }),
      replace: (args) => this.replace(args), // the top view changed what it shows (another map, a tab): no new Back step
      title: (text) => { this.title.textContent = text; },
      watch: (id) => { this.close(); this.onWatch(id); },
      play: (map) => { this.close(); this.onPlay(map); },
      maps: () => (this.maps() || []).filter((m) => isMapName(m.name)),
      mapInfo: (name) => (this.maps() || []).find((m) => m.name === name) || null,
      defaultMap: () => this.defaultMap(),
    };
  }

  // the leaderboards with no map asked for: the last one shown, else the first map with stages in the rail's order
  defaultMap() {
    const maps = this.nav.maps().filter((m) => m.scenarios > 0).sort(byTitle);
    return maps.find((m) => m.name === this.lastMap)?.name || maps[0]?.name || null;
  }

  // open fresh (from the home page, a link, the stage list): the stack starts over
  showMap(map, opts = {}) { this.start('map', { map: isMapName(map) ? map : this.defaultMap(), ...opts }); }
  showStage(map, stage, opts = {}) { if (isMapName(map) && isStageId(stage)) this.start('stage', { map, stage, ...opts }); }
  showPlayer(steamId) { if (isSteamId(steamId)) this.start('player', { steamId }); }

  start(type, args) {
    if (!this.open) { this.returnFocus = document.activeElement; this.root.hidden = false; document.body.classList.add('rk-open'); }
    this.stack = [];
    this.push(type, args);
  }

  push(type, args) {
    this.saveScroll();
    this.stack.push({ type, args });
    this.render();
  }

  replace(args) {
    const top = this.stack.at(-1);
    if (!top) return;
    top.args = { ...top.args, ...args };
    if (top.type === 'map' && top.args.map) this.lastMap = top.args.map;
    this.setLink();
  }

  back() {
    if (this.stack.length < 2) return this.close();
    this.stack.pop();
    this.render(this.stack.at(-1).scroll);
  }

  close() {
    if (!this.open) return;
    this.view?.dispose?.();
    this.view = null;
    this.root.hidden = true;
    document.body.classList.remove('rk-open');
    this.stack = [];
    this.body.replaceChildren();
    this.setLink();
    this.returnFocus?.focus?.({ preventScroll: true });
  }

  saveScroll() { const top = this.stack.at(-1); if (top) top.scroll = this.body.scrollTop; }

  render(scroll = 0) {
    const top = this.stack.at(-1);
    this.view?.dispose?.();
    if (top.type === 'map' && top.args.map) this.lastMap = top.args.map;
    const prev = this.stack.at(-2);
    this.backBtn.hidden = !prev;
    this.backLabel.textContent = prev ? { map: 'Leaderboard', stage: 'Stage', player: 'Profile' }[prev.type] : '';
    this.title.textContent = '';
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    const View = VIEWS[top.type];
    this.view = new View(this.body, top.args, this.nav);
    if (scroll) requestAnimationFrame(() => { this.body.scrollTop = scroll; });
    this.setLink();
    (this.panel.querySelector('[data-autofocus]') || (prev ? this.backBtn : this.panel.querySelector('.rk-close')))?.focus({ preventScroll: true });
  }

  // the address bar: a link to the top view (and none once closed)
  setLink() {
    const url = new URL(location.href);
    for (const k of PARAMS) url.searchParams.delete(k);
    const top = this.open ? this.stack.at(-1) : null;
    if (top?.type === 'player') url.searchParams.set('player', top.args.steamId);
    else if (top?.args.map) {
      url.searchParams.set('board', top.args.map);
      if (top.type === 'stage') url.searchParams.set('stage', top.args.stage);
    }
    history.replaceState(history.state, '', url);
  }
}
