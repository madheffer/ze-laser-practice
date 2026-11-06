// The pause screen: what Esc opens during a run (the full menu, ui/menu.js, is one click away for stages and settings).
//   left   where you are (map, stage, clock, hits, HP) and the actions: Resume (| End run, endless), Restart,
//          Change stage / End round, Settings, Leave room / Home; the ones that end something ask first, in the card
//   right  in a room: the room code, big, with Copy code / Copy invite link, and the players (alive, dead, host)
// Names come from the server: textContent only.
import './pause.css';
import { S, G } from '../app/state.js';
import { stageTime } from '../app/session.js';
import { formatTime, plural } from '../lib/format.js';
import { displayName } from './maps.js';

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }
function btn(label, cls, onClick, kbd) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (kbd) { const k = el('kbd', 'kb', kbd); b.append(' ', k); }
  b.addEventListener('click', onClick);
  return b;
}

export class PauseScreen {
  // net: CoopClient; on: { resume(), endRun(), restart(), stages(), settings(), home(), endRound() }
  constructor(root, { net, on }) {
    this.root = root;
    this.net = net;
    this.on = on;
    this.build();
  }

  build() {
    const r = this.root;
    r.className = 'pause sheet';
    r.hidden = true;
    const card = el('div', 'pz-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'pz-title');

    const main = el('section', 'pz-main');
    this.kicker = el('p', 'pz-kicker');
    const title = this.title = el('h1', 'pz-title', 'Paused');
    title.id = 'pz-title';
    // a round never pauses (the server runs it): this menu says so instead of "Paused"
    this.live = el('p', 'pz-live', 'The round keeps going while this is open');
    this.stage = el('p', 'pz-stage');
    this.stats = el('dl', 'pz-stats');
    const acts = this.acts = el('div', 'pz-actions');
    this.resumeBtn = btn('Resume', 'primary pz-go pz-resume', () => this.on.resume(), 'Esc');
    // an endless run has no end but a death: this ends it here, its time kept like a death's (app/session.js finish)
    this.endRunBtn = btn('End run', 'primary pz-stop pz-resume', () => this.ask({
      q: () => `End the run at ${formatTime(stageTime())}?`,
      sub: 'Your time is saved.', yes: 'End run', run: () => this.on.endRun(),
    }));
    const top = el('div', 'pz-top');
    top.append(this.resumeBtn, this.endRunBtn);
    this.restartBtn = btn('Restart', 'ghost', () => this.on.restart(), 'Backspace');
    this.stagesBtn = btn('Change stage', 'ghost', () => this.on.stages());
    this.endBtn = btn('End round', 'ghost pz-danger', () => this.ask({
      q: () => 'End the round for everyone?', sub: 'Everyone goes back to the room.', yes: 'End round', run: () => this.on.endRound(),
    }));
    const settingsBtn = btn('Settings', 'ghost', () => this.on.settings());
    this.leaveBtn = btn('Leave room', 'ghost pz-danger', () => this.ask({ q: () => 'Leave the room?', yes: 'Leave', run: () => this.net.leave() }));
    this.homeBtn = btn('Home', 'ghost', () => this.on.home());
    acts.append(top, this.restartBtn, this.stagesBtn, this.endBtn, settingsBtn, this.leaveBtn, this.homeBtn);

    // "are you sure": takes the actions' place in the card (Esc or No goes back)
    this.confirm = el('div', 'pz-confirm');
    this.confirm.hidden = true;
    this.confirm.setAttribute('role', 'alertdialog');
    this.confirmQ = el('p', 'pz-confirm-q');
    this.confirmSub = el('p', 'pz-confirm-sub');
    const row = el('div', 'pz-confirm-row');
    this.noBtn = btn('No, go back', 'ghost', () => this.dismiss());
    this.yesBtn = btn('Yes', 'primary pz-yes', () => { const run = this.asking?.run; this.dismiss(); run?.(); });
    row.append(this.noBtn, this.yesBtn);
    this.confirm.append(this.confirmQ, this.confirmSub, row);
    main.append(this.kicker, title, this.live, this.stage, this.stats, acts, this.confirm);

    this.roomCard = el('aside', 'pz-room');
    this.roomCard.append(el('span', 'pz-label', 'Room code'));
    this.code = el('div', 'pz-code');
    const copyRow = el('div', 'pz-copy');
    this.copyCode = btn('Copy code', 'primary', () => this.copy('code'));
    this.copyLink = btn('Invite link', 'ghost', () => this.copy('link'));
    copyRow.append(this.copyCode, this.copyLink);
    this.players = el('ol', 'pz-players');
    this.roomCard.append(this.code, copyRow, el('span', 'pz-label', 'Players'), this.players);

    card.append(main, this.roomCard);
    r.append(card);
  }

  get open() { return !this.root.hidden; }

  // { q(): the question, sub: a line under it, yes: the confirm button's label, run() }
  ask(a) {
    this.asking = a;
    this.yesBtn.textContent = `Yes, ${a.yes.toLowerCase()}`;
    this.confirmSub.textContent = a.sub || '';
    this.confirmSub.hidden = !a.sub;
    this.acts.hidden = true;
    this.confirm.hidden = false;
    this.render();
    this.noBtn.focus({ preventScroll: true });
  }

  // close the "are you sure" (Esc, app/input.js): true if one was up
  dismiss() {
    if (!this.asking) return false;
    this.asking = null;
    this.confirm.hidden = true;
    this.acts.hidden = false;
    if (this.open) this.resumeBtn.focus({ preventScroll: true });
    return true;
  }

  show(on) {
    if (on === this.open) { if (on) this.render(); return; }
    this.root.hidden = !on;
    clearInterval(this.timer);
    this.dismiss();
    if (on) {
      this.render();
      this.timer = setInterval(() => this.render(), 500);
      this.resumeBtn.focus({ preventScroll: true });
    }
  }

  render() {
    const { net } = this;
    const run = S.run, room = net.room, mp = S.mp;
    const mapTitle = S.map ? displayName(S.mapIndex.find((m) => m.name === S.map.name)?.title || S.map.name) : '';
    const kind = mp ? 'Online' : 'Solo';
    const live = !!mp && !mp.ended;
    this.title.textContent = live ? 'Menu' : 'Paused';
    this.live.hidden = !live;
    this.kicker.textContent = [mapTitle, kind, run?.endless ? 'Endless' : ''].filter(Boolean).join(' · ');
    this.stage.textContent = S.scenario?.name || 'Free roam';
    const cells = [];
    if (run && S.scenario) cells.push(['Time', run.started ? formatTime(stageTime()) : 'starting']);
    if (run) cells.push(['Hits', String(run.hits)]);
    if (run && !run.spectating) cells.push(['HP', String(Math.max(0, Math.round(run.hp)))]);
    if (mp) cells.push(['Alive', `${mp.alive.length}/${mp.players.size}`]);
    this.stats.replaceChildren(...cells.map(([k, v]) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); return d; }));
    // solo endless only (a round's end is the server's), once the clock runs
    this.endRunBtn.hidden = !(run?.endless && run.started && !run.done && !mp && !S.replay);
    if (this.asking) this.confirmQ.textContent = this.asking.q();

    const host = net.isHost;
    const inRoom = !!room;
    this.restartBtn.hidden = inRoom && !host;
    this.restartBtn.querySelector('kbd').hidden = inRoom; // Backspace is solo only (main.js): in a room it's this button
    this.stagesBtn.hidden = inRoom;
    this.endBtn.hidden = !(inRoom && host && mp && !mp.ended);
    this.leaveBtn.hidden = !inRoom;
    this.homeBtn.hidden = inRoom;
    this.root.classList.toggle('in-room', inRoom);
    this.roomCard.hidden = !inRoom;
    if (!inRoom) return;
    if (this.code.textContent !== room.code) this.code.textContent = room.code;
    const rows = room.members.map((m) => {
      const p = mp?.players.get(m.id);
      const state = !p ? 'lobby' : p.alive ? 'alive' : 'dead';
      return { id: m.id, name: m.name, ping: m.ping || 0, state, host: m.id === room.owner, you: m.id === net.you };
    });
    const key = JSON.stringify(rows);
    if (key === this.playersKey) return;
    this.playersKey = key;
    this.players.replaceChildren(...rows.map((p) => {
      const li = el('li', `pz-p ${p.state}${p.you ? ' you' : ''}`);
      li.append(el('i', 'pz-dot'), el('span', 'pz-pname', p.name), el('span', 'pz-ms', `${p.ping} ms`));
      if (p.host) li.append(el('span', 'pz-tag host', 'Host'));
      if (p.you) li.append(el('span', 'pz-tag', 'You'));
      li.append(el('span', 'pz-state', p.state === 'alive' ? 'alive' : p.state === 'dead' ? 'dead' : 'in the room'));
      return li;
    }));
    const n = room.members.length;
    this.players.setAttribute('aria-label', plural(n, 'player'));
  }

  copy(what) {
    const room = this.net.room;
    if (!room) return;
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('room', room.code);
    const b = what === 'code' ? this.copyCode : this.copyLink;
    const label = b.textContent;
    navigator.clipboard?.writeText(what === 'code' ? room.code : url.href).then(() => {
      b.textContent = 'Copied ✓';
      b.classList.add('copied');
      setTimeout(() => { b.textContent = label; b.classList.remove('copied'); }, 1500);
    }, () => {});
  }
}
