// The bar along the bottom while a replay plays (app/replay.js): who and what, play / pause, the clock and a
// scrubber, speed, the camera (their eyes, behind them, free), copy link, leave. Everything shown is text.
import './replay-bar.css';
import { formatTime } from '../lib/format.js';

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

const CAM_LABEL = { first: 'Eyes', third: 'Behind', free: 'Free cam' };
const CAM_HINT = {
  first: 'Through their eyes · V camera · Space pause · ← → 5 s · [ ] speed',
  third: 'Third person · V camera · Space pause · ← → 5 s · [ ] speed',
  free: 'Click to look around · WASD fly · Space up · Ctrl down · Shift fast · Esc mouse',
};

export class ReplayBar {
  // on: { pause(), seek(t), speed(dir), cam(name), leave(), clock() -> { t, total }, link(info) -> url | '' }
  constructor(root, on) {
    this.root = root;
    this.on = on;
    this.state = null;
    root.className = 'rb hidden';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Replay controls');

    const top = el('div', 'rb-top');
    this.title = el('p', 'rb-title');
    this.hint = el('p', 'rb-hint');
    top.append(el('span', 'rb-badge', 'Replay'), this.title, el('span', 'grow'), this.hint);

    const row = el('div', 'rb-row');
    this.play = this.button('rb-play', '', () => on.pause());
    this.time = el('span', 'rb-time');
    this.scrub = el('input', 'rb-scrub');
    Object.assign(this.scrub, { type: 'range', min: '0', max: '1', step: '0.1', value: '0' });
    this.scrub.setAttribute('aria-label', 'Replay position');
    this.scrubbing = false;
    this.scrub.addEventListener('input', () => { this.scrubbing = true; this.time.textContent = this.clockText(Number(this.scrub.value)); });
    this.scrub.addEventListener('change', () => { this.scrubbing = false; on.seek(Number(this.scrub.value)); this.scrub.blur(); });
    this.speedDown = this.button('rb-btn', '−', () => on.speed(-1), 'Slower');
    this.speed = el('span', 'rb-speed');
    this.speedUp = this.button('rb-btn', '+', () => on.speed(1), 'Faster');
    const cams = el('div', 'rb-cams');
    cams.setAttribute('role', 'group');
    cams.setAttribute('aria-label', 'Camera');
    this.cams = {};
    for (const c of Object.keys(CAM_LABEL)) { this.cams[c] = this.button('rb-cam', CAM_LABEL[c], () => on.cam(c)); cams.append(this.cams[c]); }
    this.copy = this.button('rb-btn rb-copy', 'Copy link', () => this.copyLink());
    const leave = this.button('rb-btn rb-leave', 'Leave', () => on.leave());
    row.append(this.play, this.time, this.scrub, this.speedDown, this.speed, this.speedUp, cams, this.copy, leave);
    root.append(top, row);
  }

  button(cls, text, onClick, label) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    // never keep focus: the replay's keys (Space, WASD) must reach the game, not the last button clicked
    b.addEventListener('click', () => { onClick(); b.blur(); });
    return b;
  }

  // state: S.replay
  show(state) {
    this.state = state;
    const i = state.info || {};
    this.title.textContent = [i.name || 'Player', state.stageName || ''].filter(Boolean).join(' · ');
    this.copy.hidden = !i.id;
    this.root.classList.remove('hidden');
    document.body.classList.add('replaying');
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 100);
    this.sync();
  }
  hide() {
    this.state = null;
    clearInterval(this.timer);
    this.root.classList.add('hidden');
    document.body.classList.remove('replaying');
  }
  setStage(name) { if (this.state) { this.state.stageName = name; this.show(this.state); } }

  clockText(t) {
    const { total } = this.on.clock();
    const f = (v) => (v < 0 ? `-${(-v).toFixed(1)}` : formatTime(v));
    return `${f(t)} / ${formatTime(Math.max(0, total))}`;
  }

  tick() {
    if (!this.state) return;
    const { t, total } = this.on.clock();
    if (!this.scrubbing) {
      this.scrub.min = String(-1);
      this.scrub.max = String(Math.max(0, total).toFixed(1));
      this.scrub.value = String(t);
      this.time.textContent = this.clockText(t);
    }
  }

  sync() {
    const s = this.state;
    if (!s) return;
    this.play.textContent = s.fast ? '…' : s.paused ? '▶' : '❚❚';
    this.play.setAttribute('aria-label', s.paused ? 'Play' : 'Pause');
    this.play.disabled = s.fast;
    this.speed.textContent = `${s.speed}×`;
    for (const [c, b] of Object.entries(this.cams)) b.setAttribute('aria-pressed', String(c === s.cam));
    this.hint.textContent = s.fast ? 'Seeking…' : CAM_HINT[s.cam];
    this.root.classList.toggle('seeking', s.fast);
    this.tick();
  }

  copyLink() {
    const url = this.on.link(this.state?.info);
    if (!url) return;
    navigator.clipboard?.writeText(url).then(() => { this.copy.textContent = 'Copied'; setTimeout(() => { this.copy.textContent = 'Copy link'; }, 1500); }, () => {});
  }
}
