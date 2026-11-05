// The other players in a co-op / versus round: a CT body each where they stand (world/body.js, the same agent
// as your own third person; a plain capsule until it has loaded, or if it can't) and a name tag above them.
//
// Their positions arrive in batches ~30 times a second, one sample per tick of THEIR run (server/coop-round.js
// onState), stamped with their run time; every client's run runs on the same clock (app/coop.js). Each player is
// drawn at (your run time - their own delay), interpolated between the samples around it, the way CS2 draws other
// players a little in the past (cl_interp). The delay follows how late their samples actually reach you (the batch's
// age + their trip through the server, measured over the last LAG_WINDOW), so a sample is there when it's needed
// instead of the body holding still and then jumping; a sample that is late anyway is bridged by carrying on along
// their last velocity for up to EXTRAPOLATE. The spectator camera and the radar read the same samples.
import * as THREE from 'three';
import { PlayerBody } from './body.js';
import { clamp01 } from '../lib/math.js';
import { CS } from './movement.js';

const KEEP = 160; // samples per player (2.5 s of ticks)
const TAG_HEIGHT = 84; // name tag this far above the feet
const LAG_WINDOW = 2; // s of arrivals the delay is taken from
const DELAY_MIN = 0.05, DELAY_MAX = 0.5; // s
const DELAY_MARGIN = 0.02; // s on top of the latest arrival seen (about a tick of jitter)
const EXTRAPOLATE = 0.1; // s past their newest sample they keep moving before holding
const MAX_SPEED = 3500; // u/s: faster between two samples is a teleport, not a velocity to carry on

const lerpAngle = (a, b, t) => a + ((((b - a) % 360) + 540) % 360 - 180) * t;

export class Peers {
  constructor(scene, { log = () => {}, onModel = null } = {}) {
    this.scene = scene;
    this.log = log;
    this.onModel = onModel; // handed to each body (world/body.js)
    this.list = new Map(); // id -> { name, samples: [], body, capsule, tag, alive }
    this.tags = document.createElement('div');
    this.tags.id = 'nametags';
    document.body.append(this.tags);
    this._v = new THREE.Vector3();
  }

  // the round's other players: [{id, name}]
  set(members) {
    const want = new Set(members.map((m) => m.id));
    for (const [id, p] of this.list) if (!want.has(id)) this._remove(id, p);
    for (const m of members) {
      const p = this.list.get(m.id);
      if (p) { p.name = m.name; p.tag.textContent = m.name; continue; }
      this._add(m);
    }
  }

  clear() { for (const [id, p] of this.list) this._remove(id, p); }

  _add(m) {
    const capsule = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 14, 72, 12),
      new THREE.MeshStandardMaterial({ color: 0x5d79ae, roughness: 0.8 }));
    capsule.rotation.x = Math.PI / 2; // three's cylinder stands on Y; Source is Z up
    capsule.visible = false;
    this.scene.add(capsule);
    const tag = document.createElement('div');
    tag.className = 'nametag';
    tag.textContent = m.name; // textContent: a player's name is untrusted
    this.tags.append(tag);
    const p = { name: m.name, samples: [], lags: [], delay: 0.1, body: null, capsule, tag, alive: true };
    this.list.set(m.id, p);
    const body = new PlayerBody(this.scene, { log: () => {}, onModel: this.onModel });
    body.load().then(() => {
      if (this.list.get(m.id) !== p) { body.place.removeFromParent(); return; }
      p.body = body;
    }, (e) => this.log(`peer body: ${e.message || e} (a capsule stands in)`));
  }

  _remove(id, p) {
    p.capsule.removeFromParent();
    p.capsule.geometry.dispose();
    p.capsule.material.dispose();
    p.body?.place.removeFromParent();
    p.tag.remove();
    this.list.delete(id);
  }

  // A batch from the network (already validated by app/coop.js): positions [[x, y, z, duck], ...] for consecutive
  // ticks ending at their run time `at`, one view angle for the batch (the earlier ticks turn toward it from the last
  // batch's), and `now`: your own run time as it arrives, for the delay.
  pushBatch(id, { at, positions, yaw, pitch, hp, tick }, now) {
    const p = this.list.get(id);
    if (!p || !positions.length) return;
    const q = p.samples;
    if (q.length && at < q[q.length - 1].t - 1) { q.length = 0; p.lags.length = 0; } // well behind: a new round
    else if (q.length && at <= q[q.length - 1].t) return; // an old batch: what it says is already here
    const prev = q[q.length - 1];
    const n = positions.length;
    for (let i = 0; i < n; i++) {
      const t = at - (n - 1 - i) * tick;
      if (prev && t <= prev.t) continue; // already have it
      const k = (i + 1) / n, [x, y, z, duck] = positions[i];
      q.push({
        t, o: [x, y, z], duck, hp,
        yaw: prev ? lerpAngle(prev.yaw, yaw, k) : yaw, pitch: prev ? prev.pitch + (pitch - prev.pitch) * k : pitch,
      });
    }
    while (q.length > KEEP) q.shift();
    // how late this batch's newest tick reached you; the delay covers the latest of the last LAG_WINDOW, rising at
    // once (a body standing still is worse than a little more delay) and easing back down
    const lags = p.lags;
    lags.push([now, now - at]);
    while (lags.length && lags[0][0] < now - LAG_WINDOW) lags.shift();
    const target = Math.min(DELAY_MAX, Math.max(DELAY_MIN, Math.max(...lags.map((l) => l[1])) + DELAY_MARGIN));
    p.delay = target > p.delay ? target : p.delay + (target - p.delay) * 0.05; // ~0.6 s to settle at 30 batches/s
  }

  setAlive(id, alive) { const p = this.list.get(id); if (p) p.alive = alive; }

  // where a player is, drawn at your run time `now` minus their delay: interpolated between the samples around it,
  // carried on along their last velocity for a moment past the newest
  sample(id, now) {
    const p = this.list.get(id), q = p?.samples;
    if (!q?.length) return null;
    const last = q[q.length - 1];
    if (now == null) return last;
    const t = now - p.delay;
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

  // their eye at your run time `now`, for the spectator camera
  eye(id, now) {
    const s = this.sample(id, now);
    if (!s) return null;
    return { id, eye: [s.o[0], s.o[1], s.o[2] + CS.viewStand + (CS.viewDuck - CS.viewStand) * s.duck], yaw: s.yaw, pitch: s.pitch, hp: s.hp };
  }

  // every frame: now = your run time this frame, between ticks (null = not in a round), hide = the player you
  // watch (their eyes are the camera)
  update(now, camera, hide) {
    const w = innerWidth, h = innerHeight;
    for (const [id, p] of this.list) {
      const s = now == null || !p.alive ? null : this.sample(id, now);
      const show = !!s && id !== hide;
      if (p.body) {
        p.capsule.visible = false;
        p.body.update(show ? { visible: true, origin: s.o, yaw: s.yaw, duckAmount: s.duck } : { visible: false });
      } else {
        p.capsule.visible = show;
        if (show) p.capsule.position.set(s.o[0], s.o[1], s.o[2] + 36 - 9 * s.duck);
      }
      if (!show) { p.tag.hidden = true; continue; }
      const v = this._v.set(s.o[0], s.o[1], s.o[2] + TAG_HEIGHT - 18 * s.duck).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { p.tag.hidden = true; continue; }
      p.tag.hidden = false;
      p.tag.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }
}
