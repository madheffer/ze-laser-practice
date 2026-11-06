// The stage loading screen: from the moment a stage is picked until its clock starts (solo: run.ready; a round:
// the server's go), so the first thing you see is the drawn world, never a black canvas. It shows the map and the
// stage, the map's own screenshot behind (ui/home-hero.js shotsOf), a bar and the current step: main.js loadStage
// (the map's files) feeds step(), then follow() polls the run (app/readiness.js stageStatus). Map text goes in
// through textContent only. In a co-op / versus round it also lists every player's progress and who is ready
// (app/coop-load.js loadRoster). Leave (a round: leaves the room) / Back (solo) drops the load and goes to the menu,
// so a load that never finishes never needs a page reload.
import './loading.css';
import { S } from '../app/state.js';
import { stageStatus } from '../app/readiness.js';
import { loadRoster } from '../app/coop-load.js';
import { shotsOf } from './home-hero.js';
import { displayName } from './maps.js';
import { voiceBadge } from './voice-hud.js';

const POLL_MS = 100;
const FADE_MS = 350;
const ROSTER_MS = 250;

export class LoadingScreen {
  // onLeave(): the Leave / Back button
  constructor(root, { onLeave = () => {} } = {}) {
    this.root = root;
    root.hidden = true;
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = `
      <div class="ld-bg"></div>
      <div class="ld-card">
        <div class="ld-map"></div>
        <div class="ld-stage"></div>
        <div class="ld-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div>
        <div class="ld-step" role="status" aria-live="polite"></div>
        <ul class="ld-players" aria-label="Players" hidden></ul>
        <button type="button" class="ghost ld-leave"></button>
      </div>`;
    this.el = {
      bg: root.querySelector('.ld-bg'), map: root.querySelector('.ld-map'), stage: root.querySelector('.ld-stage'),
      bar: root.querySelector('.ld-bar'), fill: root.querySelector('.ld-bar i'), step: root.querySelector('.ld-step'),
      players: root.querySelector('.ld-players'), leave: root.querySelector('.ld-leave'),
    };
    this.el.leave.addEventListener('click', () => onLeave());
    this.rosterTimer = null; this.rosterKey = ''; this.rows = [];
    this.open = false;
    this.frac = 0;
    this.openTimer = null; this.pollTimer = null; this.fadeTimer = null;
    this.shot = '';
  }

  get isOpen() { return this.open || this.openTimer != null; }

  // a stage of mapName was asked for (stageId null = free roam, undefined = not named): shown now, or after delay ms if it is still loading
  // by then. Already open: only its labels change.
  begin(mapName, stageId, delay = 0) {
    this.label(mapName, stageId);
    if (this.isOpen) return;
    this.frac = 0;
    this.paint({ text: 'Starting', frac: 0 });
    if (delay > 0) this.openTimer = setTimeout(() => { this.openTimer = null; this.show(); }, delay);
    else this.show();
  }

  // the map's own loading steps (main.js loadStage)
  step(s) { if (this.isOpen) this.paint(s); }

  // the run takes over until its clock starts; a restart on a loaded map opens the screen only if it is slow
  follow(run, mapName, stageId) {
    if (!this.isOpen) this.begin(mapName, stageId, 300);
    else this.label(mapName, stageId);
    clearInterval(this.pollTimer);
    const tick = () => {
      const s = stageStatus(run);
      if (s?.done) this.close(true);
      else if (!s) { if (S.run == null) this.close(false); else clearInterval(this.pollTimer); } // a newer run follows
      else this.paint(s);
    };
    this.pollTimer = setInterval(tick, POLL_MS);
    tick();
  }

  close(fade = true) {
    clearInterval(this.pollTimer); this.pollTimer = null;
    clearInterval(this.rosterTimer); this.rosterTimer = null;
    clearTimeout(this.openTimer); this.openTimer = null;
    if (!this.open) return;
    this.open = false;
    if (!fade) { this.root.hidden = true; this.root.classList.remove('out'); return; }
    this.paint({ text: this.el.step.textContent, frac: 1 });
    this.root.classList.add('out');
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => { if (!this.open) { this.root.hidden = true; this.root.classList.remove('out'); } }, FADE_MS);
  }

  // ---- inside
  show() {
    clearTimeout(this.fadeTimer);
    this.open = true;
    this.root.classList.remove('out');
    this.root.hidden = false;
    clearInterval(this.rosterTimer);
    this.rosterTimer = setInterval(() => this.roster(), ROSTER_MS);
    this.rosterKey = null; // drawn afresh: a solo stage after a round has none
    this.roster();
  }

  // a round's players: name, their bar and percent, a tick when ready, "out" when left behind or gone
  roster() {
    const list = loadRoster();
    // a round loads over the menu and the pause card too: a guest who hasn't clicked in still sees who everyone is
    // waiting for, and one the round started without still sees their own load finish (the roster is gone by then)
    const round = !!list || !!S.mp;
    this.root.classList.toggle('round', round);
    const leave = round ? 'Leave room' : 'Back';
    if (this.el.leave.textContent !== leave) this.el.leave.textContent = leave;
    const ul = this.el.players;
    const show = !!list && list.length >= 2;
    ul.hidden = !show;
    // the rows are made once per roster and only updated after, so a talking square (app/voice.js) stays lit
    const key = show ? list.map((p) => `${p.id}:${p.name}:${p.you}`).join('|') : '';
    if (key !== this.rosterKey) {
      this.rosterKey = key;
      this.rows = show ? list.map((p) => this.playerRow(p)) : [];
      ul.replaceChildren(...this.rows.map((r) => r.li));
    }
    if (!show) return;
    list.forEach((p, i) => {
      const r = this.rows[i];
      const cls = `${p.out ? 'out' : p.ready ? 'ready' : ''}${p.you ? ' you' : ''}`.trim();
      if (r.li.className !== cls) r.li.className = cls;
      const scale = `scaleX(${p.out ? 0 : p.pct / 100})`;
      if (r.fill.style.transform !== scale) r.fill.style.transform = scale;
      const state = p.out ? 'out' : p.ready ? '\u2713' : `${p.pct}%`;
      if (r.state.textContent !== state) r.state.textContent = state;
    });
  }

  // a roster row: their square (lit while they talk), name, bar, percent / tick / out
  playerRow(p) {
    const li = document.createElement('li');
    const sq = document.createElement('span');
    sq.className = 'ld-avatar';
    sq.textContent = (p.name || '?').slice(0, 1).toUpperCase();
    sq.dataset.voiceId = String(p.id);
    sq.append(voiceBadge());
    const name = document.createElement('span');
    name.className = 'ld-pname';
    name.textContent = p.you ? `${p.name} (you)` : p.name;
    const bar = document.createElement('span');
    bar.className = 'ld-pbar';
    const fill = document.createElement('i');
    fill.style.transform = 'scaleX(0)';
    bar.append(fill);
    const state = document.createElement('span');
    state.className = 'ld-pstate';
    li.append(sq, name, bar, state);
    return { li, fill, state };
  }

  label(mapName, stageId) {
    const info = S.mapIndex?.find((m) => m.name === mapName) || { name: mapName };
    this.el.map.textContent = displayName(info.title || mapName || '');
    const sc = S.map?.name === mapName && stageId != null ? S.scenarios?.find((s) => s.id === stageId) : null;
    this.el.stage.textContent = stageId === null ? 'Free roam' : sc?.name || ''; // undefined: not known (a replay)
    const shot = shotsOf([info])[0]?.url || '';
    if (shot !== this.shot) {
      this.shot = shot;
      this.el.bg.style.backgroundImage = shot ? `url("${shot}")` : '';
      this.root.classList.toggle('has-shot', !!shot);
    }
  }

  // the bar never goes back (a step that restarts its count)
  paint({ text, frac }) {
    this.frac = Math.max(this.frac, Math.min(1, frac || 0));
    this.el.fill.style.transform = `scaleX(${this.frac})`;
    this.el.bar.setAttribute('aria-valuenow', String(Math.round(this.frac * 100)));
    if (text != null && this.el.step.textContent !== text) this.el.step.textContent = text;
  }
}
