// Ported from CS2's particles.dll (tools/particles/PORTING.md). Build: particles.dll md5
// 63babcbf3245e56855a777134323e74a ("63babcbf" below). Constants are read with tools/particles/consts.py at the address
// given. The vector noises are leaf SIMD functions (xmm0..xmm2 in, xmm0..xmm2 out, four particles per call) that the
// decompiler drops; they are ported from the disassembly and checked lane for lane against the DLL code run under an
// emulator (unicorn): every lane of 800 random points matched bit for bit.
//
// Forces follow ported_forces.js: `force(fn, c, acc, strength, state)` adds into acc (3 * c.count floats), which
// C_OP_BasicMovement (ported_movement.js) integrates.
import { A, getV } from './common.js';
import { evalFloat, evalVec } from '../inputs.js';
import { PERM_X, PERM_Y, PERM_Z, VECTORS } from './vecnoise_tables.js';

const F = Math.fround;
const lerp = (a, b, t) => F(F(F(b - a) * t) + a); // subps, mulps, addps
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bitsOf = (x) => { f32[0] = x; return u32[0]; };

// The lattice hash shared by the two hash noises (the murmur3-style body without the "* 5 + 0xe6546b64" step that
// valueNoise3 has): a = k * 0x4c9e2d51 (0x18046b7f0) & 0x7fffffff (0x180534bd0); a = a << 15 | a >> 17 (psrad);
// a = a * 0x1b873593 (0x18046b750) & 0x7fffffff; [Worley: a ^= seed bits]; a = (a >> 19 | a << 13) & 0x7fffffff;
// a *= 0x04b2ae35 (0x18046b740); h = (a >> 16) ^ a (psrad).
const hash = (k, seed = 0) => {
  let a = Math.imul(k, 0x4c9e2d51) & 0x7fffffff;
  a = (a >> 17) | (a << 15);
  a = (Math.imul(a, 0x1b873593) & 0x7fffffff) ^ seed;
  a = ((a >> 19) | (a << 13)) & 0x7fffffff;
  a = Math.imul(a, 0x04b2ae35);
  return (a >> 16) ^ a;
};
const cellKey = (ix, iy, iz) => (ix + ((iy << 10) | 0) + ((iz << 20) | 0)) | 0;

// FUN_180364be0, PARTICLE_DIR_NOISE_PERLIN (and every C_OP_TurbulenceForce octave): vector value noise. Cell =
// floor (roundps mode 1), fraction = p - floor; each of the eight corners (key ix + iy*1024 + iz*1048576, +1 per axis
// from 0x180534550) hashes to a vector of its three low bytes, byte * 2/255 (0x3c008081, 0x18046b770) - 1
// (0x180534c70); the corners blend trilinearly on the plain fractions (x, then y, then z; no fade curve).
export const vectorValueNoise = (x, y, z) => {
  x = F(x); y = F(y); z = F(z);
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = F(x - X), fy = F(y - Y), fz = F(z - Z);
  const ix = X | 0, iy = Y | 0, iz = Z | 0;
  const S = F(2 / 255);
  const corner = (dx, dy, dz) => {
    const h = hash(cellKey(ix + dx, iy + dy, iz + dz));
    return [F(F((h & 0xff) * S) - 1), F(F(((h >> 8) & 0xff) * S) - 1), F(F(((h >> 16) & 0xff) * S) - 1)];
  };
  const c000 = corner(0, 0, 0), c100 = corner(1, 0, 0), c010 = corner(0, 1, 0), c110 = corner(1, 1, 0);
  const c001 = corner(0, 0, 1), c101 = corner(1, 0, 1), c011 = corner(0, 1, 1), c111 = corner(1, 1, 1);
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const y0 = lerp(lerp(c000[k], c100[k], fx), lerp(c010[k], c110[k], fx), fy);
    const y1 = lerp(lerp(c001[k], c101[k], fx), lerp(c011[k], c111[k], fx), fy);
    out[k] = lerp(y0, y1, fz);
  }
  return out;
};

// FUN_180368850: table vector noise, the CURL potential. Each axis goes through v + 32768 (0x180589cf0) in float, so
// the low 16 bits of the result (0xffff, 0x180589ce0) are the 8.8 fixed-point lattice coordinate: cell = bits >> 8
// (mod 256), fraction = (bits & 0xff) / 256 (0x180534158). Corner vector = VECTORS[PZ[(PY[(PX[ix + dx] + iy + dy)
// & 0xff] + iz + dz) & 0xff]] (tables vecnoise_tables.js); the eight blend trilinearly (x, y, z), no fade curve.
export const gradientNoise = (x, y, z) => {
  const bx = bitsOf(F(x + 32768)) & 0xffff, by = bitsOf(F(y + 32768)) & 0xffff, bz = bitsOf(F(z + 32768)) & 0xffff;
  const fx = F((bx & 0xff) * 0.00390625), fy = F((by & 0xff) * 0.00390625), fz = F((bz & 0xff) * 0.00390625);
  const ix = bx >> 8, iy = by >> 8, iz = bz >> 8;
  const at = (dx, dy, dz) => 3 * PERM_Z[(PERM_Y[(PERM_X[(ix + dx) & 0xff] + iy + dy) & 0xff] + iz + dz) & 0xff];
  const c000 = at(0, 0, 0), c100 = at(1, 0, 0), c010 = at(0, 1, 0), c110 = at(1, 1, 0);
  const c001 = at(0, 0, 1), c101 = at(1, 0, 1), c011 = at(0, 1, 1), c111 = at(1, 1, 1);
  const V = VECTORS, out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const y0 = lerp(lerp(V[c000 + k], V[c100 + k], fx), lerp(V[c010 + k], V[c110 + k], fx), fy);
    const y1 = lerp(lerp(V[c001 + k], V[c101 + k], fx), lerp(V[c011 + k], V[c111 + k], fx), fy);
    out[k] = lerp(y0, y1, fz);
  }
  return out;
};

// FUN_180368760, PARTICLE_DIR_NOISE_CURL: the curl of the potential (P, Q, R) = (G(p), G(p + K1), G(p + K1 + K2)),
// taking each potential's partials from the matching G components: out = (R.y - Q.z, P.z - R.x, Q.x - P.y).
// K1 = (43.256 0x18046b7c0, -67.89 0x18046b810, 1338.2 0x18046b7d0), K2 = (-129.856 0x18046b820, -967.23 0x18046b830,
// 2338.98 0x18046b7e0), added in float.
const K1 = [F(43.256), F(-67.89), F(1338.2)], K2 = [F(-129.856), F(-967.23), F(2338.98)];
export const curlNoise = (x, y, z) => {
  x = F(x); y = F(y); z = F(z);
  const P = gradientNoise(x, y, z);
  const x1 = F(x + K1[0]), y1 = F(y + K1[1]), z1 = F(z + K1[2]);
  const Q = gradientNoise(x1, y1, z1);
  const R = gradientNoise(F(x1 + K2[0]), F(y1 + K2[1]), F(z1 + K2[2]));
  return [F(R[1] - Q[2]), F(P[2] - R[0]), F(Q[0] - P[1])];
};

// FUN_180367970, PARTICLE_DIR_NOISE_WORLEY_BASIC: the offset from p to the nearest feature point of the 27 cells
// around it (dx, dy, dz in -1..1, z innermost). Feature point of cell (ix+dx, iy+dy, iz+dz) = cell + bytes / 255
// (0x3b808081, 0x180534700) * jitter, the hash taking the seed's raw float bits (xorps); squared distance
// (dz^2 + dy^2) + dx^2; a strictly smaller one (cmpltps, start FLT_MAX 0x180534bc0) replaces the result. Returns p
// unchanged if no distance is below FLT_MAX.
export const worleyNoise = (x, y, z, jitter, seed) => {
  x = F(x); y = F(y); z = F(z); jitter = F(jitter);
  const sb = bitsOf(F(seed)) | 0;
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = F(x - X), fy = F(y - Y), fz = F(z - Z);
  const ix = X | 0, iy = Y | 0, iz = Z | 0;
  const S = F(1 / 255);
  let best = F(3.4028234663852886e38), out = [x, y, z];
  for (let dx = -1; dx < 2; dx++) for (let dy = -1; dy < 2; dy++) for (let dz = -1; dz < 2; dz++) {
    const h = hash(cellKey(ix + dx, iy + dy, iz + dz), sb);
    const ox = F(F(F((h & 0xff) * S) * jitter) + F(dx - fx));
    const oy = F(F(F(((h >> 8) & 0xff) * S) * jitter) + F(dy - fy));
    const oz = F(F(F(((h >> 16) & 0xff) * S) * jitter) + F(dz - fz));
    const d2 = F(F(F(oz * oz) + F(oy * oy)) + F(ox * ox));
    if (d2 < best) { out = [ox, oy, oz]; best = d2; }
  }
  return out;
};

const NOISE_TYPES = ['PARTICLE_DIR_NOISE_PERLIN', 'PARTICLE_DIR_NOISE_CURL', 'PARTICLE_DIR_NOISE_WORLEY_BASIC'];

export const ported_vecnoise = {
  // particles.dll 63babcbf: C_OP_CurlNoiseForce AddForces slot 34 0x180112150. Per particle (the four vector inputs
  // and the two Worley floats are per-particle inputs): p = (m_vecOffset + m_vecOffsetRate * time (coll+0x40)) +
  // m_vecNoiseFreq * pos, in that float order; n = CURL (m_nNoiseType == 1) curlNoise(p), WORLEY (== 2)
  // worleyNoise(p, m_flWorleyJitter, m_flWorleySeed), anything else vectorValueNoise(p); acc += n * m_vecNoiseScale *
  // strength (mulps, mulps, addps).
  C_OP_CurlNoiseForce: {
    evidence: 'RE',
    force(fn, c, acc, strength) {
      const t = F(c.time), s = F(strength);
      const type = typeof fn.m_nNoiseType === 'number' ? fn.m_nNoiseType : NOISE_TYPES.indexOf(fn.m_nNoiseType);
      for (let i = 0; i < c.count; i++) {
        const freq = evalVec(fn.m_vecNoiseFreq, c, i), scale = evalVec(fn.m_vecNoiseScale, c, i);
        const off = evalVec(fn.m_vecOffset, c, i), rate = evalVec(fn.m_vecOffsetRate, c, i);
        const pos = getV(c, A.POSITION, i);
        const p = [0, 1, 2].map((k) => F(F(F(off[k]) + F(F(rate[k]) * t)) + F(F(freq[k]) * pos[k])));
        const n = type === 1 ? curlNoise(p[0], p[1], p[2])
          : type === 2 ? worleyNoise(p[0], p[1], p[2], evalFloat(fn.m_flWorleyJitter, c, i), evalFloat(fn.m_flWorleySeed, c, i))
            : vectorValueNoise(p[0], p[1], p[2]);
        for (let k = 0; k < 3; k++) acc[3 * i + k] = F(F(F(n[k] * F(scale[k])) * s) + acc[3 * i + k]);
      }
    },
  },

  // particles.dll 63babcbf: C_OP_TurbulenceForce AddForces slot 34 0x180111af0. Four octaves k = 0..3: acc +=
  // m_vecNoiseAmount<k> * vectorValueNoise(pos * m_flNoiseCoordScale<k>) per axis (scales this+0x1f0..0x1fc, amounts
  // +0x200, +0x20c, +0x218, +0x224). The strength argument is not read (the body never loads the sixth argument).
  C_OP_TurbulenceForce: {
    evidence: 'RE',
    force(fn, c, acc) {
      const oct = [0, 1, 2, 3].map((k) => [F(+fn[`m_flNoiseCoordScale${k}`] || 0), (fn[`m_vecNoiseAmount${k}`] || [0, 0, 0]).map((v) => F(+v || 0))]);
      for (let i = 0; i < c.count; i++) {
        const pos = getV(c, A.POSITION, i);
        for (const [sc, amt] of oct) {
          const n = vectorValueNoise(F(sc * pos[0]), F(sc * pos[1]), F(sc * pos[2]));
          for (let k = 0; k < 3; k++) acc[3 * i + k] = F(F(amt[k] * n[k]) + acc[3 * i + k]);
        }
      }
    },
  },
};
