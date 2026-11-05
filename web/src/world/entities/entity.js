// One map entity: its keyvalues and outputs, its place in the parent hierarchy, and its model's convex
// hulls placed in the world.
import * as THREE from 'three';
import { bool, ONE } from './math.js';
import { nameKey } from '../../lib/names.js';
import { assetKey } from '../../lib/paths.js';
import { meshSlabs } from '../hulls.js';

// a target name's lookup key: no [PR#] prefix, lower case (lib/names.js)
export const stripName = nameKey;

// One output connection from entities.json, with the fields the engine reads as strings / numbers (the
// file is a map's data: a number or object where a string belongs must not throw mid-tick).
function connection(c) {
  return {
    ...c,
    output: String(c.output ?? ''), target: String(c.target ?? ''), input: String(c.input ?? ''),
    param: c.param == null ? '' : String(c.param),
    delay: Number.isFinite(c.delay) ? c.delay : 0, times: Number.isFinite(c.times) ? c.times : -1,
  };
}

export class Entity {
  constructor(engine, data, id) {
    this.engine = engine;
    this.id = id;
    this.kv = { ...(data.kv && typeof data.kv === 'object' ? data.kv : {}) };
    this.io = (Array.isArray(data.io) ? data.io : []).filter((c) => c && typeof c === 'object').map(connection);
    this.cls = String(this.kv.classname || '').toLowerCase();
    this.name = this.kv.targetname || '';
    this.key = stripName(this.name);
    this.parent = null;
    this.children = new Set();
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.world = new THREE.Matrix4();
    this.worldStamp = -1;
    this.alive = true;
    this.enabled = !bool(this.kv.startdisabled);
    this.model = assetKey(this.kv.model || '');
    this.placedHulls = null;
    this.placedStamp = -1;
    this.placedSolid = null;
    this.placedSolidStamp = -1;
    this.visible = true;
    this.state = {};
  }

  setWorldTransform(m) {
    // place under the current parent keeping this world matrix
    const local = m.clone();
    if (this.parent) local.premultiply(this.parent.getWorld().clone().invert());
    const s = new THREE.Vector3();
    local.decompose(this.pos, this.quat, s);
    this.engine.moved(this);
  }

  getWorld() {
    const stamp = this.engine.stamp;
    if (this.worldStamp === stamp) return this.world;
    this.world.compose(this.pos, this.quat, ONE);
    if (this.parent) this.world.premultiply(this.parent.getWorld());
    this.worldStamp = stamp;
    return this.world;
  }

  worldOrigin() {
    const e = this.getWorld().elements;
    return [e[12], e[13], e[14]];
  }

  // Would parenting under p make a loop (p is this entity, or below it)? getWorld() and moveStamp() walk up the
  // parent chain, so a loop would hang the page; a map's SetParent inputs are data.
  wouldCycle(p) {
    for (let x = p; x; x = x.parent) if (x === this) return true;
    return false;
  }

  setParent(p) {
    if (p === this) p = null; // as before: parenting to itself clears the parent
    if (p && this.wouldCycle(p)) { this.engine.warnOnce(`cycle:${this.key}`, `SetParent loop ignored: ${this.name}`); return; }
    const w = this.getWorld().clone();
    if (this.parent) this.parent.children.delete(this);
    this.parent = p || null;
    if (this.parent) this.parent.children.add(this);
    this.setWorldTransform(w);
  }

  // World-space convex hulls of this entity's model ({planes, verts, edges, min, max}[]), cached until it moves.
  // A mesh-only shape is its bounding box here (triggers, bullets): solidHulls() is what you collide with.
  hulls() {
    const src = this.engine.assets.hulls[this.model];
    if (!src) return null;
    if (this.placedHulls && this.placedStamp === this.engine.moveStamp(this)) return this.placedHulls;
    this.placedHulls = placeHulls(src, this.getWorld());
    this.placedStamp = this.engine.moveStamp(this);
    return this.placedHulls;
  }

  // The hulls the player and physboxes collide with: hulls(), with each mesh-only shape's box swapped for its
  // triangles (world/hulls.js meshSlabs), so a hollow mesh (ze__hell_p's rooms) is walls and a floor, not a block.
  solidHulls() {
    const src = this.engine.assets.hulls[this.model];
    if (!src) return null;
    if (!src.some((h) => h.mesh)) return this.hulls();
    if (this.placedSolid && this.placedSolidStamp === this.engine.moveStamp(this)) return this.placedSolid;
    this.placedSolid = placeHulls(src.flatMap((h) => meshSlabs(h) || [h]), this.getWorld());
    this.placedSolidStamp = this.engine.moveStamp(this);
    return this.placedSolid;
  }

  fireOutput(output, activator, param) {
    this.engine.fireOutput(this, output, activator, param);
  }
}

// Model-space hulls placed by world matrix m: verts, bounds, planes and edge directions turned and moved.
function placeHulls(src, m) {
  const e = m.elements;
  const out = [];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3().setFromMatrix4(m);
  for (const h of src) {
    if (!h.planes) continue;
    const planes = new Float64Array(h.planes.length);
    const verts = new Float64Array(h.verts.length);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < h.verts.length; i += 3) {
      v.set(h.verts[i], h.verts[i + 1], h.verts[i + 2]).applyMatrix4(m);
      verts[i] = v.x; verts[i + 1] = v.y; verts[i + 2] = v.z;
      min[0] = Math.min(min[0], v.x); min[1] = Math.min(min[1], v.y); min[2] = Math.min(min[2], v.z);
      max[0] = Math.max(max[0], v.x); max[1] = Math.max(max[1], v.y); max[2] = Math.max(max[2], v.z);
    }
    // edge directions turn with the entity (hulls.js hullEdges): the exact box test's extra separating axes
    const edges = new Float64Array(h.edges?.length || 0);
    for (let i = 0; i < edges.length; i += 3) {
      n.set(h.edges[i], h.edges[i + 1], h.edges[i + 2]).applyMatrix3(nm).normalize();
      edges[i] = n.x; edges[i + 1] = n.y; edges[i + 2] = n.z;
    }
    for (let i = 0; i < h.planes.length; i += 4) {
      n.set(h.planes[i], h.planes[i + 1], h.planes[i + 2]).applyMatrix3(nm).normalize();
      planes[i] = n.x; planes[i + 1] = n.y; planes[i + 2] = n.z;
      planes[i + 3] = h.planes[i + 3] + n.x * e[12] + n.y * e[13] + n.z * e[14];
    }
    out.push({ planes, verts, edges, min, max, solid: h.solid, layers: h.layers ?? null });
  }
  return out;
}
