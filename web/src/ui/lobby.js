// The co-op lobby, on the Play tab above the stage cards: your name, create / join a room by its 4-letter code
// (or an invite link, ?room=CODE), then the room: its code, the mode (Co-op / Versus, the host's pick), who's in
// it and Leave. In a room the host's stage pick starts the round for everyone; a guest's cards are dimmed.
import './lobby.css';
import { loadJson, saveJson } from '../lib/storage.js';
import { ROOM_CODE } from '../net/coop-client.js';

const KEY = 'lasers.coop';
const MODES = [
  { id: 'coop', label: 'Co-op', hint: 'Survive the stage together. If your friends go down, you can still clear it alone as the last one alive.' },
  { id: 'versus', label: 'Versus', hint: 'The same stage side by side: the last one alive wins (both clear it: fewer hits wins).' },
];

function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
const button = (label, cls, onClick) => { const b = el('button', cls, { type: 'button' }); b.textContent = label; b.addEventListener('click', onClick); return b; };

export class Lobby {
  // net: CoopClient; state: { kind, busy }; onKind(kind): the host changes the mode
  constructor(root, { net, state, onKind }) {
    this.root = root;
    this.net = net;
    this.state = state;
    this.onKind = onKind;
    const saved = loadJson(KEY);
    this.name = typeof saved.name === 'string' ? saved.name.slice(0, 20) : '';
    this.build();
    const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
    if (code && ROOM_CODE.test(code)) { this.code.value = code; this.join(); }
    this.render();
  }

  build() {
    const r = this.root;
    r.className = 'lobby';
    const head = el('div', 'lobby-head');
    const h = el('b'); h.textContent = 'Co-op';
    const sub = el('span', 'lobby-sub'); sub.textContent = 'Play a stage with friends: everyone sees the same lasers, and the kill feed shows who went down.';
    head.append(h, sub);

    // not in a room
    this.off = el('div', 'lobby-row');
    const nameLabel = el('label', 'lobby-field'); nameLabel.textContent = 'Name';
    this.nameIn = el('input', '', { type: 'text', maxlength: '20', placeholder: 'Player', autocomplete: 'nickname', spellcheck: 'false' });
    this.nameIn.value = this.name;
    this.nameIn.addEventListener('change', () => this.saveName());
    nameLabel.append(this.nameIn);
    this.code = el('input', 'code', { type: 'text', maxlength: '4', placeholder: 'CODE', 'aria-label': 'Room code', autocomplete: 'off', spellcheck: 'false' });
    this.code.addEventListener('input', () => { this.code.value = this.code.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    this.code.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') this.join(); });
    const or = el('span', 'or'); or.textContent = 'or';
    this.off.append(nameLabel, button('Create room', 'primary', () => { this.saveName(); this.net.create(this.name); }), or, this.code, button('Join', 'ghost', () => this.join()));

    // in a room
    this.on = el('div', 'lobby-row');
    this.codeOut = el('span', 'room-code');
    this.modes = el('div', 'seg', { role: 'radiogroup', 'aria-label': 'Mode' });
    this.modeBtns = MODES.map((m) => {
      const b = el('button', '', { type: 'button', role: 'radio', 'data-id': m.id, title: m.hint });
      b.textContent = m.label;
      b.addEventListener('click', () => this.onKind(m.id));
      this.modes.append(b);
      return b;
    });
    this.members = el('ul', 'members', { 'aria-label': 'Players in the room' });
    this.on.append(this.codeOut, button('Copy invite link', 'ghost', () => this.copyLink()), this.modes, this.members, button('Leave', 'ghost', () => this.net.leave()));

    this.hint = el('div', 'lobby-hint');
    this.noteEl = el('div', 'lobby-note', { role: 'status' });
    r.replaceChildren(head, this.off, this.on, this.hint, this.noteEl);
  }

  saveName() {
    this.name = this.nameIn.value.trim().slice(0, 20);
    saveJson(KEY, { name: this.name });
    this.net.rename(this.name);
  }

  join() {
    const code = this.code.value.trim().toUpperCase();
    if (!ROOM_CODE.test(code)) { this.note('A room code is 4 letters'); return; }
    this.saveName();
    this.net.join(this.name, code);
  }

  copyLink() {
    const room = this.net.room;
    if (!room) return;
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('room', room.code);
    const done = () => this.note('Invite link copied');
    const fail = () => this.note(`Invite link: ${url.href}`);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url.href).then(done, fail); else fail();
  }

  note(msg) {
    this.noteEl.textContent = msg;
    clearTimeout(this._noteT);
    this._noteT = setTimeout(() => { this.noteEl.textContent = ''; }, 6000);
  }

  render() {
    const { net, state } = this;
    const room = net.room;
    this.off.hidden = !!room;
    this.on.hidden = !room;
    const guest = !!room && !net.isHost;
    document.body.classList.toggle('mp-guest', guest);
    if (!room) {
      this.hint.textContent = net.status === 'connecting' ? 'Connecting…' : '';
      return;
    }
    this.codeOut.replaceChildren('Room ', Object.assign(el('b'), { textContent: room.code }));
    for (const b of this.modeBtns) {
      const on = b.dataset.id === state.kind;
      b.setAttribute('aria-checked', String(on));
      b.disabled = guest;
    }
    this.members.replaceChildren(...room.members.map((m) => {
      const li = el('li', m.id === room.host ? 'host' : '');
      li.textContent = m.name + (m.id === net.you ? ' (you)' : '');
      if (m.id === room.host) li.title = 'Host: picks the stage';
      return li;
    }));
    const mode = MODES.find((m) => m.id === state.kind) || MODES[0];
    this.hint.textContent = state.busy ? 'A round is on: you\'ll be in the next one.'
      : guest ? `The host picks the stage. ${mode.hint}` : `Pick a stage: everyone in the room starts it with you. ${mode.hint}`;
  }
}
