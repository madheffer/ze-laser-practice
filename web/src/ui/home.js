// The home page: what you see first. The maps' own screenshots behind it (a soft backdrop and a drifting strip,
// ui/home-hero.js), three ways in (Play now = solo, Find a lobby, Make a lobby, plus join by code), the server's
// numbers, and the live feed of everyone's runs (ui/home-feed.js). Everything leads into the menu (ui/menu.js),
// which keeps its own Home button to come back.
//
// Layout (home.css): phones get one column in thumb order (actions, then maps, then the feed); from ~960px the
// feed moves beside the actions; the strip runs along the bottom on every size.
import './home.css';
import { ROOM_CODE } from '../net/coop-client.js';
import { Backdrop, Strip, shotsOf } from './home-hero.js';
import { HomeFeed } from './home-feed.js';
import { account, onAccount, signOut } from '../app/account.js';
import { steamButton } from './steam-button.js';
import { Profile } from './profile.js';

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

const ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON = { // constant SVG, never data
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  find: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  make: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};

export class Home {
  // net: CoopClient; mapTitle(name); on: { play(), find(), make(), join(code), map(name), settings(), watch(replay id) }
  constructor(root, { net, mapTitle, on }) {
    this.root = root;
    this.on = on;
    this.mapTitle = mapTitle;
    this.feed = new HomeFeed({ net, mapTitle, onStats: (s) => this.stats(s), onWatch: (id) => on.watch(id), onPlayer: (id) => this.showPlayer(id) });
    this.build();
    this.profile = new Profile(root, { mapTitle, onWatch: (id) => on.watch(id) });
    onAccount(() => this.renderAccount());
  }

  build() {
    const r = this.root;
    r.className = 'home';
    r.setAttribute('role', 'region');
    r.setAttribute('aria-label', 'Home');
    const backdrop = el('div', 'home-backdrop');
    backdrop.setAttribute('aria-hidden', 'true');
    this.backdrop = new Backdrop(backdrop);

    // top bar: brand, the server's status, Settings
    const nav = el('header', 'home-nav');
    const brand = el('div', 'home-brand');
    brand.append(el('span', 'home-mark'), el('span', 'home-name', 'ZE Laser Practice'));
    this.pill = el('span', 'home-pill');
    this.pill.setAttribute('role', 'status');
    const settings = el('button', 'home-link', 'Settings');
    settings.type = 'button';
    settings.addEventListener('click', () => this.on.settings());
    // Steam: sign in (a link: Steam's own page, then back here), or who you are + sign out
    this.accountBox = el('div', 'home-account');
    const navEnd = el('div', 'home-nav-end');
    navEnd.append(this.pill, this.accountBox, settings);
    this.renderAccount();
    nav.append(brand, navEnd);

    // left: the pitch, the actions, join by code, the numbers
    const intro = el('div', 'home-intro');
    const eyebrow = el('p', 'home-eyebrow', 'CS2 Zombie Escape trainer');
    const h1 = el('h1', 'home-title');
    h1.append('Learn the lasers ', el('span', 'home-accent', 'before the server does.'));
    const lede = el('p', 'home-lede', 'Spawn where the lasers are. Each map’s own entity logic runs the stage, 1:1 with a CS2Fixes ZE server. Go solo, or bring a squad.');

    const actions = el('div', 'home-actions');
    this.findSub = el('span', 'ha-sub', 'Browse public rooms');
    actions.append(
      this.action('play', 'Play now', el('span', 'ha-sub', 'Solo practice on any stage'), () => this.on.play(), true),
      this.action('find', 'Find a lobby', this.findSub, () => this.on.find()),
      this.action('make', 'Make a lobby', el('span', 'ha-sub', 'Private room, invite by code'), () => this.on.make()),
    );

    const join = el('form', 'home-join');
    join.setAttribute('aria-label', 'Join a room by code');
    const code = el('input', 'hj-code');
    Object.assign(code, { type: 'text', maxLength: 4, placeholder: 'CODE', autocomplete: 'off', spellcheck: false, enterKeyHint: 'go' });
    code.setAttribute('autocapitalize', 'characters');
    code.setAttribute('aria-label', 'Room code, 4 letters');
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, ''); go.disabled = !ROOM_CODE.test(code.value); });
    const go = el('button', 'hj-go', 'Join');
    go.type = 'submit';
    go.disabled = true;
    join.addEventListener('submit', (ev) => { ev.preventDefault(); if (ROOM_CODE.test(code.value)) this.on.join(code.value); });
    join.append(el('span', 'hj-label', 'Have a code?'), code, go);

    this.numbers = el('dl', 'home-stats');
    intro.append(eyebrow, h1, lede, actions, join, this.numbers);

    // the maps strip
    const maps = el('section', 'home-maps');
    maps.setAttribute('aria-labelledby', 'home-maps-h');
    const mh = el('header', 'hm-head');
    const mt = el('h2', 'hm-title', 'Maps');
    mt.id = 'home-maps-h';
    this.mapCount = el('span', 'hm-count');
    const all = el('button', 'home-link', 'All maps');
    all.type = 'button';
    all.addEventListener('click', () => this.on.play());
    mh.append(mt, this.mapCount, el('span', 'grow'), all);
    const box = el('div', 'hs-box');
    box.setAttribute('aria-label', 'Maps, by their screenshots');
    this.strip = new Strip(box, { onPick: (name) => this.on.map(name), mapTitle: this.mapTitle });
    maps.append(mh, box);

    const main = el('main', 'home-main');
    main.append(intro, this.feed.root, maps);
    r.replaceChildren(backdrop, nav, main);
    this.stats(null);
  }

  action(kind, title, sub, onClick, primary = false) {
    const b = el('button', `home-action ha-${kind}${primary ? ' primary' : ''}`);
    b.type = 'button';
    const icon = el('span', 'ha-icon');
    icon.innerHTML = ICON[kind]; // a constant
    const text = el('span', 'ha-text');
    text.append(el('b', 'ha-title', title), sub);
    const arrow = el('span', 'ha-arrow');
    arrow.innerHTML = ARROW; // a constant
    b.append(icon, text, arrow);
    b.addEventListener('click', onClick);
    return b;
  }

  renderAccount() {
    const box = this.accountBox;
    if (!box) return;
    if (account.user) {
      const out = el('button', 'home-link', 'Sign out');
      out.type = 'button';
      out.addEventListener('click', () => signOut());
      // you: opens your profile (ui/profile.js)
      const who = el('button', 'home-who');
      who.type = 'button';
      who.title = 'Your profile';
      who.append(el('span', 'home-user', account.user.name));
      who.addEventListener('click', () => this.profile.show(account.user.steamId));
      // their Steam avatar (app/account.js checked the URL: Steam's CDN only); none without the server's Steam API key
      if (account.user.avatar) {
        const img = el('img', 'home-avatar');
        img.src = account.user.avatar; img.alt = ''; img.width = img.height = 28; img.referrerPolicy = 'no-referrer'; img.decoding = 'async';
        img.addEventListener('error', () => img.remove());
        who.prepend(img);
      }
      box.replaceChildren(who, out);
    } else {
      box.replaceChildren(steamButton({ size: 'small' }));
    }
  }

  setMaps(maps) {
    const shots = shotsOf(maps);
    this.backdrop.set(shots);
    this.strip.set(shots);
    this.mapCount.textContent = maps.length ? String(maps.length) : '';
    this.root.classList.toggle('no-shots', !shots.length);
  }

  // the server's numbers, or null when it can't be reached
  stats(s) {
    if (!this.pill) return; // the feed reports before build() has run
    this.pill.className = 'home-pill' + (s ? ' online' : '');
    this.pill.replaceChildren(el('i'), s ? `${s.online} online` : 'Offline');
    const cells = s ? [[s.online, 'online now'], [s.rooms, s.rooms === 1 ? 'open room' : 'open rooms'], [s.playing, 'in a round']] : [];
    this.numbers.replaceChildren(...cells.map(([n, label]) => { const d = el('div'); d.append(el('dt', null, label), el('dd', null, String(n))); return d; }));
    this.numbers.hidden = !s;
    this.findSub.textContent = s?.rooms ? `${s.rooms} open ${s.rooms === 1 ? 'room' : 'rooms'} right now` : 'Browse public rooms';
  }

  get open() { return !this.root.hidden; }

  // a player's profile, over the home page (a ?player=<SteamID64> link, a name in the feed, your account)
  showPlayer(steamId) {
    if (!this.open) this.show();
    this.profile.show(steamId);
  }

  show() {
    this.root.hidden = false;
    document.body.classList.add('at-home');
    document.getElementById('menu')?.setAttribute('inert', '');
    this.backdrop.start();
    this.strip.start();
    this.feed.start();
    this.root.scrollTop = 0;
    this.root.querySelector('.home-action.primary')?.focus({ preventScroll: true });
  }

  hide() {
    if (this.root.hidden) return;
    this.profile.close();
    this.root.hidden = true;
    document.body.classList.remove('at-home');
    document.getElementById('menu')?.removeAttribute('inert');
    this.backdrop.stop();
    this.strip.stop();
    this.feed.stop();
  }
}
