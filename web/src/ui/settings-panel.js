// Settings, in one place with two tabs:
//   Game  your own settings (index.html's settings grid, bound by app/settings.js): sensitivity, ping, video, audio
//   Room  the room's settings (ui/lobby-form.js): the owner edits them, everyone else sees them read-only.
//         Only there while you are in a room.
// The panel lives in the menu's Settings tab, and the room screen (ui/room.js) borrows it into its settings sheet; the
// same DOM moves between the two (the settings stay bound by id), and it is never in both places at once.
import { $ } from '../lib/dom.js';
import { cleanName } from '../lib/room-rules.js';
import { roomForm } from './lobby-form.js';
import { fillSliders } from './controls.js';

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

export class SettingsPanel {
  // net: CoopClient; lobby: ui/lobby.js's Lobby (remembers room settings); hasHeal(): the room's map has a heal
  constructor({ net, lobby, hasHeal = () => false, ultima = () => null }) {
    this.net = net;
    this.lobby = lobby;
    this.hasHeal = hasHeal;
    this.ultima = ultima; // the room's map's ultima item (world/items.js), or null
    this.home = $('#panel-settings');
    this.view = 'game';
    this.dirty = false;

    this.root = el('div', 'sp');
    this.bar = el('div', 'sp-tabs');
    this.bar.setAttribute('role', 'tablist');
    this.bar.setAttribute('aria-label', 'Settings');
    this.tabs = {};
    for (const [k, label] of [['game', 'Game'], ['room', 'Room']]) {
      const b = el('button', 'sp-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.show(k));
      this.tabs[k] = b;
      this.bar.append(b);
    }
    this.game = el('div', 'sp-pane');
    this.game.append(...this.home.childNodes); // the settings grid, still bound by id
    this.room = el('div', 'sp-pane sp-room');
    this.roomNote = el('p', 'sp-note');
    this.roomBody = el('div');
    this.room.append(this.roomNote, this.roomBody);
    this.root.append(this.bar, this.game, this.room);
    this.home.append(this.root);
    net.on('room', () => this.sync());
    net.on('left', () => this.sync());
    this.sync();
    this.show('game');
  }

  // into the room screen's sheet, or back home to the menu's Settings tab
  mountIn(container) { container.append(this.root); fillSliders(this.root); }
  mountHome() { this.home.append(this.root); }

  show(view) {
    if (view === 'room' && !this.net.room) view = 'game';
    this.view = view;
    for (const [k, b] of Object.entries(this.tabs)) {
      b.setAttribute('aria-selected', String(k === view));
      b.tabIndex = k === view ? 0 : -1;
    }
    this.game.hidden = view !== 'game';
    this.room.hidden = view !== 'room';
    if (view === 'room') this.renderRoom(true);
    fillSliders(this.root);
  }

  sync() {
    const inRoom = !!this.net.room;
    this.tabs.room.hidden = !inRoom;
    this.bar.hidden = !inRoom; // one tab is no tabs
    if (!inRoom && this.view === 'room') this.show('game');
    else if (inRoom && this.view === 'room') this.renderRoom(false);
  }

  // force: rebuild even if you were mid-edit (opening the tab); otherwise only when the room's settings changed and
  // you have nothing unsaved
  renderRoom(force) {
    const room = this.net.room;
    if (!room) return;
    const host = this.net.isHost;
    const key = JSON.stringify([room.settings, room.members.length, host]);
    if (!force && (this.dirty || key === this.roomKey)) return;
    this.roomKey = key;
    this.dirty = false;
    this.roomNote.textContent = host ? '' : `Only ${this.net.member(room.owner)?.name || 'the host'} can change these.`; // the host's form says when changes apply
    const form = roomForm(room.settings, {
      mode: 'edit', ownerName: cleanName(this.net.member(room.owner)?.name), members: room.members.length, players: room.members, heal: this.hasHeal(), ultima: this.ultima(),
      onSubmit: (s) => { this.lobby.rememberSettings(s); this.net.setSettings(s); this.dirty = false; this.roomNote.textContent = 'Saved: applies from the next round.'; },
      onCancel: () => this.renderRoom(true), // back to what the room has
    });
    form.querySelector('.rf-title')?.remove();
    // Cancel reads as "undo my changes" here
    const cancel = [...form.querySelectorAll('.rf-buttons button')].find((b) => b.textContent === 'Cancel');
    if (cancel) cancel.textContent = 'Undo changes';
    if (!host) {
      for (const c of form.querySelectorAll('input, select, button, textarea')) c.disabled = true;
      form.querySelector('.rf-buttons')?.remove();
    }
    form.addEventListener('input', () => { this.dirty = true; });
    form.addEventListener('click', (ev) => { if (ev.target.closest?.('.seg button')) this.dirty = true; });
    this.roomBody.replaceChildren(form);
    fillSliders(form);
  }
}
