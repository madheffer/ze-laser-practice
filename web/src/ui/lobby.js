// The multiplayer lobby, on the Play tab over the map list and the stage list. Its views:
//   home    your name; Create room (made at once with your last settings), Browse rooms, or join by a 4-letter
//           code (an invite link ?room=CODE fills it)
//   browse  the public room list (ui/lobby-browse.js)
//   room    a strip for the room you're in (Back to room, invite link, Room settings, Leave); the room itself lives
//           on the room screen (ui/room.js), which shows between rounds
//   edit    the room settings form (ui/lobby-form.js), for the owner
// In a room the owner's stage pick here becomes the room's next round; the others' stage cards are dimmed.
import './lobby.css';
import { loadJson, saveJson } from '../lib/storage.js';
import { ROOM_CODE } from '../net/coop-client.js';
import { cleanSettings, cleanText, cheatsOn, CHEAT_LABELS, SETTINGS_DEFAULTS, RULE_DEFAULTS } from '../lib/room-rules.js';
import { roomForm } from './lobby-form.js';
import { RoomBrowser } from './lobby-browse.js';

const KEY = 'lasers.coop'; // { name, room: last room settings you created }

function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
const text = (tag, cls, t) => { const e = el(tag, cls); e.textContent = t; return e; };
const button = (label, cls, onClick, attrs = {}) => { const b = el('button', cls, { type: 'button', ...attrs }); b.textContent = label; b.addEventListener('click', onClick); return b; };

export class Lobby {
  // net: CoopClient; state: { busy }; getMap(): the map loaded now; mapTitle(name): its display title; hasHeal(): the
  // loaded map has a heal a human can carry (the Heal picker shows only then)
  // onRoomScreen(): back to the room screen (ui/room.js)
  constructor(root, { net, state, getMap = () => '', mapTitle = (n) => n, hasHeal = () => false, onRoomScreen = () => {} }) {
    this.onRoomScreen = onRoomScreen;
    this.root = root;
    this.net = net;
    this.state = state;
    this.getMap = getMap;
    this.mapTitle = mapTitle;
    this.hasHeal = hasHeal;
    const saved = loadJson(KEY);
    this.name = cleanText(saved.name, 20);
    this.lastSettings = cleanSettings(saved.room && typeof saved.room === 'object' ? saved.room : { ...SETTINGS_DEFAULTS, rules: RULE_DEFAULTS });
    this.view = 'home';
    this.browser = new RoomBrowser({ net, mapTitle, onJoin: (code) => this.joinCode(code), onBack: () => this.go('home'), onCreate: () => this.openCreate(true) });
    this.build();
    const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
    if (code && ROOM_CODE.test(code)) this.joinCode(code);
    this.render();
  }

  build() {
    const r = this.root;
    r.className = 'lobby';
    const head = el('div', 'lobby-head');
    head.append(text('b', '', 'Multiplayer'), text('span', 'lobby-sub', 'Co-op or versus on any stage, on our server: same lasers for everyone, a kill feed, and the server keeps the score.'));
    this.dot = el('span', 'net-dot', { 'aria-hidden': 'true' });
    head.append(this.dot);

    // home
    this.home = el('div', 'lobby-row');
    const nameLabel = el('label', 'lobby-field');
    nameLabel.append('Your name');
    this.nameIn = el('input', '', { type: 'text', maxlength: '20', placeholder: 'Player', autocomplete: 'nickname', spellcheck: 'false' });
    this.nameIn.value = this.name;
    this.nameIn.addEventListener('change', () => this.saveName());
    nameLabel.append(this.nameIn);
    this.code = el('input', 'code', { type: 'text', maxlength: '4', placeholder: 'CODE', 'aria-label': 'Room code', autocomplete: 'off', spellcheck: 'false' });
    this.code.addEventListener('input', () => { this.code.value = this.code.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    this.code.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') this.joinCode(this.code.value); });
    const joinBox = el('span', 'join-box');
    joinBox.append(this.code, button('Join', 'ghost', () => this.joinCode(this.code.value)));
    this.home.append(nameLabel, button('Create room', 'primary', () => this.openCreate(false)), button('Browse rooms', 'ghost', () => this.go('browse')), text('span', 'or', 'or join by code'), joinBox);

    // create / edit (filled when opened)
    this.formBox = el('div', 'form-box');

    // room
    this.roomBox = el('div', 'room-box');
    const top = el('div', 'lobby-row room-top');
    this.roomName = el('b', 'room-name');
    this.codeOut = el('span', 'room-code', { title: 'Room code' });
    this.badges = el('span', 'room-badges');
    this.ownerBtns = el('span', 'owner-btns');
    this.ownerBtns.append(button('Room settings', 'ghost', () => this.openEdit()));
    top.append(this.roomName, this.codeOut, this.badges, el('span', 'grow'), button('Back to room', 'primary', () => this.onRoomScreen()), button('Copy invite link', 'ghost', () => this.copyLink()), this.ownerBtns, button('Leave', 'ghost', () => this.net.leave()));
    this.rules = el('ul', 'rule-chips', { 'aria-label': 'Room rules' });
    this.members = el('ul', 'members', { 'aria-label': 'Players in the room' });
    this.roomBox.append(top, this.members, this.rules);

    this.hint = el('div', 'lobby-hint');
    this.noteEl = el('div', 'lobby-note', { role: 'status' });
    r.replaceChildren(head, this.home, this.formBox, this.browser.root, this.roomBox, this.hint, this.noteEl);
  }

  saveName() {
    this.name = cleanText(this.nameIn.value, 20);
    this.nameIn.value = this.name;
    saveJson(KEY, { name: this.name, room: this.lastSettings });
    this.net.rename(this.name);
  }

  go(view) {
    if (this.view === 'browse' && view !== 'browse') this.browser.close();
    this.view = view;
    if (view === 'browse') this.browser.open();
    this.render();
  }

  joinCode(raw) {
    const code = String(raw || '').trim().toUpperCase();
    if (!ROOM_CODE.test(code)) { this.note('A room code is 4 letters'); return; }
    this.saveName();
    this.net.join(this.name, code);
  }

  // remembered for the next room you make (localStorage)
  rememberSettings(s) { this.lastSettings = s; saveJson(KEY, { name: this.name, room: s }); }

  // Make a room at once with your last settings (the room screen, ui/room.js, takes over and changes them there)
  createNow(isPublic = false) {
    this.saveName();
    const s = isPublic ? { ...this.lastSettings, public: true } : this.lastSettings;
    this.net.create(this.name, s, this.getMap());
  }

  openCreate(isPublic) { this.createNow(isPublic); }

  openEdit() {
    const room = this.net.room;
    if (!room || !this.net.isHost) return;
    this.formBox.replaceChildren(roomForm(room.settings, {
      mode: 'edit', ownerName: this.net.member(room.owner)?.name, members: room.members.length, players: room.members, heal: this.hasHeal(),
      onSubmit: (s) => { this.lastSettings = s; saveJson(KEY, { name: this.name, room: s }); this.net.setSettings(s); this.go('room'); },
      onCancel: () => this.go('room'),
    }));
    this.go('edit');
  }

  copyLink() {
    const room = this.net.room;
    if (!room) return;
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('room', room.code);
    const fail = () => this.note(`Invite link: ${url.href}`);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url.href).then(() => this.note('Invite link copied'), fail); else fail();
  }

  note(msg) {
    this.noteEl.textContent = msg;
    clearTimeout(this._noteT);
    this._noteT = setTimeout(() => { this.noteEl.textContent = ''; }, 6000);
  }

  render() {
    const { net, state } = this;
    const room = net.room;
    // in a room the room view shows (unless the owner is editing); out of one, home / create / browse
    if (room && !['room', 'edit'].includes(this.view)) { if (this.view === 'browse') this.browser.close(); this.view = 'room'; }
    if (!room && ['room', 'edit'].includes(this.view)) this.view = 'home';
    const v = this.view;
    this.home.hidden = v !== 'home';
    this.formBox.hidden = v !== 'create' && v !== 'edit';
    this.browser.root.hidden = v !== 'browse';
    this.roomBox.hidden = v !== 'room';
    this.dot.className = `net-dot ${net.status}`;
    this.dot.title = net.status === 'online' ? 'Connected to the co-op server' : net.status === 'connecting' ? 'Connecting…' : 'Not connected';
    const guest = !!room && !net.isHost;
    document.body.classList.toggle('mp-guest', guest);
    document.body.classList.toggle('mp-room', !!room);
    if (!room) {
      this.hint.textContent = v === 'home' ? (net.status === 'connecting' ? 'Connecting…' : 'Rooms are private unless you make them public; public rooms show up under Browse rooms.') : '';
      return;
    }
    const s = room.settings;
    const owner = net.member(room.owner);
    this.roomName.textContent = s.name || `${owner?.name || 'Someone'}'s room`;
    this.codeOut.replaceChildren('Code ', text('b', '', room.code));
    this.badges.replaceChildren(
      text('i', `badge ${s.public ? 'public' : 'private'}`, s.public ? 'Public' : 'Private'),
      text('i', `badge ${s.kind}`, s.kind === 'versus' ? 'Versus' : 'Co-op'),
      text('i', 'badge count', `${room.members.length}/${s.max}`));
    this.ownerBtns.hidden = guest;
    this.members.replaceChildren(...room.members.map((m) => {
      const li = el('li', m.id === room.owner ? 'owner' : '');
      li.append(text('span', '', m.name + (m.id === net.you ? ' (you)' : '')));
      if (m.id === room.owner) li.title = 'Room owner: picks the stage and the settings';
      if (!guest && m.id !== net.you) li.append(button('✕', 'kick', () => { if (confirm(`Remove ${m.name} from the room?`)) net.kick(m.id); }, { 'aria-label': `Remove ${m.name}`, title: 'Remove from the room' }));
      return li;
    }));
    const r = s.rules;
    const chips = [
      [`${r.humans} humans`], [`Boss HP ${r.bossHp}%`], [r.autoFire ? (r.perfectTeam ? 'Perfect team' : 'Team fires') : 'No team fire'],
      [r.fallDamage ? 'Fall damage' : 'No fall damage'],
      ...(!this.hasHeal() ? [] : r.heal === 'all' ? [['Heal: everyone their own']] : r.heal === 'random' ? [['Heal: a random player']]
        : typeof r.heal === 'number' ? [[`Heal: ${net.member(r.heal)?.name || 'nobody (left)'}`]] : []),
      ...cheatsOn(r).map((k) => [CHEAT_LABELS[k], 'cheat']),
    ];
    if (!cheatsOn(r).length) chips.push(['No cheats', 'clean']);
    this.rules.replaceChildren(...chips.map(([t, cls]) => text('li', cls || '', t)));
    const kindHint = s.kind === 'versus' ? 'Versus: last one alive wins.' : 'Co-op: survive together, or clear it alone as the last one alive.';
    this.hint.textContent = state.busy ? `A round is on (${room.round?.stage || 'a stage'}): you'll be in the next one.`
      : guest ? `${owner?.name || 'The owner'} picks the stage. ${kindHint}` : `A stage you pick here becomes the room's next round (Start it on the room screen). ${kindHint}`;
  }
}
