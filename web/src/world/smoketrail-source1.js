// A Source 1 map's env_smoketrail puffs, drawn as the client's C_SmokeTrail emits them (Source SDK c_smoke_trail.cpp,
// as remembered; UNSETTLED where noted):
//   - spawnrate puffs a second, evenly spaced, from the entity's origin (interpolated along its path within the frame,
//     so one riding a 2000 u/s laser leaves a continuous trail), each offset by a random vector in +-spawnradius
//   - velocity: a random vector in the unit cube x random(minspeed, maxspeed), + the trail's own velocity, + its
//     forward x random(mindirectedspeed, maxdirectedspeed); positions integrate it, no drag
//   - colour: startcolor, varied by +-20 % of its brightest channel, constant over the puff's life (endcolor is
//     networked but this path doesn't use it); alpha random(0.75, 1.25) x opacity, fading linearly to 0
//   - size: startsize -> endsize (both whole units, 0-255) linearly over lifetime; roll random, rolling +-1 rad/s
//   - material: g_Mat_DustPuff[random 0 / 1] (particle_smokegrenade, particle_noisesphere: the bake's
//     SpriteBake.SmokeTrailMaterials), not the entity's smokesprite keyvalue; drawn blended, facing the view
//   - it stops emitting emittime seconds after it spawned (UNSETTLED: emittime as the server's stop time)
// Puffs already out live on after their trail is killed. Visual only, driven by engine time (paused = frozen).
import * as THREE from 'three';
import { num, parseVec } from './entities/math.js';
import { source1Exposure } from './source1-light.js';

const MATERIALS = ['particle/particle_smokegrenade.vmt', 'particle/particle_noisesphere.vmt'];
const MAX_PUFFS = 6000; // per material
const MAX_PER_FRAME = 400; // per trail: a long hitch doesn't flood the pool
const rand = (a, b) => a + Math.random() * (b - a);
const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();

export class SmokeTrails {
  // sprites: the map's Source1Sprites (null: nothing to draw with)
  constructor(sprites, scene) {
    this.pools = [];
    this.trails = new WeakMap();
    this.engine = null;
    this.time = 0;
    for (const name of MATERIALS) {
      const entry = sprites?.index?.get(name);
      if (!entry) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PUFFS * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PUFFS * 4 * 4), 4).setUsage(THREE.DynamicDrawUsage));
      const uv = new Float32Array(MAX_PUFFS * 8), idx = new Uint32Array(MAX_PUFFS * 6);
      for (let i = 0; i < MAX_PUFFS; i++) {
        uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
        idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.setDrawRange(0, 0);
      const mat = new THREE.MeshBasicMaterial({ map: sprites.texture(entry), vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.pools.push({ mesh, puffs: [] });
    }
  }

  dispose() {
    for (const p of this.pools) { p.mesh.removeFromParent(); p.mesh.geometry.dispose(); p.mesh.material.dispose(); }
    this.pools = [];
  }

  clear() { for (const p of this.pools) p.puffs.length = 0; this.trails = new WeakMap(); }

  update(engine, camera) {
    if (!this.pools.length) return;
    const now = engine ? engine.time : 0;
    if (engine !== this.engine || now < this.time) { this.clear(); this.engine = engine; this.time = now; }
    const dt = now - this.time;
    this.time = now;
    if (engine && dt > 0) {
      for (const e of engine.byClass.get('env_smoketrail') || []) if (e.alive) this.emit(e, now, dt);
      for (const p of this.pools) this.simulate(p, dt);
    }
    this.draw(camera);
  }

  emit(e, now, dt) {
    let t = this.trails.get(e);
    const o = e.worldOrigin();
    if (!t) {
      const kv = e.kv;
      t = {
        born: now, last: [o[0], o[1], o[2]], acc: 0,
        rate: Math.max(0, num(kv.spawnrate, 20)), life: Math.max(0.01, num(kv.lifetime, 5)), radius: Math.max(0, num(kv.spawnradius, 0)),
        minSpeed: num(kv.minspeed, 0), maxSpeed: num(kv.maxspeed, 0), minDir: num(kv.mindirectedspeed, 0), maxDir: num(kv.maxdirectedspeed, 0),
        color: parseVec(kv.startcolor, [255, 255, 255]).map((c) => Math.min(1, Math.max(0, c / 255))),
        opacity: Math.min(1, Math.max(0, num(kv.opacity, 0.5))),
        start: Math.min(255, Math.max(0, num(kv.startsize, 15))), end: Math.min(255, Math.max(0, num(kv.endsize, 50))),
        stop: num(kv.emittime, 0) > 0 ? now + num(kv.emittime, 0) : Infinity,
      };
      this.trails.set(e, t);
      return; // its first frame: the next one has a path to emit along
    }
    const vel = [(o[0] - t.last[0]) / dt, (o[1] - t.last[1]) / dt, (o[2] - t.last[2]) / dt];
    const from = t.last;
    t.last = [o[0], o[1], o[2]];
    if (!(t.rate > 0) || now > t.stop) return;
    // a teleport (a template spawned at its maker, a parent's first move) isn't a path
    if (Math.hypot(vel[0], vel[1], vel[2]) > 20000) return;
    t.acc += dt * t.rate;
    let n = Math.min(MAX_PER_FRAME, Math.floor(t.acc));
    t.acc -= Math.floor(t.acc);
    const fwd = e.getWorld ? e.getWorld().elements : null;
    const brightest = Math.max(t.color[0], t.color[1], t.color[2]) || 1;
    for (let k = 0; k < n; k++) {
      const pool = this.pools[(Math.random() * this.pools.length) | 0];
      if (pool.puffs.length >= MAX_PUFFS) continue;
      const along = (k + 1) / n, age = (1 - along) * dt; // spread over the frame's path, the earliest oldest
      const s = rand(t.minSpeed, t.maxSpeed), d = rand(t.minDir, t.maxDir);
      const v = [rand(-1, 1) * s + vel[0], rand(-1, 1) * s + vel[1], rand(-1, 1) * s + vel[2]];
      if (fwd && d) { v[0] += fwd[0] * d; v[1] += fwd[1] * d; v[2] += fwd[2] * d; }
      const jitter = rand(-0.2, 0.2); // offsetColor = start + (start / its brightest channel) x random(-0.2, 0.2)
      pool.puffs.push({
        p: [from[0] + (o[0] - from[0]) * along + rand(-t.radius, t.radius), from[1] + (o[1] - from[1]) * along + rand(-t.radius, t.radius), from[2] + (o[2] - from[2]) * along + rand(-t.radius, t.radius)],
        v, age, life: t.life, start: t.start, end: t.end,
        c: t.color.map((c) => Math.min(1, Math.max(0, c + (c / brightest) * jitter))),
        a: Math.min(1, Math.max(0, rand(0.75, 1.25) * t.opacity)), roll: Math.random() * Math.PI * 2, spin: rand(-1, 1),
      });
    }
  }

  simulate(pool, dt) {
    const out = pool.puffs;
    let w = 0;
    for (let i = 0; i < out.length; i++) {
      const q = out[i];
      q.age += dt;
      if (q.age >= q.life) continue;
      q.p[0] += q.v[0] * dt; q.p[1] += q.v[1] * dt; q.p[2] += q.v[2] * dt;
      q.roll += q.spin * dt;
      out[w++] = q;
    }
    out.length = w;
  }

  draw(camera) {
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    _r.set(m[0], m[1], m[2]); _u.set(m[4], m[5], m[6]); _f.set(m[8], m[9], m[10]);
    const ex = source1Exposure.value;
    for (const pool of this.pools) {
      const pos = pool.mesh.geometry.attributes.position, col = pool.mesh.geometry.attributes.color;
      const P = pos.array, C = col.array;
      const n = pool.puffs.length;
      for (let i = 0; i < n; i++) {
        const q = pool.puffs[i], f = q.age / q.life;
        const half = (q.start + (q.end - q.start) * f) / 2;
        const cs = Math.cos(q.roll) * half, sn = Math.sin(q.roll) * half;
        // the quad's corners: right / up turned by the roll
        const ax = _r.x * cs + _u.x * sn, ay = _r.y * cs + _u.y * sn, az = _r.z * cs + _u.z * sn;
        const bx = -_r.x * sn + _u.x * cs, by = -_r.y * sn + _u.y * cs, bz = -_r.z * sn + _u.z * cs;
        const o = i * 12;
        P[o] = q.p[0] - ax - bx; P[o + 1] = q.p[1] - ay - by; P[o + 2] = q.p[2] - az - bz;
        P[o + 3] = q.p[0] + ax - bx; P[o + 4] = q.p[1] + ay - by; P[o + 5] = q.p[2] + az - bz;
        P[o + 6] = q.p[0] + ax + bx; P[o + 7] = q.p[1] + ay + by; P[o + 8] = q.p[2] + az + bz;
        P[o + 9] = q.p[0] - ax + bx; P[o + 10] = q.p[1] - ay + by; P[o + 11] = q.p[2] - az + bz;
        const a = q.a * (1 - f);
        for (let k = 0; k < 4; k++) { const c = i * 16 + k * 4; C[c] = q.c[0] * ex; C[c + 1] = q.c[1] * ex; C[c + 2] = q.c[2] * ex; C[c + 3] = a; }
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
      pos.clearUpdateRanges?.(); col.clearUpdateRanges?.();
      pos.addUpdateRange?.(0, n * 12); col.addUpdateRange?.(0, n * 16);
      pool.mesh.geometry.setDrawRange(0, n * 6);
    }
  }
}
