// The room screen's chat (ui/room.js): the room's own chat channel (server/coop-chat.js, CS2Fixes' flood limits),
// the same lines the in-game chat shows (app/chat.js), so what is said in a round is here between rounds and the
// reverse. The last MAX_LINES are kept for the room; joining another room starts a fresh log.
// Names and text come from other players: cleaned, then textContent only.
import { cleanChat, cleanChatName } from '../lib/chat-colors.js';

const MAX_LINES = 100;
const MAX_LEN = 127; // server/coop-chat.js cleanChat's cap

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

export class RoomChat {
  constructor({ net }) {
    this.net = net;
    this.code = null;
    this.root = el('section', 'rm-chat');
    this.root.append(el('h2', null, 'Chat'));
    this.log = el('ol', 'rm-chat-log');
    this.log.setAttribute('aria-live', 'polite');
    this.log.setAttribute('aria-label', 'Room chat');
    const form = el('form', 'rm-chat-form');
    this.input = el('input');
    Object.assign(this.input, { type: 'text', maxLength: MAX_LEN, placeholder: 'Say something…', autocomplete: 'off', spellcheck: false });
    this.input.setAttribute('aria-label', 'Chat message');
    const send = el('button', 'primary', 'Send');
    send.type = 'submit';
    form.append(this.input, send);
    form.addEventListener('submit', (ev) => { ev.preventDefault(); this.send(); });
    // the game's keys stay out of the box (input.js listens on the document)
    this.input.addEventListener('keydown', (ev) => ev.stopPropagation());
    this.root.append(this.log, form);
    net.on('chat', (m) => this.onChat(m));
    net.on('room', (room) => { if (room?.code !== this.code) { this.code = room?.code ?? null; this.log.replaceChildren(); } });
  }

  send() {
    const text = cleanChat(this.input.value);
    if (!text || !this.net.room) return;
    this.net.chat(text); // the server echoes it back to everyone, us included
    this.input.value = '';
  }

  onChat(m) {
    if (m.flood) { this.line(null, 'You are flooding the server!', 'note'); return; }
    const text = cleanChat(m.text);
    if (!text) return;
    const name = cleanChatName(m.name) + (m.dead ? ' [DEAD]' : '');
    this.line(name, text, m.id === this.net.you ? 'me' : '');
  }

  line(name, text, cls) {
    const li = el('li', cls || null);
    if (name) li.append(el('b', null, name), ': ');
    li.append(text);
    const atEnd = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 24;
    this.log.append(li);
    while (this.log.children.length > MAX_LINES) this.log.firstChild.remove();
    if (atEnd) this.log.scrollTop = this.log.scrollHeight; // stay at the newest unless you scrolled up to read
  }
}
