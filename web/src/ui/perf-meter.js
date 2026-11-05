// The FPS / ping readout, top right while playing: "144 FPS", and in a room "144 FPS · 38 ms" (the measured round trip
// to the server, net/coop-client.js rtt). Settings › Display "Show FPS and ping" (settings.perfMeter) hides it.
// Text only (textContent), refreshed twice a second.
//   new PerfMeter(root, { rtt: () => ms })
import { settings } from '../app/settings.js';
import { fps } from '../app/perf.js';

const SLOW_FPS = 40, HIGH_PING = 120; // the numbers go amber below / above these

export class PerfMeter {
  constructor(root, { rtt = () => 0 } = {}) {
    this.el = document.createElement('div');
    this.el.className = 'hud-perf';
    this.el.setAttribute('aria-hidden', 'true'); // a readout, not something a screen reader should keep announcing
    root.append(this.el);
    this.fpsEl = document.createElement('span');
    this.pingEl = document.createElement('span');
    this.el.append(this.fpsEl, this.pingEl);
    setInterval(() => this.update(rtt()), 500);
  }

  update(ms) {
    this.el.hidden = !settings.perfMeter;
    if (this.el.hidden) return;
    const f = fps();
    this.fpsEl.textContent = f ? `${f} FPS` : '';
    this.fpsEl.classList.toggle('bad', f > 0 && f < SLOW_FPS);
    this.pingEl.textContent = ms ? `${f ? ' · ' : ''}${ms} ms` : '';
    this.pingEl.classList.toggle('bad', ms > HIGH_PING);
  }
}
