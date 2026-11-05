// Ported from CS2's particles.dll (tools/particles/PORTING.md). Build: particles.dll md5 63babcbf3245e56855a777134323e74a.
// Constants read with tools/particles/consts.py at the address given.
//
// C_OP_WorldTraceConstraint (vtable 0x1804e55a8). Slot 35 (0x1800ee380) is the constraint body, called as
// (this, collection, &{startBlock, blockCount, count, 0, opState}); it tail-jumps to 0x1800fe140 when m_bKillonContact
// is off, the same template without the kill rules. Both walk the particles in blocks of 4 (SIMD lanes); the port keeps
// the block grouping where a rule depends on it (any-lane bounce/slide test, the per-block trace budget). Slot 36
// (0x1800ed9f0) is `final`. Slot 6 (0x1800edd70): m_nMaxTracesPerFrame == -1 (DAT_1805343cc) -> 100 (0x42c80000).
// Slot 11 (0x1800eddb0) fills opState = {collision group id, effective collision mode}.
//
// Traces go through ParticleSystem opts.trace(from, dir, length, query) -> { hit, position, normal, fraction,
// startSolid } | null (null: no world, a miss). No opts.trace: the constraint does nothing.
import { A, VECTOR_ATTRS, add, sub, mul, dot, len, getV, setV, getF, setF, getCp, mulberry32, attrIndex, vec3,
  FLT_EPSILON } from './common.js';
import { evalFloat } from '../inputs.js';

const MODES = { COLLISION_MODE_DISABLED: -1, COLLISION_MODE_INITIAL_TRACE_DOWN: 0, COLLISION_MODE_PER_FRAME_PLANESET: 1,
  COLLISION_MODE_USE_NEAREST_TRACE: 2, COLLISION_MODE_PER_PARTICLE_TRACE: 3 }; // schema ParticleCollisionMode_t
const TRACE_SETS = ['PARTICLE_TRACE_SET_ALL', 'PARTICLE_TRACE_SET_STATIC', 'PARTICLE_TRACE_SET_STATIC_AND_KEYFRAMED',
  'PARTICLE_TRACE_SET_DYNAMIC'];
const enumIndex = (v, names, d = 0) => (typeof v === 'number' ? v : Math.max(names.indexOf(v), d));
const NONE = A.NONE;
const PLANES = 41; // 0x29: plane slots per cache
const GRID = 26; // 0x1a: the 3x3x3 grid minus its centre
const GRID_STEP = 1000; // DAT_180534368
const CONFIRM_EXTEND = 64; // DAT_180534320: confirmation traces run 64 units past the swept end
const UP = [0, 0, 1]; // the result's normal before a trace writes it (DAT_180589050 into the z slot, 0x1800ede50)
const MISS = { frac: 1, startSolid: false, normal: null };

const rng = (st) => (st.rng ||= mulberry32(0x2545f491));
const dist2 = (a, b) => { const d = sub(a, b); return dot(d, d); };

// Slot 11: mode = m_nCollisionMode when the detail convar (DAT_18065b968 + 0x58) is >= it, else
// max(m_nCollisionModeMin, convar) (convar 0 -> -1). UNSETTLED: the convar's value; taken as full detail, so the
// authored mode always runs.
const modeOf = (fn) => { const m = fn.m_nCollisionMode; return typeof m === 'number' ? m : (MODES[m] ?? 3); };

// The trace call (vtable +0x20 of coll+0x1d8). Content mask: 0xc3001, brush only 0x3001, water 0xdb001, both 0x1b001.
// Object mask: the trace-set switch (ALL 0xf, STATIC 1, STATIC_AND_KEYFRAMED 3, DYNAMIC 6) for particle traces; the
// plane-cache traces (0x1800eca10) use 0xf when not world/brush only and the set is ALL or DYNAMIC, else 1.
function queries(fn) {
  const set = enumIndex(fn.m_nTraceSet, TRACE_SETS);
  const brush = !!fn.m_bBrushOnly, water = !!fn.m_bIncludeWater;
  const contents = water ? (brush ? 0x1b001 : 0xdb001) : brush ? 0x3001 : 0xc3001;
  const base = { traceSet: TRACE_SETS[set] || TRACE_SETS[0], worldOnly: !!fn.m_bWorldOnly, brushOnly: brush,
    includeWater: water, collisionGroup: String(fn.m_CollisionGroupName ?? 'NONE'), ignoreCp: fn.m_nIgnoreCP ?? -1,
    contents };
  const wide = !fn.m_bWorldOnly && !brush && (set === 0 || set === 3);
  return { particle: { ...base, mask: [0xf, 1, 3, 6][set] ?? 0xf }, plane: { ...base, mask: wide ? 0xf : 1 } };
}

// One segment trace: the game result's fraction, start-solid flag and normal. Contents (the hit entity) is always 0
// here: the runtime's traces see the world only, so the body's m_bWorldOnly test ((contents >> 8) * 256 +
// (contents & 0xff) == 0, DAT_180534ac0 / DAT_1805345f0) never rejects a hit.
function traceSeg(c, q, from, to) {
  const d = sub(to, from), L = len(d);
  if (!(L > 0)) return MISS; // UNSETTLED: a zero-length trace is taken as a miss without calling opts.trace
  const r = c.sys.opts.trace(from.slice(), mul(d, 1 / L), L, q);
  if (!r) return MISS;
  const startSolid = !!r.startSolid;
  if (!r.hit && !startSolid) return MISS;
  let frac = Number.isFinite(r.fraction) ? +r.fraction : r.hit ? len(sub(vec3(r.position), from)) / L : 0;
  frac = Math.min(Math.max(frac, 0), 1);
  return { frac, startSolid, normal: r.hit ? vec3(r.normal, UP) : null };
}

// ---- the plane cache: one per root collection and mode (root + 200 + mode * 8, made on first use with count 0 and
// time -1). Layout at 0x1800eca10: start x41, end x41, hit point x41 (+0x52*0x30), normal x41 (+0x7b*0x30), contents
// (+0x1ec*0x10), valid bytes (+0x216c); +0x2150 count, +0x2154 write index, +0x2158 round-robin index,
// +0x215c last trace time, +0x2160 last CP position.
const CACHES = new WeakMap();
function cacheFor(c, mode) {
  let root = c;
  while (root.parent) root = root.parent;
  if (!CACHES.has(root)) CACHES.set(root, []);
  const list = CACHES.get(root);
  return (list[mode] ||= { count: 0, write: 0, rr: 0, time: -1, last: [0, 0, 0], valid: new Uint8Array(PLANES),
    point: [], normal: [] });
}

// 0x1800eca10: trace from the CP along delta into slot idx; a hit stores the plane (point, normal), a miss clears it.
function planeTrace(c, k, idx, from, delta, q) {
  const t = traceSeg(c, q, from, add(from, delta));
  if (!(t.frac < 1)) { k.valid[idx] = 0; return; }
  k.valid[idx] = 1;
  k.point[idx] = add(from, mul(delta, t.frac));
  k.normal[idx] = t.normal || UP.slice();
}

// 0x1800eccf0: refresh the cache from the CP (m_nCP + m_vecCpOffset, offset unrotated).
function updatePlanes(fn, c, k, mode, retest, q) {
  if (k.count !== 0 && mode === 0) return; // INITIAL_TRACE_DOWN traces once
  const cp = add(getCp(c, fn.m_nCP | 0).position, vec3(fn.m_vecCpOffset));
  const tol = +fn.m_flCpMovementTolerance;
  if (!retest && !(tol * tol <= dist2(cp, k.last))) return;
  k.time = c.time;
  k.last = cp;
  if (mode === 0) {
    planeTrace(c, k, 0, cp, [0, 0, -1000], q);
    k.count = k.write = 1;
    return;
  }
  if (!retest || k.write < GRID) {
    // the full grid: x, y in -1..1 (x outer), z -1000 / 0 (not at x = y = 0) / +1000
    let idx = 0;
    for (let x = -1; x < 2; x++) for (let y = -1; y < 2; y++) {
      planeTrace(c, k, idx++, cp, [x * GRID_STEP, y * GRID_STEP, -1000], q);
      if (x !== 0 || y !== 0) planeTrace(c, k, idx++, cp, [x * GRID_STEP, y * GRID_STEP, 0], q);
      planeTrace(c, k, idx++, cp, [x * GRID_STEP, y * GRID_STEP, 1000], q);
    }
    k.count = k.write = idx;
    return;
  }
  // a retest with a full grid: one round-robin slot, 0..26 decoded base 3 as (x, y, z) - 1 (26 included, 13 is the
  // zero vector)
  let idx = k.rr;
  if (idx > GRID) idx = 0;
  k.rr = idx + 1;
  const d = (n) => ((Math.trunc(idx / n) % 3) - 1) * GRID_STEP;
  planeTrace(c, k, idx, cp, [d(1), d(3), d(9)], q);
}

// 0x1800ede50 with a cache: nearest plane crossed from `from` (outside, d0 >= 0) to `to` (inside, d1 < 0).
function planeHit(k, from, to) {
  let best = 2, normal = UP; // DAT_180589060 = 2
  for (let p = 0; p < k.count; p++) {
    if (!k.valid[p]) continue;
    const P = k.point[p], N = k.normal[p];
    const d0 = dot(sub(from, P), N), d1 = dot(sub(to, P), N);
    if (!(d1 < 0 && d0 >= 0)) continue;
    const t = d0 / (d0 - d1);
    if (t < best) { best = t; normal = N; }
  }
  return { frac: best, pen: Math.max(0, 1 - best), normal: normal.slice() };
}

// 0x1800ede50 without a cache: one trace per lane; penetration 1 - fraction (0 when start-solid), the normal only
// when the fraction is not 1 and the trace did not start solid.
function particleHit(c, q, from, to) {
  const t = traceSeg(c, q, from, to);
  return { frac: t.frac, pen: t.startSolid ? 0 : 1 - t.frac, normal: !t.startSolid && t.frac !== 1 && t.normal ? t.normal : UP.slice() };
}

// Unit-ball random vector: components rand * 2 - 1 (DAT_180589060, DAT_180589050), redrawn while |v|^2 >= 1 (the first
// test is > 1). UNSETTLED: the game's generator (0x18036ba50, a thread-local lagged-Fibonacci stream); a seeded
// mulberry32 per operator here.
function randomInBall(st) {
  const r = rng(st), draw = () => [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
  let v = draw();
  if (dot(v, v) > 1) do v = draw(); while (dot(v, v) >= 1);
  return v;
}

const literalZero = (inp) => {
  if (typeof inp === 'number') return inp === 0;
  if (!inp || typeof inp !== 'object') return true; // absent: the class default, literal 0 (defaults.js)
  const t = inp.m_nType ?? 'PF_TYPE_LITERAL';
  return (t === 'PF_TYPE_LITERAL' || t === 0) && +(inp.m_flLiteralValue ?? 0) === 0;
};

export const ported_collision = {
  // 63babcbf slot 35 0x1800ee380 (kill on contact) / 0x1800fe140 (otherwise), helpers 0x1800eccf0 (plane cache),
  // 0x1800eca10 (plane trace), 0x1800ede50 (sweep: planes or one trace per lane). Per lane, with delta = pos - prev,
  // dir = delta / |delta| (0 when |delta|^2 <= FLT_EPSILON, DAT_1805890b0) and r = radius * m_flRadiusScale * 0.5
  // (DAT_1805890a0): the sweep runs prev -> pos + r * dir; a hit is fraction < 1 with |delta|^2 > FLT_EPSILON.
  // Cached modes confirm a hit with a real trace from prev - r * dir to pos + r * dir + 64 * dir when
  // |start - end|^2 / dt >= m_flCollisionConfirmationSpeed^2, at most m_nMaxTracesPerFrame per 4-particle block (the
  // counter resets per block in both templates); a confirmed hit's fraction is |trace| * f / |start - end| and its
  // plane joins the cache. Then: m_flMinSpeed >= 0 zeroes the life duration of hits slower than m_flMinSpeed * dt;
  // hit = prev + fraction * delta; kill on contact: m_flMinSpeed < 0 zeroes every hit's life duration, pos = prev =
  // hit, and the bounce/stick part runs only with m_bKillonContactBounce. Bounce (when any lane of the block has
  // bounce > 0 or slide > 0): R = reflect(dir, N), + random-in-ball * m_flRandomDirScale and renormalised when any
  // lane's scale > 0, * |delta| when m_bDecayBounce, * bounce; T = (delta - (delta . N) N) * slide;
  // pos = hit + penetration * (R + T), prev = pos - (R + T). Without bounce/slide pos = hit and (non-kill) prev stays.
  // Stick field: a lane whose velocity |pos - prev| is below m_flStopSpeed * dt (or that is negative) writes pos to the
  // field, and later frames pin pos = prev = field while it is non-zero; the set-normal mask then narrows to the stuck
  // lanes. m_bSetNormal writes the hit normal to the normal attribute.
  // UNSETTLED: collection flags +0x8b4 (4: bounce + FLT_EPSILON, 0x20: kill path keeps prev, 8/0x10/0x24: collision
  // event lists for other operators) are not modelled; the entity-stick fields (m_nEntityStickDataField /
  // m_nEntityStickNormalField) need a hit entity, and the runtime's traces only see the world (contents 0).
  // UNSETTLED: the m_flRadiusScale input and the others are evaluated per particle (the game evaluates 4 lanes at once).
  C_OP_WorldTraceConstraint: {
    evidence: 'RE',
    // slot 36 0x1800ed9f0: not final only when bounce and slide are both literal (m_nType 0) zero
    final: (fn) => !(literalZero(fn.m_flBounceAmount) && literalZero(fn.m_flSlideAmount)),
    constrain(fn, c, st) {
      const mode = modeOf(fn);
      if (mode === -1 || !c.sys.opts.trace || !c.count) return false;
      const kill = !!fn.m_bKillonContact;
      const bounceToo = !kill || !!fn.m_bKillonContactBounce;
      const stick = attrIndex(fn.m_nStickOnCollisionField, NONE);
      const stickOn = stick !== NONE && VECTOR_ATTRS.has(stick);
      const minSpeed = +fn.m_flMinSpeed, dt = c.dt;
      const q = queries(fn);
      const maxTraces = +fn.m_nMaxTracesPerFrame === -1 ? 100 : +fn.m_nMaxTracesPerFrame;
      const confirm2 = (+fn.m_flCollisionConfirmationSpeed) ** 2;
      let k = null;
      if (mode >= 0 && mode < 3) {
        k = cacheFor(c, mode);
        // retest: never traced (time -1), or m_flRetestRate >= 0 (DAT_180534120) and rate + last time < now
        const rate = +fn.m_flRetestRate;
        updatePlanes(fn, c, k, mode, k.time === -1 || (rate >= 0 && rate + k.time < c.time), q.plane);
      }
      let moved = false;
      for (let b = 0; b < c.count; b += 4) {
        const n = Math.min(4, c.count - b);
        if (stickOn) {
          let stuck = 0;
          for (let j = 0; j < n; j++) {
            const s = getV(c, stick, b + j);
            if (dot(s, s) > 0) { setV(c, A.POSITION, b + j, s); setV(c, A.PREV, b + j, s); stuck++; }
          }
          if (stuck === 4) continue;
        }
        const lanes = [];
        let anyBounce = false, anyRandom = false;
        for (let j = 0; j < n; j++) {
          const i = b + j;
          const L = { i, bounce: evalFloat(fn.m_flBounceAmount, c, i), slide: evalFloat(fn.m_flSlideAmount, c, i),
            rdir: evalFloat(fn.m_flRandomDirScale, c, i) };
          if (L.bounce > 0 || L.slide > 0) anyBounce = true;
          if (L.rdir > 0) anyRandom = true;
          const P = getV(c, A.POSITION, i), Q = getV(c, A.PREV, i);
          L.P = P; L.Q = Q; L.delta = sub(P, Q);
          const l2 = dot(L.delta, L.delta);
          L.l2 = l2;
          L.dir = l2 <= FLT_EPSILON ? [0, 0, 0] : mul(L.delta, 1 / Math.sqrt(l2));
          const r = getF(c, A.RADIUS, i) * evalFloat(fn.m_flRadiusScale, c, i) * 0.5;
          L.end = add(P, mul(L.dir, r));
          L.start = sub(Q, mul(L.dir, r));
          L.hit = false;
          if (l2 > FLT_EPSILON) {
            const h = k ? planeHit(k, Q, L.end) : particleHit(c, q.particle, Q, L.end);
            Object.assign(L, h);
            L.hit = h.frac < 1;
          }
          lanes.push(L);
        }
        const hits = lanes.filter((L) => L.hit);
        if (!hits.length) continue;
        moved = true;
        if (k) {
          let traces = 0;
          for (const L of hits) {
            const D = sub(L.start, L.end), d2 = dot(D, D);
            if (!(confirm2 <= d2 / dt && traces < maxTraces)) continue;
            const traceEnd = add(L.end, mul(L.dir, CONFIRM_EXTEND));
            const t = traceSeg(c, q.particle, L.start, traceEnd);
            traces++;
            let f = 1;
            if (t.frac < 1) {
              f = (len(sub(L.start, traceEnd)) * t.frac) / Math.sqrt(d2);
              if (f < 1) L.frac = f;
              let idx = k.write;
              k.write++;
              if (k.count < PLANES) { idx = k.count; k.count++; } else if (k.write > PLANES - 1) { idx = GRID; k.write = GRID; }
              k.valid[idx] = 1;
              k.point[idx] = add(L.start, mul(sub(traceEnd, L.start), t.frac));
              k.normal[idx] = t.normal || UP.slice();
            }
            L.hit = f < 1;
          }
        }
        for (const L of lanes) {
          if (!L.hit) continue;
          const i = L.i;
          if (minSpeed >= 0 && Math.sqrt(L.l2) < minSpeed * dt) setF(c, A.LIFE, i, 0);
          const hit = add(L.Q, mul(L.delta, L.frac));
          if (kill) {
            if (minSpeed < 0) setF(c, A.LIFE, i, 0);
            setV(c, A.POSITION, i, hit);
            setV(c, A.PREV, i, hit);
          }
          L.normalOut = true;
          if (!bounceToo) continue;
          let pos = hit;
          if (anyBounce) {
            const N = L.normal;
            let R = sub(L.dir, mul(N, 2 * dot(L.dir, N)));
            if (anyRandom) {
              R = add(R, mul(randomInBall(st), L.rdir));
              R = mul(R, 1 / Math.sqrt(dot(R, R)));
            }
            if (fn.m_bDecayBounce) R = mul(R, Math.sqrt(L.l2));
            R = mul(R, L.bounce);
            const T = mul(sub(L.delta, mul(N, dot(L.delta, N))), L.slide);
            const v = add(R, T);
            pos = add(hit, mul(v, L.pen));
            setV(c, A.PREV, i, sub(pos, v));
          }
          setV(c, A.POSITION, i, pos);
          if (stickOn) {
            const s = evalFloat(fn.m_flStopSpeed, c, i) * dt;
            const v = sub(pos, getV(c, A.PREV, i));
            const stuck = s < 0 || dot(v, v) < s * s;
            if (stuck) setV(c, stick, i, pos);
            L.normalOut = stuck;
          }
        }
        if (fn.m_bSetNormal) for (const L of lanes) if (L.hit && L.normalOut) setV(c, A.NORMAL, L.i, L.normal);
      }
      return moved;
    },
  },
};
