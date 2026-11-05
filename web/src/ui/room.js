// The room screen: where a co-op / versus room waits between rounds. Everything on one page:
//   left   the room code, big, with Copy code / Copy invite link; the players (empty slots wait for more to join;
//          the owner can remove someone; everyone's simulated ping); your name and your own ping; the room's rules
//   right  the map + stage picker (ui/room-picker.js): the owner picks, everyone sees the pick
//   bottom the next round (map, stage, Normal / Endless) and Start round (owner) or who it waits for (the rest)
// It shows whenever you are in a room and no round of yours is loading or running (and no end card is up), so
// creating or joining a room lands here, and so does the end of a round. Settings (Game | Room tabs,
// ui/settings-panel.js) open in a sheet over it. Names and room text come from the server: textContent only.
import './room.css';
import { S, G } from '../app/state.js';
import { cheatsOn, CHEAT_LABELS } from '../lib/room-rules.js';
import { SettingsPanel } from './settings-panel.js';
import { settings } from '../app/settings.js';
import { $ } from '../lib/dom.js';
import { fillSlider } from './controls.js';
import { RoomPicker } from './room-picker.js';
import { displayName } from './maps.js';

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }
function btn(label, cls, onClick, title) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  b.addEventListener('click', onClick);
  return b;
}

const SYNC_MS = 250;

export class RoomScreen {
  // net: CoopClient; lobby: ui/lobby.js's Lobby (your name, saved room settings); hasHeal(): the picked map has a heal
  constructor(root, { net, lobby, hasHeal = () => false }) {
    this.root = root;
    this.net = net;
    this.lobby = lobby;
    this.hasHeal = hasHeal;
    this.away = false; // the menu's lobby strip is open instead (its Back to room button comes back)
    // Settings (Game | Room): one panel, in the menu's Settings tab or this screen's sheet
    this.panel = new SettingsPanel({ net, lobby, hasHeal });
    // the menu's lobby strip: Room settings opens the menu's Settings tab on Room
    lobby.onRoomSettings = () => { G.menu.selectTab($('#tab-settings')); this.panel.show('room'); G.menu.update(); };
    this.picker = new RoomPicker({ maps: () => S.mapIndex, onPick: (map, stage) => this.pickStage(map, stage) });
    this.build();
    net.on('room', () => this.sync());
    net.on('left', () => { this.away = false; this.closeDialog(); this.pingSent = null; this.sync(); });
    // your simulated ping, to the room (everyone sees it next to your name): when you join and whenever it changes,
    // from here or from the Game settings (app/settings.js owns the value)
    net.on('room', (room, prev) => { if (room && room.code !== prev?.code) this.sendPing(true); });
    document.addEventListener('input', (ev) => { if (ev.target?.id === 'ping' || ev.target?.id === 'ping-num') this.sendPing(); }, true);
    document.addEventListener('change', (ev) => { if (ev.target?.id === 'ping-num') this.sendPing(); }, true);
    // Esc closes the settings sheet; a click on the dim backdrop too
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && this.open && !this.dialog.hidden) { ev.preventDefault(); ev.stopPropagation(); this.closeDialog(); } }, true);
    net.on('status', () => this.sync());
    setInterval(() => this.sync(), SYNC_MS); // rounds, the loading screen and end cards come and go around it
  }

  build() {
    const r = this.root;
    r.className = 'room sheet';
    r.hidden = true;
    r.setAttribute('role', 'region');
    r.setAttribute('aria-label', 'Room');

    const head = el('header', 'rm-head');
    this.leaveBtn = btn('Leave', 'ghost rm-leave', () => this.net.leave(), 'Leave the room');
    const title = el('div', 'rm-title');
    this.nameEl = el('h1', 'rm-name');
    this.badges = el('div', 'rm-badges');
    title.append(this.nameEl, this.badges);
    this.settingsBtn = btn('Settings', 'ghost rm-settings-btn', () => this.openSettings(), 'Settings: the room (host) and your own');
    head.append(this.leaveBtn, title, el('span', 'grow'), this.settingsBtn);

    // left: code, players, you, rules
    const side = el('aside', 'rm-side');
    const codeCard = el('section', 'rm-code');
    codeCard.append(el('span', 'rm-code-label', 'Room code'));
    this.codeEl = el('div', 'rm-code-big');
    this.codeEl.setAttribute('aria-live', 'polite');
    const copyRow = el('div', 'rm-code-btns');
    this.copyCode = btn('Copy code', 'primary', () => this.copy('code'));
    this.copyLink = btn('Copy invite link', 'ghost', () => this.copy('link'));
    copyRow.append(this.copyCode, this.copyLink);
    codeCard.append(this.codeEl, copyRow, el('p', 'rm-code-hint', 'Friends type it under “Have a code?” on the home page, or open the link.'));

    const players = el('section', 'rm-players');
    this.countEl = el('span', 'rm-count');
    const ph = el('h2', null, 'Players ');
    ph.append(this.countEl);
    this.slots = el('ol', 'rm-slots');
    const you = el('label', 'rm-you');
    you.append(el('span', null, 'Your name'));
    this.nameIn = el('input');
    Object.assign(this.nameIn, { type: 'text', maxLength: 20, placeholder: 'Player', autocomplete: 'nickname', spellcheck: false });
    this.nameIn.addEventListener('change', () => { this.lobby.nameIn.value = this.nameIn.value; this.lobby.saveName(); this.nameIn.value = this.lobby.name; });
    you.append(this.nameIn);
    // your simulated ping (Settings → Game → Simulated ping, the same value): everyone plays with their own
    const ping = el('label', 'rm-ping');
    const pingTop = el('span', 'rm-ping-top');
    this.pingOut = el('output', 'rm-ping-v');
    pingTop.append(el('span', null, 'Your simulated ping'), this.pingOut);
    this.pingIn = el('input');
    Object.assign(this.pingIn, { type: 'range', min: 0, max: 500, step: 5 });
    this.pingIn.setAttribute('aria-label', 'Your simulated ping in milliseconds');
    this.pingIn.addEventListener('input', () => this.setPing(Number(this.pingIn.value)));
    ping.append(pingTop, this.pingIn, el('small', null, 'The lasers reach you this late, like on a server. Only you see it; the others set their own.'));
    players.append(ph, this.slots, you, ping);

    const rules = el('section', 'rm-rules');
    rules.append(el('h2', null, 'Rules'));
    this.chips = el('ul', 'rule-chips');
    rules.append(this.chips);
    side.append(codeCard, players, rules);

    // right: the picker
    const main = el('section', 'rm-main');
    main.append(el('h2', 'rm-main-title', 'Next round'), this.picker.root);

    // bottom: the next round + start
    const foot = el('footer', 'rm-foot');
    this.nextEl = el('div', 'rm-next');
    this.modeBox = el('div', 'seg rm-mode');
    this.modeBox.setAttribute('role', 'radiogroup');
    this.modeBox.setAttribute('aria-label', 'Mode');
    this.modeBtns = ['normal', 'endless'].map((m) => {
      const b = btn(m === 'normal' ? 'Normal' : 'Endless ∞', '', () => this.setMode(m));
      b.setAttribute('role', 'radio');
      b.dataset.mode = m;
      this.modeBox.append(b);
      return b;
    });
    this.waitEl = el('span', 'rm-wait');
    this.startBtn = btn('Start round', 'primary rm-start', () => this.start());
    foot.append(this.nextEl, this.modeBox, el('span', 'grow'), this.waitEl, this.startBtn);

    this.toast = el('div', 'rm-toast');
    this.toast.setAttribute('role', 'status');
    this.dialog = el('div', 'rm-dialog');
    this.dialog.hidden = true;
    this.dialog.addEventListener('click', (ev) => { if (ev.target === this.dialog) this.closeDialog(); });
    r.replaceChildren(head, side, main, foot, this.toast, this.dialog);
  }

  get open() { return !this.root.hidden; }

  // Should it show? In a room, nothing of yours loading or running, no end card, not away in the full menu.
  sync() {
    const room = this.net.room;
    const roundOn = !!(S.mp && !S.mp.ended) || !!G.loading?.isOpen;
    const show = !!room && !roundOn && !G.overlay?.open && !this.away;
    if (show !== this.open) {
      this.root.hidden = !show;
      document.body.classList.toggle('in-room-screen', show);
      if (show) {
        G.home?.hide();
        if (document.pointerLockElement) document.exitPointerLock?.();
        if (!S.paused) G.pause();
      }
      G.menu?.update();
    }
    if (show) this.render();
  }

  // back from the full menu (its "Room" button, ui/lobby.js)
  comeBack() { this.away = false; this.sync(); }

  render() {
    const { net } = this;
    const room = net.room;
    if (!room) return;
    const s = room.settings;
    const host = net.isHost;
    const owner = net.member(room.owner);
    this.nameEl.textContent = s.name || `${owner?.name || 'Someone'}'s room`;
    this.badges.replaceChildren(
      el('i', `badge ${s.public ? 'public' : 'private'}`, s.public ? 'Public' : 'Private'),
      el('i', `badge ${s.kind}`, s.kind === 'versus' ? 'Versus' : 'Co-op'));
    if (this.codeEl.textContent !== room.code) this.codeEl.textContent = room.code;
    if (document.activeElement !== this.nameIn) this.nameIn.value = this.lobby.name;
    if (document.activeElement !== this.pingIn) { this.pingIn.value = settings.ping; fillSlider(this.pingIn); }
    this.pingOut.textContent = `${settings.ping} ms`;

    // players: the members, then empty slots up to the room's size
    this.countEl.textContent = `${room.members.length}/${s.max}`;
    const key = JSON.stringify([room.members, room.owner, host, s.max]);
    if (key !== this.slotKey) {
      this.slotKey = key;
      const rows = room.members.map((m) => {
        const li = el('li', `rm-slot${m.id === room.owner ? ' owner' : ''}${m.id === net.you ? ' you' : ''}`);
        li.append(el('span', 'rm-avatar', (m.name || '?').slice(0, 1).toUpperCase()), el('span', 'rm-pname', m.name));
        li.append(el('span', `rm-ms${m.ping ? '' : ' zero'}`, `${m.ping || 0} ms`));
        if (m.id === room.owner) li.append(el('span', 'rm-tag owner', 'Host'));
        if (m.id === net.you) li.append(el('span', 'rm-tag', 'You'));
        if (host && m.id !== net.you) li.append(btn('✕', 'rm-kick', () => { if (confirm(`Remove ${m.name} from the room?`)) net.kick(m.id); }, `Remove ${m.name}`));
        return li;
      });
      for (let i = room.members.length; i < s.max; i++) {
        const li = el('li', 'rm-slot empty');
        li.append(el('span', 'rm-avatar'), el('span', 'rm-pname', 'Waiting for a player…'));
        rows.push(li);
      }
      this.slots.replaceChildren(...rows);
    }

    // rules
    const r = s.rules;
    const chips = [
      [`${r.humans} humans`], [`Boss HP ${r.bossHp}%`], [r.autoFire ? (r.perfectTeam ? 'Perfect team' : 'Team fires') : 'No team fire'],
      [r.fallDamage ? 'Fall damage' : 'No fall damage'], [`Up to ${s.max} players`],
      ...(!this.hasHeal() ? [] : r.heal === 'all' ? [['Heal: everyone their own']] : r.heal === 'random' ? [['Heal: a random player']]
        : typeof r.heal === 'number' ? [[`Heal: ${net.member(r.heal)?.name || 'nobody (left)'}`]] : []),
      ...cheatsOn(r).map((k) => [CHEAT_LABELS[k], 'cheat']),
    ];
    if (!cheatsOn(r).length) chips.push(['No cheats', 'clean']);
    const ck = JSON.stringify(chips);
    if (ck !== this.chipKey) { this.chipKey = ck; this.chips.replaceChildren(...chips.map(([t, cls]) => el('li', cls || '', t))); }

    // the picker and the next round
    const next = room.next;
    this.picker.set(next ? { map: next.map, stage: next.stage } : null, host);
    const mapTitle = next ? displayName(S.mapIndex.find((m) => m.name === next.map)?.title || next.map) : '';
    this.nextEl.replaceChildren();
    if (next) {
      this.nextEl.append(el('span', 'rm-next-label', 'Next'), el('b', null, next.stageName), el('span', 'rm-next-map', mapTitle));
    } else {
      this.nextEl.append(el('span', 'rm-next-label', 'Next'), el('span', 'rm-next-none', host ? 'Pick a map and a stage' : `${owner?.name || 'The host'} is picking a stage`));
    }
    this.modeBox.hidden = !next?.endless;
    for (const b of this.modeBtns) { b.setAttribute('aria-checked', String(b.dataset.mode === (next?.mode || 'normal'))); b.disabled = !host; }

    const busy = room.round && !room.round.ids.includes(net.you);
    const alone = room.members.length < 2;
    this.startBtn.hidden = !host;
    this.startBtn.disabled = !next || !!busy || net.status !== 'online';
    this.startBtn.textContent = alone ? 'Start alone' : 'Start round';
    this.waitEl.textContent = net.status !== 'online' ? 'Reconnecting to the server…'
      : busy ? `A round is on (${room.round.stage || 'a stage'}): you'll be in the next one`
        : host ? (alone ? 'Waiting for players to join… or start alone' : `${room.members.length} players ready to go`)
          : `Waiting for ${owner?.name || 'the host'} to start`;
  }

  pickStage(map, stage) {
    const prev = this.net.room?.next;
    const mode = prev?.map === map && prev?.stage === stage ? prev.mode : 'normal';
    this.net.pick(map, stage, mode);
  }

  setMode(mode) {
    const next = this.net.room?.next;
    if (next && this.net.isHost) this.net.pick(next.map, next.stage, mode);
  }

  start() {
    const next = this.net.room?.next;
    if (!next || !this.net.isHost) return;
    // the click is a user gesture: take the mouse + fullscreen now, the round's loading screen covers the rest
    G.enterGame?.();
    this.net.start(next.map, next.stage, next.mode);
  }

  copy(what) {
    const room = this.net.room;
    if (!room) return;
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('room', room.code);
    const value = what === 'code' ? room.code : url.href;
    const b = what === 'code' ? this.copyCode : this.copyLink;
    const label = what === 'code' ? 'Copy code' : 'Copy invite link';
    const done = () => { b.textContent = 'Copied ✓'; b.classList.add('copied'); setTimeout(() => { b.textContent = label; b.classList.remove('copied'); }, 1500); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(done, () => this.say(value));
    else this.say(value);
  }

  say(msg) {
    this.toast.textContent = msg;
    this.toast.classList.add('on');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => this.toast.classList.remove('on'), 5000);
  }

  // Settings in a sheet over the room: Game | Room tabs (ui/settings-panel.js, borrowed from the menu). The host
  // lands on Room, everyone else on Game. Leave it with the close button, Esc or a click outside.
  openSettings() {
    this.dialog.replaceChildren();
    const box = el('div', 'rm-dialog-box rm-settings');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Settings');
    const head = el('div', 'rm-settings-head');
    head.append(el('h2', null, 'Settings'), btn('✕', 'rm-close', () => this.closeDialog(), 'Close settings'));
    const body = el('div', 'rm-settings-body');
    box.append(head, body);
    this.dialog.append(box);
    this.dialog.hidden = false;
    this.panel.mountIn(body);
    this.panel.show(this.net.isHost ? 'room' : 'game');
    head.querySelector('.rm-close').focus();
  }

  closeDialog() {
    if (this.dialog.hidden) return;
    this.panel.mountHome();
    this.dialog.hidden = true;
    this.dialog.replaceChildren();
  }

  // your ping: through the Game settings' own slider, so it is saved and applied exactly as there (app/settings.js)
  setPing(ms) {
    const r = $('#ping');
    if (!r) return;
    r.value = String(ms);
    r.dispatchEvent(new Event('input', { bubbles: true }));
    this.pingOut.textContent = `${settings.ping} ms`;
  }

  // the room sees your ping (shortly after you stop moving the slider)
  sendPing(now = false) {
    clearTimeout(this.pingT);
    const go = () => { if (this.net.room && this.pingSent !== settings.ping) { this.pingSent = settings.ping; this.net.setPing(settings.ping); } };
    if (now) go(); else this.pingT = setTimeout(go, 250);
  }
}

