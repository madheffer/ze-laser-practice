// ParticleSystem: collections, control points, particle streams and the tick (README.md, the
// contract). Rules cite RE §n of PARTICLE_RENDERING.md; anything without evidence is UNSETTLED.
import { evalFloat } from './inputs.js';
import {
  A, INT_ATTRS, STREAMS, VECTOR_ATTRS, makeRandomTable, newControlPoint, setCpOrientation, setCpPosition, vec3,
} from './functions/common.js';
import { FUNCTIONS } from './functions/index.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (Array.isArray(v) ? v.map(clone) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);
const LISTS = ['m_PreEmissionOperators', 'm_Emitters', 'm_Initializers', 'm_Operators', 'm_ForceGenerators', 'm_Constraints', 'm_Renderers'];

// Undo defaults.js's compaction: { "$": struct, ...diff } is that struct with the diff on top,
// a class is its "$base" with its own fields on top (gen-particle-defaults.mjs).
export function expandDefaults(defaults) {
  const cache = new Map();
  const expand = (v) => {
    if (Array.isArray(v)) return v.map(expand);
    if (!isObj(v)) return v;
    const { $: s, $base: b, ...rest } = v;
    const own = Object.fromEntries(Object.entries(rest).map(([k, x]) => [k, expand(x)]));
    if (s) return merge(struct(s), own);
    if (b) return merge(expand(defaults.bases[b] || {}), own);
    return own;
  };
  const struct = (n) => expand(defaults.structs[n] || {});
  const enumOf = new Map();
  for (const [name, byValue] of Object.entries(defaults.enums || {})) for (const s of Object.values(byValue)) enumOf.set(s, name);
  const classDefault = (n) => {
    if (!cache.has(n)) cache.set(n, defaults.classes[n] ? expand(defaults.classes[n]) : null);
    const d = cache.get(n);
    return d ? clone(d) : null;
  };
  return { classDefault, struct, elements: defaults.elements || {}, enums: defaults.enums || {}, enumOf };
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

// A compiled file omits every field equal to its class default (RE §11 "Compiled files omit
// defaults"), and the game is assumed to apply loaded KV3 on a default-constructed object
// (same section), so a field reads data when present and the default otherwise, recursively.
function overlay(d, v, key, ctx) {
  if (v === undefined) return d;
  if (isObj(d) && typeof d.m_nType === 'string') {
    // Shorthand inputs: a bare number is a literal float input, an array a literal vector.
    if (typeof v === 'number' && d.m_nType.startsWith('PF_')) v = { m_nType: 'PF_TYPE_LITERAL', m_flLiteralValue: v };
    else if (Array.isArray(v) && d.m_nType.startsWith('PVEC_')) v = { m_nType: 'PVEC_TYPE_LITERAL', m_vLiteralValue: v };
  }
  if (Array.isArray(v)) {
    if (LISTS.includes(key)) return v.map((fn) => resolveFunction(fn, ctx));
    const el = ctx.elements[key];
    return el ? v.map((e) => overlay(ctx.struct(el), e, null, ctx)) : v;
  }
  if (isObj(v) && isObj(d)) {
    const out = { ...d };
    for (const [k, x] of Object.entries(v)) out[k] = overlay(d[k], x, k, ctx);
    return out;
  }
  // An enum written as its integer reads as its name (the default is the name).
  if (typeof v === 'number' && typeof d === 'string' && ctx.enumOf.has(d)) return ctx.enums[ctx.enumOf.get(d)][v] ?? v;
  return v;
}

// One function (or the system definition) with its class defaults applied.
export function resolveFunction(data, ctx) {
  const cls = data._class || 'CParticleSystemDefinition';
  const d = ctx.classDefault(cls);
  if (!d) ctx.missingDefaults?.add(cls);
  const out = overlay(d || {}, data, null, ctx);
  out._class = cls;
  return out;
}

// Preview bounds, not engine behaviour: a broken or hostile document must not stall the tab.
// Each one reports when it bites, so it can never pass for how the game behaves.
const MAX_PARTICLES = 8192, MAX_COLLECTIONS = 64, MAX_PRESIM = 10, MIN_STEP = 1 / 240;
const normPath = (p) => String(p || '').toLowerCase().replace(/\\/g, '/').replace(/_c$/, '');

export class ParticleSystem {
  constructor(doc, opts = {}) {
    if (!opts.defaults) throw new Error('ParticleSystem needs opts.defaults (defaults.js)');
    this.doc = doc;
    this.opts = opts;
    this.ctx = opts.defaults.classDefault ? opts.defaults : expandDefaults(opts.defaults);
    this.ctx.missingDefaults = new Set();
    this.reports = [];
    this._reported = new Set();
    this.detailLevel = opts.detailLevel ?? 0;
    // Shifts every collection's seed offset, so separately spawned copies of one effect draw
    // different CONSTANT randoms, as each spawned system does in game (a per-shot tracer gate).
    this.variant = opts.variant | 0;
    this.camera = opts.camera || null;
    this.table = makeRandomTable(opts.random);
    // opts.now: the stage's clock, a number or a function returning one (not used by the simulation).
    this.now = typeof opts.now === 'function' ? opts.now : () => opts.now ?? 0;
    this.byPath = new Map((doc.systems || []).map((s) => [normPath(s.path), s]));
    this.cps = new Map();
    this._build();
  }

  report(msg) {
    if (this._reported.has(msg)) return;
    this._reported.add(msg);
    this.reports.push(msg);
  }

  _build() {
    const rootPath = normPath(this.doc.root || this.doc.systems?.[0]?.path);
    this.collections = [];
    this.root = this._collection(rootPath, null, null, 0);
    for (const c of this.ctx.missingDefaults) this.report(`no Valve default for ${c}; its fields read only what the file carries`);
  }

  _collection(path, parent, info, depth) {
    const sys = this.byPath.get(path);
    if (!sys) { this.report(`child system ${path} is not in the document`); return null; }
    if (depth > 16) { this.report(`${path}: children nest deeper than 16, cut`); return null; }
    for (let a = parent; a; a = a.parent) if (a.path === path) { this.report(`${path}: names itself as a child, cut`); return null; }
    if (this.collections.length >= MAX_COLLECTIONS) { this.report(`more than ${MAX_COLLECTIONS} child systems, ${path} cut`); return null; }
    const def = resolveFunction(sys.data || {}, this.ctx);
    const cap = Math.min(MAX_PARTICLES, Math.max(0, def.m_nMaxParticles | 0));
    if ((def.m_nMaxParticles | 0) > MAX_PARTICLES) this.report(`${path}: m_nMaxParticles ${def.m_nMaxParticles} capped at ${MAX_PARTICLES} for the preview`);
    const attr = {}, init = {};
    for (const a of STREAMS) {
      const n = VECTOR_ATTRS.has(a) ? 3 * cap : cap;
      attr[a] = INT_ATTRS.has(a) ? new Int32Array(n) : new Float32Array(n);
      init[a] = INT_ATTRS.has(a) ? new Int32Array(n) : new Float32Array(n);
    }
    const c = {
      path, def, count: 0, attr, init, killed: new Uint8Array(cap), capacity: cap,
      renderers: def.m_Renderers.map((p) => ({ cls: p._class, p })),
      // Collection time starts at minus the pre-sim time and advances by dt each frame (RE §11,
      // 0x180038c20 / 0x180047af9).
      time: -Math.min(MAX_PRESIM, Math.max(0, +def.m_flPreSimulationTime || 0)),
      dt: 0, prevDt: 0, controlPoints: parent ? parent.controlPoints.map((p) => (p ? clone(p) : p)) : [newControlPoint()],
      children: [], parent, sys: this, table: this.table, state: new Map(), info,
      // Random counter c910, per-collection seed offset c914, per-frame op seed c918 (RE §11
      // randomTable). UNSETTLED: the seed offset's value.
      rnd: { counter: 0, offset: (this.collections.length * 0x3d1 + this.variant * 0x9e5) & 0xfff, frameSeed: 0 },
      // Operator time origin (RE §11 collection layout +0x60). UNSETTLED: its value; 0, so operator time is collection time.
      nextId: 0, opTimeOrigin: 0, endcap: { active: false, start: 0 }, emissionStopped: false,
      started: false, depth, childRefs: [],
    };
    c.startTime = c.time; // emitter start times count from here (VRF StartAge)
    c.concurrent = () => (this.opts.concurrent ? this.opts.concurrent(c.path) : c.emissionStopped ? 0 : 1);
    this.collections.push(c);
    // Children follow the parent, depth first (README: root first, then children depth-first).
    for (const ch of def.m_Children || []) {
      if (ch.m_bDisableChild) continue;
      c.childRefs.push(normPath(ch.m_ChildRef));
      const k = this._collection(normPath(ch.m_ChildRef), c, ch, depth + 1);
      if (k) { k.slot = c.childRefs.length - 1; c.children.push(k); }
    }
    return c;
  }

  setControlPoint(i, t) {
    const prev = this.cps.get(i) || newControlPoint();
    const cp = { ...prev };
    if (t.position) cp.position = vec3(t.position);
    for (const k of ['forward', 'left', 'up']) if (t[k]) cp[k] = vec3(t[k]);
    this.cps.set(i, cp);
    // Any subset; children inherit (RE §11 collection layout +0x20/+0x30).
    if (t.position) setCpPosition(this.root, i, cp.position);
    if (t.forward || t.left || t.up) setCpOrientation(this.root, i, cp.forward, cp.left, cp.up);
  }

  stopEmission(endcap = false) {
    for (const c of this.collections) {
      c.emissionStopped = true;
      if (endcap && !c.endcap.active) c.endcap = { active: true, start: c.time };
    }
  }

  restart() {
    // A preview restart plays the effect again from nothing, keeping the control points.
    this._build();
    for (const [i, cp] of [...this.cps]) this.setControlPoint(i, cp);
  }

  // Swap in an edited document's definitions without touching live particles, if the shape is kept (systems,
  // function classes, capacities; every patch op does); false means rebuild. State built from old fields
  // (emitter counts, sequence lists, pre-sim) stays, so such an edit shows from the next emission.
  retune(doc) {
    const byPath = new Map((doc.systems || []).map((s) => [normPath(s.path), s]));
    const defs = [];
    for (const c of this.collections) {
      const sys = byPath.get(c.path);
      if (!sys) return false;
      const def = resolveFunction(sys.data || {}, this.ctx);
      if (Math.min(MAX_PARTICLES, Math.max(0, def.m_nMaxParticles | 0)) !== c.capacity) return false;
      for (const k of LISTS) {
        const a = c.def[k] || [], b = def[k] || [];
        if (a.length !== b.length || a.some((fn, i) => fn._class !== b[i]._class)) return false;
      }
      const kids = (def.m_Children || []).filter((ch) => !ch.m_bDisableChild);
      if (kids.length !== c.childRefs.length || kids.some((ch, i) => normPath(ch.m_ChildRef) !== c.childRefs[i])) return false;
      defs.push([c, def, kids]);
    }
    for (const [c, def, kids] of defs) {
      for (const k of LISTS) (c.def[k] || []).forEach((fn, i) => { if (c.state.has(fn)) { c.state.set(def[k][i], c.state.get(fn)); c.state.delete(fn); } });
      c.def = def;
      c.renderers = def.m_Renderers.map((p) => ({ cls: p._class, p }));
      for (const k of c.children) k.info = kids[k.slot];
    }
    this.doc = doc;
    this.byPath = byPath;
    return true;
  }

  step(dt) {
    if (!this.root) return;
    stepTree(this.root, Math.max(0, +dt || 0));
  }
}

// One frame of a collection and its children. A frame longer than m_flMaximumTimeStep is split
// into substeps, and pre-simulation runs in maximum-timestep substeps up to time 0 (VRF
// cross-check, UNSETTLED: the notes do not cover substepping).
function stepTree(c, dt) {
  const def = c.def;
  const maxStep = def.m_flMaximumTimeStep > 0 ? Math.max(MIN_STEP, def.m_flMaximumTimeStep) : 0.1;
  if (!c.started) {
    c.started = true;
    startCollection(c);
    while (c.time < 0) simulate(c, Math.min(maxStep, -c.time));
  }
  let left = Math.min(dt, maxStep * 10);
  while (left > 1e-9) {
    const s = Math.min(left, maxStep);
    left -= s;
    simulate(c, s);
  }
  for (const ch of c.children) {
    // a child C_OP_EnableChildrenFromParentParticleCount keeps off (particles.dll 63babcbf 0x1802857e0: time -FLT_MAX, flag 0x40)
    if (ch.disabled) continue;
    // A delayed child waits out m_flDelay on its parent's clock; an endcap child runs only in the
    // parent's endcap (VRF cross-check, UNSETTLED).
    if (ch.info?.m_bEndCap ? !c.endcap.active : c.time < (+ch.info?.m_flDelay || 0)) continue;
    stepTree(ch, dt);
  }
  // CP previous position for the next frame's creation-time interpolation (RE §11 0x1800c1e70
  // reads it). UNSETTLED: when the game copies position into previous position.
  for (const cp of c.controlPoints) if (cp) cp.prevPosition = cp.position.slice();
}

function startCollection(c) {
  // m_nInitialParticles are emitted at start (VRF cross-check, UNSETTLED).
  const n = Math.min(c.def.m_nInitialParticles | 0, c.capacity);
  if (n > 0) emitParticles(c, new Array(n).fill(0));
}

// Operator strength (RE §11 "Operator strength and time", 0x18003f820 / 0x18003f6e0).
export function operatorTime(fn, c) {
  if (fn.m_flOpFadeOscillatePeriod > 0) return ((c.time / fn.m_flOpFadeOscillatePeriod) % 1 + 1) % 1;
  let t = Math.max(0, c.time - c.opTimeOrigin);
  if (fn.m_bNormalizeToStopTime && fn.m_nOpEndCapState === 'PARTICLE_ENDCAP_ENDCAP_ON') t = Math.max(0, t - c.endcap.start);
  if (fn.m_nOpTimeOffsetSeed) {
    const r = c.table[(c.rnd.offset + fn.m_nOpTimeOffsetSeed) & 0xfff];
    t = Math.max(0, t + fn.m_flOpTimeOffsetMin + (fn.m_flOpTimeOffsetMax - fn.m_flOpTimeOffsetMin) * r);
  }
  if (fn.m_nOpTimeScaleSeed && t > fn.m_flOpStartFadeInTime) {
    const r = c.table[(c.rnd.offset + fn.m_nOpTimeScaleSeed) & 0xfff];
    const s = Math.max(1e-4, fn.m_flOpTimeScaleMin + (fn.m_flOpTimeScaleMax - fn.m_flOpTimeScaleMin) * r);
    t = fn.m_flOpStartFadeInTime + (t - fn.m_flOpStartFadeInTime) / s;
  }
  return t;
}

export function runStrength(fn, c) {
  if (fn.m_bDisableOperator) return 0;
  const ec = fn.m_nOpEndCapState;
  if (ec === 'PARTICLE_ENDCAP_ENDCAP_OFF' && c.endcap.active) return 0;
  if (ec === 'PARTICLE_ENDCAP_ENDCAP_ON' && !c.endcap.active) return 0;
  const s = evalFloat(fn.m_flOpStrength ?? 1, c, -1);
  const a = +fn.m_flOpStartFadeInTime || 0, eIn = +fn.m_flOpEndFadeInTime || 0;
  const sOut = +fn.m_flOpStartFadeOutTime || 0, eOut = +fn.m_flOpEndFadeOutTime || 0;
  // "No fade times configured" is precomputed at op+0x1b9; read here as all four being zero.
  if ((!a && !eIn && !sOut && !eOut) || s <= 0) return s;
  const t = operatorTime(fn, c);
  const b = Math.max(eIn, a), cc = Math.max(sOut, b), d = Math.max(eOut, cc);
  if (t < a) return 0;
  if (eOut > 0 && t > eOut) return 0;
  let k = 1;
  if (t < b && a < b) k = Math.min(1, (t - a) / (b - a));
  if (cc < t && cc < d) k = Math.min(k, (t - d) / (cc - d));
  return Math.max(0, s) * k;
}

const impl = (c, fn) => {
  const f = FUNCTIONS[fn._class];
  if (!f) { c.sys.report(`${fn._class} is not implemented (no-op)`); return null; }
  if (f.noop) c.sys.report(`${fn._class} is a no-op: ${f.noop}`);
  return f;
};
const stateOf = (c, fn) => { if (!c.state.has(fn)) c.state.set(fn, {}); return c.state.get(fn); };

// Spawn particles, one per age-at-spawn, then run the initializers on them.
export function emitParticles(c, ages) {
  const def = c.def;
  const start = c.count;
  for (const age of ages) {
    if (c.count >= c.capacity) break; // max particles
    const i = c.count++;
    c.killed[i] = 0;
    for (const a of STREAMS) {
      const s = c.attr[a];
      if (VECTOR_ATTRS.has(a)) s.fill(0, 3 * i, 3 * i + 3); else s[i] = 0;
    }
    // Particle constants. Colour from m_ConstantColor (constructor colour 0xFFFFFFFF, RE §10); the
    // rest from CParticleSystemDefinition's named constants, alpha and alpha alternate 1, trail
    // length 0.1, rotations authored in degrees (VRF cross-check, UNSETTLED).
    const col = def.m_ConstantColor || [255, 255, 255];
    c.attr[A.COLOR].set([col[0] / 255, col[1] / 255, col[2] / 255], 3 * i);
    c.attr[A.NORMAL].set(vec3(def.m_ConstantNormal, [0, 0, 1]), 3 * i);
    c.attr[A.RADIUS][i] = def.m_flConstantRadius;
    c.attr[A.LIFE][i] = def.m_flConstantLifespan;
    c.attr[A.ROLL][i] = def.m_flConstantRotation * Math.PI / 180;
    c.attr[A.ROLL_SPEED][i] = def.m_flConstantRotationSpeed * Math.PI / 180;
    c.attr[A.SEQUENCE][i] = def.m_nConstantSequenceNumber;
    c.attr[A.SEQUENCE1][i] = def.m_nConstantSequenceNumber1;
    c.attr[A.ALPHA][i] = 1;
    c.attr[A.ALPHA2][i] = 1;
    c.attr[A.TRAIL][i] = 0.1;
    c.attr[A.CREATION][i] = c.time - age;
    // Particle ID: the number emitted so far in this collection. UNSETTLED.
    c.attr[A.ID][i] = c.nextId++;
    // A particle no initializer places sits at CP0 (VRF cross-check, UNSETTLED).
    const p = c.controlPoints[0]?.position || [0, 0, 0];
    c.attr[A.POSITION].set(p, 3 * i);
    c.attr[A.PREV].set(p, 3 * i);
  }
  const end = c.count;
  if (end <= start) return;
  for (const fn of def.m_Initializers) {
    const f = impl(c, fn);
    if (!f || !f.init) continue;
    const s = runStrength(fn, c);
    if (s <= 0) continue;
    f.init(fn, c, start, end, s, stateOf(c, fn));
  }
  // The initial-value stream (coll+0x4c8, RE §11) holds the spawn state the initializers left.
  // UNSETTLED: the exact point where the game copies it (VRF snapshots it here).
  for (const a of STREAMS) {
    const n = VECTOR_ATTRS.has(a) ? 3 : 1;
    c.init[a].set(c.attr[a].subarray(n * start, n * end), n * start);
  }
}

// One simulation step: time, pre-emission operators, emitters (initialising what they spawn), operators,
// constraints, kills. Time precedes pre-emission (0x180047af9 < 0x180047cb0, RE §11); the rest of the order is
// a VRF cross-check, UNSETTLED.
function simulate(c, dt) {
  if (dt !== 0) c.prevDt = dt; // previous non-zero dt, written at frame start (0x180047adb)
  c.dt = dt;
  c.time += dt;
  const def = c.def;
  for (const fn of def.m_PreEmissionOperators) {
    const f = impl(c, fn);
    if (!f || !f.pre) continue;
    // The per-frame loop skips m_bRunOnce operators (0x180047cb0); where they run is RE §11
    // UNSETTLED 1, so they run once on the first frame here.
    const st = stateOf(c, fn);
    if (fn.m_bRunOnce && st.ranOnce) continue;
    const s = runStrength(fn, c);
    if (s <= 0) continue;
    st.ranOnce = true;
    f.pre(fn, c, s, st);
  }
  if (!c.emissionStopped) {
    for (const fn of def.m_Emitters) {
      const f = impl(c, fn);
      if (!f || !f.emit) continue;
      const s = runStrength(fn, c);
      if (s <= 0) continue;
      const ages = f.emit(fn, c, s, stateOf(c, fn));
      if (ages && ages.length) emitParticles(c, ages);
    }
  }
  c.killed.fill(0, 0, c.count);
  for (const fn of def.m_Operators) {
    const f = impl(c, fn);
    if (!f || !f.op) continue;
    const s = runStrength(fn, c);
    if (s <= 0) continue;
    f.op(fn, c, s, stateOf(c, fn));
  }
  for (const fn of def.m_Constraints) {
    const f = impl(c, fn);
    if (!f || !f.constrain) continue;
    if (runStrength(fn, c) <= 0) continue;
    f.constrain(fn, c, stateOf(c, fn));
  }
  for (const fn of def.m_ForceGenerators) impl(c, fn);
  compact(c);
  if (c.restartAt != null && c.time >= c.restartAt) rearm(c);
}

// Remove killed particles, keeping the survivors in order (ropes join particles in index order).
// UNSETTLED: whether the game swaps from the end instead (VRF compacts in order).
function compact(c) {
  let w = 0;
  for (let r = 0; r < c.count; r++) {
    if (c.killed[r]) continue;
    if (w !== r) {
      for (const a of STREAMS) {
        const n = VECTOR_ATTRS.has(a) ? 3 : 1;
        c.attr[a].copyWithin(n * w, n * r, n * r + n);
        c.init[a].copyWithin(n * w, n * r, n * r + n);
      }
    }
    w++;
  }
  c.count = w;
}

// C_OP_RestartAfterDuration's restart: emitters re-arm on the current clock, live particles and
// the clock are kept, children restart too (VRF cross-check, UNSETTLED).
export function rearm(c) {
  c.restartAt = null;
  for (const fn of [...c.def.m_Emitters, ...c.def.m_PreEmissionOperators]) c.state.delete(fn);
  for (const fn of c.def.m_Operators) if (FUNCTIONS[fn._class]?.rearm) FUNCTIONS[fn._class].rearm(stateOf(c, fn));
  c.emitterOrigin = c.time;
  for (const ch of c.children) rearm(ch);
}
