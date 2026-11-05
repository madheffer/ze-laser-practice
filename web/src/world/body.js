// Your own body in third person (CS2Fixes !tp): the stock CT agent, standing where you are, facing your yaw,
// holding the default CT knife, crouching as you duck.
//
// How it is posed is vpkstuff's previewer (frontend/previewer/tp.js), cut down to what a STOCK agent needs:
//   - CS2 applies a clip's translation channel on every bone, so the pose is rebuilt on the clip's own STOCK
//     skeleton (pose JSON: `skeleton` + per-bone tracks) and copied onto the model in world space. The model's bind
//     translations never drive anything (they only feed the inverse bind), exactly as in game.
//   - The stance is CS2's knife-class aim pose, `idle_knife` (ABSOLUTE on every bone: sampled at t=0 it IS the
//     stance). Ducking blends to the same class's `idle_crouch_knife`, also absolute, by the duck amount, the way the
//     anim graph's stand/crouch blend reads m_flDuckAmount. No locomotion: you slide in the stance.
//   - The agent's _TWIST bones take a share of their target's roll (its CTiltTwistConstraints, tp.js's solve).
//   - The knife rides the stock skeleton's `wpn` bone through its own `weapon` root bone (the authored mount).
// A stock agent has no proportion (twin) rig, so tp.js's twin/partner/IK paths are not needed here.
//
// Assets (public/player/, gitignored, Valve content): `lasers-bake --player` writes the two glbs; the stance files
// come from vpkstuff's clip decode + tools/tp-pose.mjs (README "Third person").
import * as THREE from 'three';
import { loadGltf, unwrapToSourceSpace, sampleVec, sampleQuat } from '../weapons/fp/util.js';
import { fetchJson } from '../lib/fetch.js';
import { clamp01 } from '../lib/math.js';
import { DEG } from './entities/math.js';

const BASE = `${import.meta.env?.BASE_URL ?? '/'}player/`;
const FILES = {
  body: 'ctm_sas/ctm_sas.glb',
  constraints: 'ctm_sas/ctm_sas.constraints.json',
  knife: 'knife_default_ct/weapon_knife_default_ct.glb',
  stand: 'clips/pose_idle_knife.json',
  crouch: 'clips/pose_idle_crouch_knife.json',
};
// The agent glb carries every mesh group: only the third-person body + gloves are drawn (first-person arms and
// sleeves, the defuse kit a ZE human never carries, and VRF's empty skeleton reference mesh stay hidden).
const DRAWN = /thirdperson/i;
const MOUNT_BONES = ['weapon', 'weapon_offset'];
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const ONE = new THREE.Vector3(1, 1, 1);

// tp.js swingTwist: the part of q that rotates about `axis`
function swingTwist(q, axis, out) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  if (out.lengthSq() < 1e-12) out.set(0, 0, 0, 1); else out.normalize();
  return out;
}

export class PlayerBody {
  // onModel(root): once loaded (main.js: the particle lights, world/lighting.js patchDynamic)
  constructor(scene, { log = () => {}, onModel = null } = {}) {
    this.log = log;
    this.onModel = onModel;
    this.place = new THREE.Group(); // feet at the origin, turned by yaw (Source units, Z up)
    this.place.visible = false;
    this.place.name = 'player-body';
    scene.add(this.place);
    this.ready = false;
    this.posedAt = NaN;
    this._m = new THREE.Matrix4(); this._w = new THREE.Matrix4(); this._inv = new THREE.Matrix4();
    this._p = new THREE.Vector3(); this._p2 = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion();
    this._tq = new THREE.Quaternion(); this._pq = new THREE.Quaternion(); this._rel = new THREE.Quaternion();
    this._twist = new THREE.Quaternion(); this._dq = new THREE.Quaternion();
  }

  async load() {
    const [gltf, stand] = await Promise.all([loadGltf(BASE + FILES.body), fetchJson(BASE + FILES.stand)]);
    const crouch = await fetchJson(BASE + FILES.crouch).catch((e) => { this.log(`body: no crouch stance (${e.message}), standing only`); return null; });
    this.stand = stand.clips[0];
    this.crouch = crouch?.clips?.[0] ?? null;
    this.skeleton = stand.skeleton;
    this.order = this._parentFirst(stand.skeleton);
    this.stockWorld = new Map(this.order.map((n) => [n, new THREE.Matrix4()]));

    this.root = gltf.scene;
    this.place.add(unwrapToSourceSpace(this.root));
    this.joints = new Map();
    this.root.traverse((o) => {
      if (o.isBone) this.joints.set(o.name, o);
      if (o.isMesh) {
        o.visible = DRAWN.test(`${o.name}/${o.parent?.name ?? ''}`);
        o.frustumCulled = false; // posed far from its bind bounds; it is one character
      }
    });
    const missing = this.order.filter((n) => n !== 'camera' && !n.startsWith('attach') && !this.joints.has(n)); // attach*: IK targets, not skinned
    if (missing.length) this.log(`body: ${missing.length} stance bones not on the model (${missing.slice(0, 4).join(', ')})`);

    this.twists = [];
    try {
      const c = await fetchJson(BASE + FILES.constraints);
      for (const t of c.twists || []) {
        const slave = this.joints.get(t.slave), target = this.joints.get(t.target);
        if (!slave || !target) continue;
        this.twists.push({ slave, target, weight: Number(t.weight) || 0, slaveBind: slave.quaternion.clone(),
          targetAxis: AXES[t.targetAxis] || AXES[0], slaveAxis: AXES[t.slaveAxis] || AXES[0] });
      }
    } catch (e) { this.log(`body: no twist constraints (${e.message})`); }

    try { this.knife = await this._loadKnife(); } catch (e) { this.log(`body: no knife (${e.message}), the body alone`); }
    this.onModel?.(this.place);
    this.ready = true;
    this.log(`body: ctm_sas, ${this.joints.size} bones, ${this.twists.length} twist constraints${this.crouch ? ', crouch stance' : ''}`);
  }

  // state: { visible, origin (feet, Source units), yaw (deg), ducked, duckAmount (0..1), onGround }
  update(state) {
    if (!this.ready) return;
    this.place.visible = !!state.visible;
    if (!state.visible) return;
    const o = state.origin;
    this.place.position.set(o[0], o[1], o[2]);
    this.place.rotation.set(0, 0, (state.yaw || 0) * DEG);
    const w = this.crouch ? clamp01(state.duckAmount ?? (state.ducked ? 1 : 0)) : 0;
    // the pose depends only on the duck blend (bone locals do not change with where you stand): re-pose on change
    if (!(Math.abs(w - this.posedAt) < 1e-3)) { this._pose(w); this.posedAt = w; }
  }

  // parent-first order of the stock skeleton, so world matrices accumulate in one pass
  _parentFirst(skel) {
    const order = [], seen = new Set();
    const visit = (n, depth) => {
      if (seen.has(n) || depth > 64 || !skel[n]) return;
      if (skel[n].parent) visit(skel[n].parent, depth + 1);
      if (!seen.has(n)) { seen.add(n); order.push(n); }
    };
    for (const n of Object.keys(skel)) visit(n, 0);
    return order;
  }

  // one bone's local transform at t=0 of a clip (tracks missing -> the stock rest offset)
  _local(clip, name, q, p) {
    const tr = clip?.bones[name], st = this.skeleton[name];
    if (!sampleQuat(tr?.rot, 0, q)) q.set(st.rot[0], st.rot[1], st.rot[2], st.rot[3]);
    if (!sampleVec(tr?.pos, 0, p)) p.set(st.pos[0], st.pos[1], st.pos[2]);
  }

  _pose(w) {
    this.place.updateMatrixWorld(true);
    const align = this.place.matrixWorld;
    // 1. CS2's skeleton for this blend, in the body's own space
    for (const n of this.order) {
      this._local(this.stand, n, this._q, this._p);
      if (w > 0) {
        this._local(this.crouch, n, this._q2, this._p2);
        this._q.slerp(this._q2, w);
        this._p.lerp(this._p2, w);
      }
      const local = this._m.compose(this._p, this._q, ONE);
      const par = this.skeleton[n].parent && this.stockWorld.get(this.skeleton[n].parent);
      const out = this.stockWorld.get(n);
      if (par) out.multiplyMatrices(par, local); else out.copy(local);
    }
    // 2. copied onto the model in world space (scale dropped: the bind's metre->inch scale stays in the parents)
    for (const n of this.order) {
      const o = this.joints.get(n);
      if (!o) continue;
      this._w.multiplyMatrices(align, this.stockWorld.get(n));
      this._m.copy(o.parent.matrixWorld).invert().multiply(this._w).decompose(this._p, this._q, this._s);
      o.position.copy(this._p);
      o.quaternion.copy(this._q);
      o.updateMatrix();
      o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
    }
    this.root.updateMatrixWorld(true);
    // 3. twist bones: a share of the target's roll about the constraint axis, on top of their authored local
    for (const c of this.twists) {
      c.target.matrixWorld.decompose(this._p, this._tq, this._s);
      c.target.parent.matrixWorld.decompose(this._p, this._pq, this._s);
      this._rel.copy(this._pq).invert().multiply(this._tq);
      swingTwist(this._rel, c.targetAxis, this._twist);
      let angle = 2 * Math.acos(Math.min(1, Math.abs(this._twist.w)));
      if (this._twist.x * c.targetAxis.x + this._twist.y * c.targetAxis.y + this._twist.z * c.targetAxis.z < 0) angle = -angle;
      this._dq.setFromAxisAngle(c.slaveAxis, angle * c.weight);
      c.slave.quaternion.copy(c.slaveBind).multiply(this._dq);
      c.slave.updateMatrix();
      c.slave.updateMatrixWorld(true);
    }
    // 4. the knife on the stock `wpn` (holder is a child of `place`, so the body-space matrix is its local one)
    const wpn = this.stockWorld.get('wpn');
    if (this.knife && wpn) this.knife.holder.matrix.multiplyMatrices(wpn, this.knife.mountInv);
  }

  async _loadKnife() {
    const g = await loadGltf(BASE + FILES.knife);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.add(unwrapToSourceSpace(g.scene));
    holder.updateMatrixWorld(true);
    let mount = null;
    for (const n of MOUNT_BONES) if (!mount) g.scene.traverse((o) => { if (!mount && o.name === n) mount = o; });
    if (!mount) throw new Error('no weapon mount bone');
    g.scene.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    // where the mount bone sits in the holder, position + rotation only (the glb's own scale is the item's size)
    mount.matrixWorld.decompose(this._p, this._q, this._s);
    const mountInv = new THREE.Matrix4().compose(this._p, this._q, ONE).invert();
    this.place.add(holder);
    return { holder, mountInv };
  }
}
