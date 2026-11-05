import * as THREE from 'three';
import { angleVectors } from './barn.js';
import { makeInputs } from './controls.js';
import { applySelfIllum } from '../../../world/selfillum.js';

// C_OP_RenderModels: a model per live particle (m_ModelList), posed from the particle's position, angles (pitch /
// yaw / roll, attributes 20 / 12 / 4, radians) and radius. ze_offliner's lasers are this (offliner_laser.vpcf draws
// models/offliner/laser.vmdl on a door that carries the laser's hurt), so without it they are invisible.
//
// What is drawn, from the renderer's own fields (particles.dll's draw code is not traced: UNSETTLED where noted):
// - the model: m_ModelList[0], or with several, the particle's sequence (attribute 9) picks one (UNSETTLED: the
//   m_flManualModelSelection / m_modelInput rules)
// - pose: Source's AngleMatrix(pitch, yaw, roll) (forward, left, up columns), + m_vecLocalRotation (degrees, pitch yaw
//   roll), at the position + m_vecLocalOffset turned with it
// - scale: radius x m_flRadiusScale x m_vecComponentScale, as Source 1's model renderer (radius 1 = the model as
//   authored); m_bIgnoreRadius keeps 1
// - m_bCenterOffset: the model's bounds centre sits on the particle instead of its origin
// - alpha (attribute 7 x m_flAlphaScale) fades the copy; tint (attribute 6) multiplies its colour unless m_bSuppressTint
// Not drawn (reported): m_bOrientZ, animation (m_bAnimated), m_hOverrideMaterial, m_nModelScaleCP, m_bLocalScale, skins.
//
// The model comes from the map (models/<path>.glb, the bake exports what particles name): MapEffects.getModel(path)
// -> Promise<glTF scene>, MapEffects.modelToSource the glTF -> Source units matrix (world/assets.js GLTF_TO_SOURCE).

const UNDRAWN = [['m_bOrientZ', true], ['m_bAnimated', true], ['m_bLocalScale', true]];
const m4 = new THREE.Matrix4(), rot = new THREE.Matrix4(), off = new THREE.Vector3(), scl = new THREE.Vector3();

export class ModelRenderer {
  constructor(effects) {
    this.effects = effects;
    this.mesh = new THREE.Group(); // EffectInstance adds .mesh to its group: the copies live under it, world space
    this.mesh.matrixAutoUpdate = false;
    this.models = new Map(); // path -> { scene, center } once loaded (null: none)
    this.pool = []; // [{ obj, path, mats }]
    this.reported = false;
  }

  model(path) {
    if (this.models.has(path)) return this.models.get(path);
    this.models.set(path, undefined); // loading
    const p = this.effects.getModel?.(path);
    if (!p) { this.models.set(path, null); this.effects.report(`C_OP_RenderModels: model ${path} not baked`); return null; }
    p.then((scene) => {
      if (!scene) { this.models.set(path, null); this.effects.report(`C_OP_RenderModels: model ${path} failed to load`); return; }
      // the model in Source units, and its bounds centre there (m_bCenterOffset)
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(this.effects.modelToSource || new THREE.Matrix4());
      holder.add(scene.clone(true));
      holder.traverse((o) => { if (o.isMesh) applySelfIllum(o); }); // CS2's self-illum glow (world/selfillum.js)
      holder.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(holder);
      const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      this.models.set(path, { holder, center });
    }, () => this.models.set(path, null));
    return undefined;
  }

  copy(k, path, entry) {
    let c = this.pool[k];
    if (c && c.path !== path) { this.mesh.remove(c.obj); c = null; }
    if (!c) {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      obj.add(entry.holder.clone(true));
      const mats = [];
      obj.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.frustumCulled = false; mats.push({ m: o.material, color: o.material.color?.clone(), opacity: o.material.opacity, transparent: o.material.transparent }); } });
      c = this.pool[k] = { obj, path, mats };
      this.mesh.add(obj);
    }
    return c;
  }

  update(col, p) {
    const unsupported = [];
    if (!this.reported) {
      this.reported = true;
      for (const [k, v] of UNDRAWN) if (p[k] === v) unsupported.push(k);
      if (p.m_hOverrideMaterial) unsupported.push('m_hOverrideMaterial');
      if ((p.m_nModelScaleCP ?? -1) >= 0) unsupported.push('m_nModelScaleCP');
    }
    const list = (Array.isArray(p.m_ModelList) ? p.m_ModelList : []).map((m) => String(m?.m_model || '')).filter(Boolean);
    const n = list.length ? col.count || 0 : 0;
    const A = col.attr || {};
    const at = (k, i, d) => (A[k] ? [A[k][3 * i], A[k][3 * i + 1], A[k][3 * i + 2]] : d);
    const R2D = 180 / Math.PI;
    // the vector / float fields are particle inputs (literal, per particle, ...): evaluated per particle
    const ev = makeInputs(col);
    let used = 0;
    for (let i = 0; i < n; i++) {
      const lr = ev.evalVec(p.m_vecLocalRotation, i, [0, 0, 0]), lo = ev.evalVec(p.m_vecLocalOffset, i, [0, 0, 0]);
      const cs = ev.evalVec(p.m_vecComponentScale, i, [1, 1, 1]);
      const radiusScale = ev.evalFloat(p.m_flRadiusScale, i, 1), alphaScale = ev.evalFloat(p.m_flAlphaScale, i, 1);
      if (!this.skinReported && ev.evalFloat(p.m_nSkin, i, 0)) { this.skinReported = true; unsupported.push('m_nSkin'); }
      const path = list.length > 1 ? list[Math.abs(Math.round(A[9]?.[i] ?? 0)) % list.length] : list[0];
      const entry = this.model(path);
      if (!entry) continue;
      const c = this.copy(used++, path, entry);
      const pitch = (A[20]?.[i] ?? 0) * R2D + lr[0], yaw = (A[12]?.[i] ?? 0) * R2D + lr[1], roll = (A[4]?.[i] ?? 0) * R2D + lr[2];
      const v = angleVectors(pitch, yaw, roll);
      const f = v.forward, u = v.up;
      const l = [u[1] * f[2] - u[2] * f[1], u[2] * f[0] - u[0] * f[2], u[0] * f[1] - u[1] * f[0]]; // left = up x forward
      rot.set(f[0], l[0], u[0], 0, f[1], l[1], u[1], 0, f[2], l[2], u[2], 0, 0, 0, 0, 1);
      const s = p.m_bIgnoreRadius ? 1 : (A[3]?.[i] ?? 1) * radiusScale;
      scl.set(s * cs[0], s * cs[1], s * cs[2]);
      const P = at(0, i, [0, 0, 0]);
      off.set(lo[0], lo[1], lo[2]);
      if (p.m_bCenterOffset) off.sub(entry.center.clone().multiply(scl));
      off.applyMatrix4(rot);
      m4.copy(rot).scale(scl).setPosition(P[0] + off.x, P[1] + off.y, P[2] + off.z);
      c.obj.matrix.copy(m4);
      c.obj.visible = true;
      const a = Math.max(0, Math.min(1, (A[7]?.[i] ?? 1) * alphaScale));
      const tint = p.m_bSuppressTint ? null : at(6, i, null);
      for (const mt of c.mats) {
        if (mt.color && mt.m.color) { mt.m.color.copy(mt.color); if (tint) mt.m.color.multiply(new THREE.Color(tint[0], tint[1], tint[2])); }
        mt.m.opacity = mt.opacity * a;
        mt.m.transparent = mt.transparent || a < 1;
      }
    }
    for (let k = used; k < this.pool.length; k++) if (this.pool[k]) this.pool[k].obj.visible = false;
    this.mesh.visible = used > 0;
    this.mesh.updateMatrixWorld(true);
    return { unsupported };
  }

  dispose() {
    for (const c of this.pool) if (c) for (const mt of c.mats) mt.m.dispose();
    this.pool.length = 0;
    this.mesh.removeFromParent();
  }
}
