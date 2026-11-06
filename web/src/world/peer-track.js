// One other player's movement as it reaches you, and where to draw them each frame (world/peers.js draws it; the
// spectator camera and the radar read it too).
//
// Their positions arrive in batches ~30 times a second, one sample per tick of THEIR run (server/coop-round.js
// onState), stamped with their run time; every client's run runs on the same clock (app/coop.js). CS2 draws other
// players a little in the past (cl_interp) between the snapshots around that time, and its clock never jumps: it
// runs a touch fast or slow until it is where it should be (the client's clock drift correction). Same here:
//   - the delay follows how late their samples actually reach you (the latest arrival of the last LAG_WINDOW, plus
//     a margin), so a sample is there when it is needed;
//   - the time they are drawn at (play) is their own clock: it advances with the wall clock, a little faster or
//     slower (at most SLEW) until it sits `delay` behind your run time. A late batch, a delay that grows, your round
//     clock being pulled onto the server's: all of it is eased out instead of the body jumping back or skipping;
//   - a sample that is late anyway is bridged by carrying on along their last velocity for up to EXTRAPOLATE.
import { clamp01, clamp, lerpAngle } from '../lib/math.js';

const KEEP = 160; // samples (2.5 s of ticks)
const LAG_WINDOW = 2; // s of arrivals the delay is taken from
const DELAY_MIN = 0.05, DELAY_MAX = 0.5; // s
const DELAY_MARGIN = 0.02; // s on top of the latest arrival seen (about a tick of jitter)
const EXTRAPOLATE = 0.1; // s past their newest sample they keep moving before holding
const MAX_SPEED = 3500; // u/s: faster between two samples is a teleport, not a velocity to carry on
const GAIN = 3; // 1/s: how fast the play clock closes on its target (a third of the gap is gone in ~0.13 s)
const SLEW = 0.15; // the play clock runs at most this much faster / slower than real time
const SNAP = 0.3; // s off target: jump (a hidden tab, a new round), easing that out would take seconds

const wrap360 = (a) => ((a % 360) + 360) % 360; // kept in range: a round of turning one way would add up otherwise

export class PeerTrack {
  constructor() {
    this.samples = []; // { t, o: [x, y, z], duck, hp, yaw, pitch }
    this.lags = []; // [arrived, late by]
    this.delay = 0.1; // s behind your run time they should be drawn
    this.play = null; // run time they are drawn at, null until the first frame
    this.wall = 0; // ms (performance.now) of the frame `play` was last advanced in
  }

  // A batch (validated by app/coop.js): positions [[x, y, z, duck], ...] for consecutive ticks ending at their run
  // time `at`, one view angle for the batch (the earlier ticks turn toward it from the last batch's), and `now`:
  // your run time as it arrived (to the millisecond, not the tick), for the delay.
  push({ at, positions, yaw, pitch, hp, tick }, now) {
    if (!positions.length) return;
    const q = this.samples;
    if (q.length && at < q[q.length - 1].t - 1) { q.length = 0; this.lags.length = 0; this.play = null; } // well behind: a new round
    else if (q.length && at <= q[q.length - 1].t) return; // an old batch: what it says is already here
    const prev = q[q.length - 1];
    const n = positions.length;
    for (let i = 0; i < n; i++) {
      const t = at - (n - 1 - i) * tick;
      if (prev && t <= prev.t) continue; // already have it
      const k = (i + 1) / n, [x, y, z, duck] = positions[i];
      q.push({
        t, o: [x, y, z], duck, hp,
        yaw: wrap360(prev ? lerpAngle(prev.yaw, yaw, k) : yaw), pitch: prev ? prev.pitch + (pitch - prev.pitch) * k : pitch,
      });
    }
    while (q.length > KEEP) q.shift();
    // the delay covers the latest arrival of the last LAG_WINDOW: up at once, easing back down (~0.6 s at 30
    // batches/s); the play clock eases either way, so neither shows as a jump
    const lags = this.lags;
    lags.push([now, now - at]);
    while (lags.length && lags[0][0] < now - LAG_WINDOW) lags.shift();
    let late = -Infinity;
    for (const l of lags) late = Math.max(late, l[1]);
    const target = Math.min(DELAY_MAX, Math.max(DELAY_MIN, late + DELAY_MARGIN));
    this.delay = target > this.delay ? target : this.delay + (target - this.delay) * 0.05;
  }

  // the run time they are drawn at this frame: your run time `now`, the frame's wall clock `wall` (ms). Asked twice
  // in one frame (the camera, then the body), it answers the same.
  time(now, wall) {
    const target = now - this.delay;
    if (this.play == null) { this.play = target; this.wall = wall; return target; }
    const dt = (wall - this.wall) / 1000;
    if (!(dt > 0)) return this.play;
    this.wall = wall;
    const off = target - this.play;
    if (Math.abs(off) > SNAP || dt > SNAP) this.play = target;
    else this.play += dt * (1 + clamp(off * GAIN, -SLEW, SLEW));
    return this.play;
  }

  // where they are at run time t: interpolated between the samples around it, carried on along their last velocity
  // for a moment past the newest (t = null: the newest)
  at(t) {
    const q = this.samples;
    if (!q.length) return null;
    const last = q[q.length - 1];
    if (t == null) return last;
    if (t >= last.t) {
      const before = q[q.length - 2];
      const dt = before ? last.t - before.t : 0;
      if (!(dt > 0)) return last;
      const v = last.o.map((x, j) => (x - before.o[j]) / dt);
      if (Math.hypot(v[0], v[1], v[2]) > MAX_SPEED) return last;
      const ahead = Math.min(t - last.t, EXTRAPOLATE);
      return { ...last, t, o: last.o.map((x, j) => x + v[j] * ahead) };
    }
    if (t <= q[0].t) return q[0];
    let i = q.length - 1;
    while (i > 0 && q[i - 1].t > t) i--;
    const a = q[i - 1], b = q[i];
    const k = clamp01((t - a.t) / Math.max(1e-6, b.t - a.t));
    return {
      t, hp: b.hp,
      o: a.o.map((v, j) => v + (b.o[j] - v) * k),
      yaw: lerpAngle(a.yaw, b.yaw, k), pitch: a.pitch + (b.pitch - a.pitch) * k,
      duck: a.duck + (b.duck - a.duck) * k,
    };
  }

  // this frame's position: your run time `now`, the frame's wall clock (ms)
  sample(now, wall) { return now == null ? this.at(null) : this.at(this.time(now, wall)); }
}
