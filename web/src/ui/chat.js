// The chat window, CS2's CSGOHudChat (layout/hud/hudchat.vxml, styles/hud/hudchat.vcss): bottom-left, 553 px wide,
// 327 px of history in Stratum2 bold 18, a 48 px entry row ("Say to all" / "Say to team", "Send").
// Closed, only the newest lines show over the game and each fades after LINE_MS; open, the whole history shows on its
// dark panel. Lines carry CS2 chat colour codes (lib/chat-colors.js); everything is text, never HTML.
//
//   const chat = new ChatWindow(root, { onSend(text, team) })
//   chat.add(line)            // a finished line: "\x07CONSOLE:\x04 ***Laser***"
//   chat.open(team) / chat.close() / chat.isOpen
import './chat.css';
import { chatRuns, MAX_CHAT } from '../lib/chat-colors.js';

// No chat-time cvar in CS2's client.dll; CS:GO's hud_saytext_time was 12 s.
const LINE_MS = 12000;
const HISTORY = 100;

export class ChatWindow {
  constructor(root, { onSend } = {}) {
    this.root = root;
    this.onSend = onSend;
    this.team = false;
    root.className = 'chat';
    root.innerHTML = `
      <div class="chat-fg">
        <div class="chat-history" aria-live="polite"></div>
        <form class="chat-entry" autocomplete="off">
          <input class="chat-input" type="text" spellcheck="false" maxlength="${MAX_CHAT}" aria-label="Chat">
          <button class="chat-send" type="submit">Send</button>
        </form>
      </div>`;
    this.history = root.querySelector('.chat-history');
    this.form = root.querySelector('.chat-entry');
    this.input = root.querySelector('.chat-input');
    this.form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = this.input.value;
      this.input.value = '';
      this.close();
      if (text.trim()) this.onSend?.(text, this.team);
    });
    this.input.addEventListener('input', () => this.form.classList.toggle('has-input', !!this.input.value));
  }

  get isOpen() { return this.root.classList.contains('open'); }

  add(line) {
    const row = document.createElement('div');
    row.className = 'chat-line';
    for (const [text, color] of Array.isArray(line) ? line : chatRuns(line)) {
      const s = document.createElement('span');
      s.textContent = text;
      s.style.color = color;
      row.append(s);
    }
    this.history.append(row);
    while (this.history.childElementCount > HISTORY) this.history.firstElementChild.remove();
    this.history.scrollTop = this.history.scrollHeight;
    row.timer = setTimeout(() => { row.classList.add('old'); }, LINE_MS);
  }

  open(team = false) {
    this.team = team;
    this.input.placeholder = team ? 'Say to team' : 'Say to all'; // SFUI_Settings_Chat_Say / _SayTeam
    this.root.classList.add('open');
    this.history.scrollTop = this.history.scrollHeight;
    this.input.focus({ preventScroll: true });
  }

  close() {
    this.root.classList.remove('open');
    this.input.blur();
  }

  clear() { this.history.replaceChildren(); }
}
