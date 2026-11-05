// Helpers every particle function shares: vector maths, the attribute table, the random table,
// control point writes and set methods. No three.js; runs in node for the tests.

export const FLT_EPSILON = 1.1920929e-7;
export const FLT_MAX = 3.4028234663852886e38;
export const DEG = 57.29578; // RE §11: angle attributes read as value*57.29578 (0x18006f510 case 0x15)
export const RAD = 0.0174533; // RE §11: C_OP_SetFloat writes angles as value*0.0174533 (0x18020bbc0)

// ParticleAttributeIndex_t (RE §11, pointer table rva 0x4d7a10). 19 is NONE.
export const A = {
  POSITION: 0, LIFE: 1, PREV: 2, RADIUS: 3, ROLL: 4, ROLL_SPEED: 5, COLOR: 6, ALPHA: 7, CREATION: 8,
  SEQUENCE: 9, TRAIL: 10, ID: 11, YAW: 12, SEQUENCE1: 13, HITBOX: 14, HITBOX_OFFSET: 15, ALPHA2: 16,
  SCRATCH_VEC: 17, SCRATCH: 18, NONE: 19, PITCH: 20, NORMAL: 21, GLOW_RGB: 22, GLOW_ALPHA: 23,
  SCRATCH2: 26, SCRATCH3: 27, SCRATCH_VEC2: 30, FORCE_SCALE: 34,
};
// Which streams the runtime keeps. Pointer attributes (24, 25, 28, 29, 31-33, 35+) carry no simulation state.
// 34 is "Force Scale" (name table 0x1804d7a30 + 8*34 -> "Force Scale"): a float C_OP_BasicMovement multiplies the
// acceleration by; FORCE_SCALE_DEFAULT is its collection constant (FUN_18003b6f0 fills coll+0x8a8 block 34*0x60
// with DAT_180534200 = 1.0), so a particle nothing writes reads 1.
export const VECTOR_ATTRS = new Set([0, 2, 6, 15, 17, 21, 22, 30]);
export const INT_ATTRS = new Set([11, 14]); // RE §11: 11, 14, 33, 40-43 are int32 (mask 0xf00200004800)
export const ANGLE_ATTRS = new Set([4, 5, 12, 20]); // RE §11: mask 0x101030, stored radians
export const STREAMS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 26, 27, 30, 34];
export const FORCE_SCALE_DEFAULT = 1;

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const mulv = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.sqrt(dot(a, a));
export const norm = (a) => { const l = len(a); return l > 0 ? mul(a, 1 / l) : [0, 0, 0]; };
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const sat = (x) => clamp(x, 0, 1);
export const vec3 = (v, d = [0, 0, 0]) => (Array.isArray(v) && v.length >= 3 ? [+v[0], +v[1], +v[2]] : d.slice());
// CP frame: x = forward, y = left, z = up (RE §11 GetControlPointTransformAtTime 0x1800c1e70).
export const toWorld = (cp, v) => [
  cp.forward[0] * v[0] + cp.left[0] * v[1] + cp.up[0] * v[2],
  cp.forward[1] * v[0] + cp.left[1] * v[1] + cp.up[1] * v[2],
  cp.forward[2] * v[0] + cp.left[2] * v[1] + cp.up[2] * v[2],
];
export const toLocal = (cp, v) => [dot(cp.forward, v), dot(cp.left, v), dot(cp.up, v)];

// Euler (degrees, Source order pitch/yaw/roll) to forward/left/up. The angle-to-vector routine
// is 0x18035db20 (RE §10); its body is not in the notes, so this is Source's AngleVectors
// convention (VRF cross-check, UNSETTLED for roll sign).
export const angleVectors = (pitch, yaw, roll) => {
  const r = Math.PI / 180;
  const sp = Math.sin(pitch * r), cp = Math.cos(pitch * r), sy = Math.sin(yaw * r), cy = Math.cos(yaw * r);
  const sr = Math.sin(roll * r), cr = Math.cos(roll * r);
  const forward = [cp * cy, cp * sy, -sp];
  const right = [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp];
  const up = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
  return { forward, left: mul(right, -1), up };
};
// The inverse for a forward vector alone: yaw from x/y, pitch down positive (Source QAngle).
export const vectorAngles = (f) => {
  const yaw = Math.atan2(f[1], f[0]) * 180 / Math.PI;
  const pitch = Math.atan2(-f[2], Math.hypot(f[0], f[1])) * 180 / Math.PI;
  return [pitch, yaw, 0];
};

// The 4,096-entry random table (RE §11, rva 0x598fa0). UNSETTLED: its contents are not extracted, so a seeded
// PRNG fills a table of the same size while the indexing rules are the game's. Swap this when it is dumped.
export const makeRandomTable = (random) => {
  const next = typeof random === 'function' ? random : mulberry32(typeof random === 'number' ? random : 0x5eed);
  const t = new Float32Array(4096);
  for (let i = 0; i < 4096; i++) t[i] = next();
  return t;
};
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// VARYING draw: T[(c914 + c910++) & 0xfff] (RE §11 randomTable).
export const drawVarying = (coll) => coll.table[(coll.rnd.offset + coll.rnd.counter++) & 0xfff];
// CONSTANT draw: T[(c914 + seed [+ particle id]) & 0xfff] (RE §11 randomTable).
export const drawConstant = (coll, seed, pid = 0) => coll.table[(coll.rnd.offset + seed + pid) & 0xfff];

// A control point record (RE §11 collection layout, control point 0xE0). A never-set point reads
// position 0 and the identity frame. UNSETTLED: the identity default orientation.
export const newControlPoint = () => ({
  position: [0, 0, 0], prevPosition: [0, 0, 0], forward: [1, 0, 0], left: [0, 1, 0], up: [0, 0, 1],
  set: false, changeTime: -1,
});
const eachDown = (coll, f) => { f(coll); for (const c of coll.children) eachDown(c, f); };
const cpOf = (c, i) => (c.controlPoints[i] ||= newControlPoint());
// SetControlPointPosition propagates to every child collection recursively (RE §11
// collection layout +0x20/+0x30, SetControlPointPosition 0x1800364e0).
export const setCpPosition = (coll, i, p) => eachDown(coll, (c) => {
  const cp = cpOf(c, i);
  cp.position = p.slice();
  // A point set for the first time has no history to interpolate from. UNSETTLED.
  if (!cp.positioned) cp.prevPosition = p.slice();
  cp.positioned = true;
  cp.set = true;
  cp.changeTime = c.time;
});
// SetControlPointOrientationFLU, same propagation (0x18003ec90).
export const setCpOrientation = (coll, i, f, l, u) => eachDown(coll, (c) => {
  const cp = cpOf(c, i);
  cp.forward = f.slice(); cp.left = l.slice(); cp.up = u.slice();
  cp.set = true;
  cp.changeTime = c.time;
});
// SetControlPointField: field 0..2 is x/y/z of the position, from (0,0,0) if never set; field 3
// is accepted and discarded; children updated (RE §11, 0x1802744e0).
export const setCpField = (coll, i, field, v) => {
  if (field < 0 || field > 2) return;
  eachDown(coll, (c) => {
    const cp = cpOf(c, i);
    const p = cp.set ? cp.position.slice() : [0, 0, 0];
    p[field] = v;
    cp.position = p;
    cp.set = true;
    cp.changeTime = c.time;
  });
};
export const getCp = (coll, i) => coll.controlPoints[i] || newControlPoint();

// Control point position interpolated to a creation time inside this frame:
// prev + (pos - prev) * max(0, (dt - (curTime - creationTime))/dt), dt == 0 -> pos
// (RE §11 GetControlPointTransformAtTime 0x1800c1e70, used by C_INIT_CreateWithinBox).
export const cpPositionAt = (coll, cp, creationTime) => {
  const dt = coll.dt;
  if (!(dt > 0)) return cp.position.slice();
  const f = Math.max(0, (dt - (coll.time - creationTime)) / dt);
  return lerp3(cp.prevPosition, cp.position, f);
};

// Attribute access.
export const getV = (coll, a, i) => { const s = coll.attr[a]; return s ? [s[3 * i], s[3 * i + 1], s[3 * i + 2]] : [0, 0, 0]; };
export const setV = (coll, a, i, v) => { const s = coll.attr[a]; if (s) { s[3 * i] = v[0]; s[3 * i + 1] = v[1]; s[3 * i + 2] = v[2]; } };
export const getInitV = (coll, a, i) => { const s = coll.init[a]; return s ? [s[3 * i], s[3 * i + 1], s[3 * i + 2]] : [0, 0, 0]; };
export const getF = (coll, a, i) => (coll.attr[a] ? coll.attr[a][i] : 0);
export const setF = (coll, a, i, v) => { if (coll.attr[a]) coll.attr[a][i] = v; };
export const getInitF = (coll, a, i) => (coll.init[a] ? coll.init[a][i] : 0);
export const kill = (coll, i) => { coll.killed[i] = 1; };

// Output clamp per attribute (RE §11 C_OP_SetFloat init 0x18020bbc0): alpha and alpha
// alternate [0,1], radius and trail length [0, FLT_MAX], anything else unclamped.
export const outputClamp = (a) => (a === A.ALPHA || a === A.ALPHA2 ? [0, 1]
  : a === A.RADIUS || a === A.TRAIL ? [0, FLT_MAX] : [-FLT_MAX, FLT_MAX]);

// Integer of a ParticleAttributeIndex_t field (KV3 writes it as an int).
export const attrIndex = (v, d = A.NONE) => (Number.isInteger(+v) ? +v : d);

// A CParticleTransformInput as a control point record. PT_TYPE_CONTROL_POINT reads its CP, with
// the identity frame when m_bUseOrientation is off; other types are reported and read CP0's
// position with the identity frame (UNSETTLED). An int field (old files) is the CP number.
export const transformOf = (coll, t) => {
  if (typeof t === 'number') return getCp(coll, t | 0);
  const type = t?.m_nType ?? 'PT_TYPE_CONTROL_POINT';
  const cp = getCp(coll, type === 'PT_TYPE_CONTROL_POINT' ? (t?.m_nControlPoint | 0) : 0);
  if (type !== 'PT_TYPE_CONTROL_POINT') report(coll, `transform input ${type} not implemented (reads CP0, identity)`);
  if (type !== 'PT_TYPE_CONTROL_POINT' || t?.m_bUseOrientation === false) {
    return { ...cp, forward: [1, 0, 0], left: [0, 1, 0], up: [0, 0, 1] };
  }
  return cp;
};

// ParticleSetMethod_t applied to a value against the initial and current values. The SetFloat
// form (with lerp and strength) is in operators.js; this is the plain form initializers and
// C_OP_SetVectorAttributeToVectorExpression use (RE §11, 0x180203ec0 set methods).
export const applySetMethod = (m, v, init, cur, dt) => {
  switch (m) {
    case 'PARTICLE_SET_SCALE_INITIAL_VALUE': return v * init;
    case 'PARTICLE_SET_ADD_TO_INITIAL_VALUE': return v + init;
    case 'PARTICLE_SET_RAMP_CURRENT_VALUE': return cur + v * dt;
    case 'PARTICLE_SET_SCALE_CURRENT_VALUE': return v * cur;
    case 'PARTICLE_SET_ADD_TO_CURRENT_VALUE': return v + cur;
    default: return v;
  }
};

// Report something unimplemented once per collection definition, never silently.
export const report = (coll, msg) => coll.sys.report(`${coll.path}: ${msg}`);
