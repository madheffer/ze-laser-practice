// Browse rooms: the server's list of public rooms, for finding players without friends to invite. Refreshes
// every few seconds while it's open. Each row: name, mode, map, players / max, in lobby or playing what, and a
// warning when the room has cheats on. Everything shown came from other players: text only.
import { CHEAT_LABELS } from '../lib/room-rules.js';

const REFRESH_MS = 4000;

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

export class RoomBrowser {
  // net: CoopClient; onJoin(code); onBack(); mapTitle(name) -> display title
  constructor({ net, onJoin, onBack, onCreate, mapTitle }) {
    this.net = net;
    this.onJoin = onJoin;
    this.mapTitle = mapTitle;
    this.timer = 0;
    this.root = el('div', 'browse');
    const head = el('div', 'browse-head');
    const back = el('button', 'ghost', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => onBack());
    this.refreshBtn = el('button', 'ghost', 'Refresh');
    this.refreshBtn.type = 'button';
    this.refreshBtn.addEventListener('click', () => this.refresh());
    this.status = el('span', 'browse-status');
    head.append(el('h3', 'rf-title', 'Open rooms'), this.status, this.refreshBtn, back);
    this.list = el('ul', 'browse-list');
    this.list.setAttribute('aria-label', 'Public rooms');
    this.empty = el('div', 'browse-empty');
    this.empty.append(el('p', '', 'No public rooms right now.'));
    const make = el('button', 'primary', 'Create a public room');
    make.type = 'button';
    make.addEventListener('click', () => onCreate());
    this.empty.append(make);
    this.root.append(head, this.list, this.empty);
    net.on('list', (rooms) => this.show(rooms));
  }

  open() { this.refresh(); clearInterval(this.timer); this.timer = setInterval(() => { if (!document.hidden) this.refresh(); }, REFRESH_MS); }
  close() { clearInterval(this.timer); this.timer = 0; }
  get isOpen() { return !!this.timer; }

  refresh() {
    this.status.textContent = this.net.status === 'online' ? 'Updating…' : 'Connecting…';
    this.net.list();
  }

  show(rooms) {
    if (!this.isOpen) return;
    this.status.textContent = `${rooms.length} open · updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    this.empty.hidden = rooms.length > 0;
    this.list.replaceChildren(...rooms.map((r) => this.row(r)));
  }

  row(r) {
    const li = el('li', 'browse-row' + (r.playing ? ' playing' : ''));
    const main = el('div', 'br-main');
    const title = el('b', 'br-name', r.name);
    const tags = el('span', 'br-tags');
    tags.append(el('i', `badge ${r.kind}`, r.kind === 'versus' ? 'Versus' : 'Co-op'));
    if (r.cheats.length) {
      const c = el('i', 'badge cheat', 'Cheats on');
      c.title = r.cheats.map((k) => CHEAT_LABELS[k] || k).join(', ');
      tags.append(c);
    }
    main.append(title, tags);
    const sub = el('div', 'br-sub', [r.map ? this.mapTitle(r.map) : 'No map yet', r.playing ? `Playing ${r.stage || 'a stage'}` : 'In the lobby'].join(' · '));
    main.append(sub);
    const count = el('span', 'br-count', `${r.players}/${r.max}`);
    count.title = 'Players';
    const join = el('button', r.players >= r.max ? 'ghost' : 'primary', r.players >= r.max ? 'Full' : 'Join');
    join.type = 'button';
    join.disabled = r.players >= r.max;
    join.setAttribute('aria-label', `Join ${r.name}`);
    join.addEventListener('click', () => this.onJoin(r.code));
    li.append(main, count, join);
    return li;
  }
}
