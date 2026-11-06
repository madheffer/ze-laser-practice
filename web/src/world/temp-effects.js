// Source's temporary effects for a Source 1 map's entities (engine 'tempfx' requests, entities/classes/sparks.js):
//  - sparks (env_spark: g_pEffects->Sparks -> FX_ElectricSpark): a burst of hot streaks thrown out and falling, more
//    and longer with Magnitude / TrailLength, and a flash at the spark point
//  - tesla (point_tesla: CTesla::DoSpark): each beam traces from the tesla out to its radius (MASK_SOLID_BRUSHONLY); one
//    that hits draws a jagged beam of its width and colour to the hit point for its lifetime
// UNSETTLED: the look (streak count, speeds, lifetimes, the beam's jag and fade) is drawn after Source's effects, not
// read from client.dll; the timing, positions, widths, colours and lifetimes are the entities' (the engine's request).
import * as THREE from 'three';

const MAX_LIVE = 96;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _u = new THREE.Vector3(0, 0, 1), _q = new THREE.Quaternion();

export class TempEffects {
  constructor(root) {
    this.root = root;
    this.live = [];
    this.trace = null; // (from, dir, length) -> { hit, position }: the map's particle trace (fx/trace.js)
    this.cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true);
    this.cyl.rotateX(Math.PI / 2); // along +Z
  }

  clear() { for (const f of this.live) this.drop(f); this.live.length = 0; }

  request(ev, now) {
    if (!ev || this.live.length >= MAX_LIVE) return;
    if (ev.kind === 'sparks') this.sparks(ev, now);
    else if (ev.kind === 'tesla') this.tesla(ev, now);
  }

  sparks(ev, now) {
    const mag = Math.max(1, Math.min(8, Number(ev.magnitude) || 1)), trail = Math.max(1, Math.min(3, Number(ev.trail) || 1));
    const n = Math.round(6 + 4 * mag);
    const pos = new Float32Array(n * 6), col = new Float32Array(n * 6);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const d = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
      const l = Math.hypot(...d) || 1, speed = (60 + Math.random() * 120) * Math.sqrt(mag);
      parts.push({ v: d.map((x) => (x / l) * speed), life: 0.15 + Math.random() * 0.25 * trail });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const obj = new THREE.LineSegments(geo, mat);
    obj.frustumCulled = false;
    this.root.add(obj);
    this.live.push({ kind: 'sparks', obj, born: now, until: now + 0.6, origin: ev.pos.slice(), parts, trail });
  }

  tesla(ev, now) {
    if (!this.trace) return;
    const c = ev.color || [255, 255, 255];
    const color = new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);
    for (const b of ev.beams || []) {
      const l = Math.hypot(...b.dir) || 1, dir = b.dir.map((x) => x / l);
      const tr = this.trace(ev.pos, dir, Number(ev.radius) || 200);
      if (!tr?.hit) continue;
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      // a jagged path: 6 segments, each joint pushed sideways by up to a tenth of the beam's length
      const len = Math.hypot(tr.position[0] - ev.pos[0], tr.position[1] - ev.pos[1], tr.position[2] - ev.pos[2]);
      const pts = [ev.pos];
      for (let k = 1; k < 6; k++) {
        const t = k / 6, j = len * 0.1;
        pts.push([0, 1, 2].map((a) => ev.pos[a] + (tr.position[a] - ev.pos[a]) * t + (Math.random() * 2 - 1) * j));
      }
      pts.push(tr.position);
      const w = Math.max(1, Number(b.width) || 4) * 0.25;
      for (let k = 0; k < pts.length - 1; k++) {
        _a.fromArray(pts[k]); _b.fromArray(pts[k + 1]);
        const seg = new THREE.Mesh(this.cyl, mat);
        seg.position.copy(_a).add(_b).multiplyScalar(0.5);
        seg.quaternion.copy(_q.setFromUnitVectors(_u, _b.clone().sub(_a).normalize()));
        seg.scale.set(w, w, _a.distanceTo(_b));
        group.add(seg);
      }
      this.root.add(group);
      this.live.push({ kind: 'beam', obj: group, mat, born: now, until: now + Math.max(0.05, Number(b.life) || 0.3) });
    }
  }

  update(now) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const f = this.live[i];
      if (now >= f.until || now < f.born - 1) { this.drop(f); this.live.splice(i, 1); continue; }
      const age = now - f.born;
      if (f.kind === 'beam') { f.mat.opacity = 1 - age / (f.until - f.born); continue; }
      const pos = f.obj.geometry.attributes.position.array, col = f.obj.geometry.attributes.color.array;
      f.parts.forEach((p, k) => {
        const fade = Math.max(0, 1 - age / p.life);
        const t1 = age, t0 = Math.max(0, age - 0.03 * f.trail);
        for (const [slot, t] of [[0, t0], [3, t1]]) {
          pos[k * 6 + slot] = f.origin[0] + p.v[0] * t;
          pos[k * 6 + slot + 1] = f.origin[1] + p.v[1] * t;
          pos[k * 6 + slot + 2] = f.origin[2] + p.v[2] * t - 400 * t * t;
          col[k * 6 + slot] = fade; col[k * 6 + slot + 1] = 0.85 * fade; col[k * 6 + slot + 2] = 0.5 * fade;
        }
      });
      f.obj.geometry.attributes.position.needsUpdate = true;
      f.obj.geometry.attributes.color.needsUpdate = true;
    }
  }

  drop(f) {
    this.root.remove(f.obj);
    f.obj.traverse((o) => { if (o.geometry && o.geometry !== this.cyl) o.geometry.dispose(); if (o.material && o.material !== f.mat) o.material.dispose?.(); });
    f.mat?.dispose();
  }
}
