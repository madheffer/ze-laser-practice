// The other players in a co-op / versus round: a CT body each where they stand (world/body.js, the same agent
// as your own third person; a plain capsule until it has loaded, or if it can't) and a name tag above them.
//
// Their states arrive ~20 times a second stamped with THEIR run time; since every client's run runs on the same
// clock (app/coop.js), each one is drawn at (your run time - a small delay), interpolated between the two states
// around it. The spectator camera reads the same samples.
import * as THREE from 'three';
import { PlayerBody } from './body.js';
import { clamp01 } from '../lib/math.js';
import { CS } from './movement.js';

const KEEP = 40; // samples per player (2 s at 20 Hz)
const TAG_HEIGHT = 84; // name tag this far above the feet

const lerpAngle = (a, b, t) => a + ((((b - a) % 360) + 540) % 360 - 180) * t;

export class Peers {
  constructor(scene, { log = () => {} } = {}) {
    this.scene = scene;
    this.log = log;
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
    const p = { name: m.name, samples: [], body: null, capsule, tag, alive: true };
    this.list.set(m.id, p);
    const body = new PlayerBody(this.scene, { log: () => {} });
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

  // a state from the network (already validated by app/coop.js): { t, o, yaw, pitch, duck, hp }
  push(id, s) {
    const p = this.list.get(id);
    if (!p) return;
    const q = p.samples;
    if (q.length && s.t < q[q.length - 1].t) q.length = 0; // a new round, or a reordered frame
    q.push(s);
    if (q.length > KEEP) q.shift();
  }

  setAlive(id, alive) { const p = this.list.get(id); if (p) p.alive = alive; }

  // where a player is at run time t: interpolated between the samples around it (held at the newest past it)
  sample(id, t) {
    const q = this.list.get(id)?.samples;
    if (!q?.length) return null;
    if (t == null || t >= q[q.length - 1].t) return q[q.length - 1];
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

  // their eye, for the spectator camera
  eye(id, t) {
    const s = this.sample(id, t);
    if (!s) return null;
    return { id, eye: [s.o[0], s.o[1], s.o[2] + CS.viewStand + (CS.viewDuck - CS.viewStand) * s.duck], yaw: s.yaw, pitch: s.pitch, hp: s.hp };
  }

  // every frame: t = the run time to draw (null = not in a round), hide = the player you watch (their eyes are
  // the camera)
  update(t, camera, hide) {
    const w = innerWidth, h = innerHeight;
    for (const [id, p] of this.list) {
      const s = t == null || !p.alive ? null : this.sample(id, t);
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
