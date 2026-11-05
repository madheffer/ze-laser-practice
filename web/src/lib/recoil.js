// CS2 weapon recoil: the aim punch (where your bullets go, and 45% of it on your view) and the view punch (a short
// extra shake per shot). Shared by the viewmodel (your shots), the camera (app/loop.js) and replays.
//
// Aim punch, read from CS2's client (client_20261015.dll, Ghidra):
//   - CCSPlayer_AimPunchServices keeps a base angle + angular velocity at a base tick; FUN_18084d8b0 evaluates it on a
//     fixed 128 Hz grid (dt = 0.0078125) from that base: each step
//       punch *= exp(-0.0625)                         (= exp(-8 dt): CS:GO's weapon_recoil_decay2_exp 8)
//       |punch| -= 0.140625, to 0 at or below it      (= 18 dt: weapon_recoil_decay2_lin 18)
//       punch += (v(t0) + v(t1)) * 0.00390625         (trapezoid, dt / 2), v(t) = baseVel * exp(-4.5 t): vel_decay 4.5,
//                                                      a velocity under 0.03125 counts as 0
//     then each axis is clamped to +-89, a result under 0.03125 is 0, and it is doubled (weapon_recoil_scale 2).
//   - CalcView (FUN_180882530) adds that doubled punch x 0.45 (0x3ee66666, view_recoil_tracking) to your view, and the
//     view punch decayed by exp(-view_punch_decay x t), view_punch_decay = 18 (FUN_1800b3270, 0x41900000).
//   Bullets leave along your view + the doubled punch, so a spray climbs past the crosshair (cl_crosshair_recoil 0).
// The kick and the pattern (CS:GO's CWeaponCSBase::Recoil and GenerateRecoilTable, the same model the decay above
// still runs): each shot adds (-cos a, -sin a) x magnitude to the punch velocity, (a, magnitude) = the gun's table
// entry at its recoil index; the table is 64 entries from CUniformRandomStream seeded with m_nRecoilSeed.
// UNSETTLED (CS:GO defaults; their cvars are gone from CS2, the values not yet found in its binaries): the table's
// variance 0.55 and first-4-shot suppression 0.75 (full auto only), the view punch per shot (magnitude x 0.055), and
// the recoil index decaying x exp(-2 ln 10 t) once 1.1 cycles pass without a shot.
import { GUNS } from './weapons.js';

export const STEP = 1 / 128;
const EXP_STEP = Math.exp(-0.0625);
const LIN_STEP = 0.140625;
const VEL_DECAY = 4.5;
const MIN_VEL = 0.03125;
const MIN_PUNCH = 0.03125;
const SCALE = 2;
export const VIEW_TRACKING = 0.45;
const VIEW_PUNCH_DECAY = 18;
const VIEW_PUNCH_EXTRA = 0.055;
const TABLE = 64;
const VARIANCE = 0.55;
const SUPPRESSION_SHOTS = 4;
const SUPPRESSION_FACTOR = 0.75;
const INDEX_DECAY = Math.log(10) * 2;
const INDEX_DECAY_AFTER = 1.1; // cycles without a shot

// Valve's CUniformRandomStream (Numerical Recipes ran1), as vstdlib's RandomSeed / RandomFloat
export class UniformRandomStream {
  constructor(seed) {
    this.idum = seed < 0 ? seed : -seed;
    this.iy = 0;
    this.iv = new Int32Array(32);
  }
  _next() {
    const IA = 16807, IM = 2147483647, IQ = 127773, IR = 2836, NTAB = 32, NDIV = 1 + Math.floor((IM - 1) / NTAB);
    let k;
    if (this.idum <= 0 || !this.iy) {
      this.idum = -this.idum < 1 ? 1 : -this.idum;
      for (let j = NTAB + 7; j >= 0; j--) {
        k = Math.trunc(this.idum / IQ);
        this.idum = IA * (this.idum - k * IQ) - IR * k;
        if (this.idum < 0) this.idum += IM;
        if (j < NTAB) this.iv[j] = this.idum;
      }
      this.iy = this.iv[0];
    }
    k = Math.trunc(this.idum / IQ);
    this.idum = IA * (this.idum - k * IQ) - IR * k;
    if (this.idum < 0) this.idum += IM;
    let j = Math.trunc(this.iy / NDIV);
    if (j >= NTAB || j < 0) j = (j % NTAB) & 0x7fffffff;
    this.iy = this.iv[j];
    this.iv[j] = this.idum;
    return this.iy;
  }
  randomFloat(lo = 0, hi = 1) {
    const fl = Math.min((1 / 2147483647) * this._next(), 1 - 1.2e-7);
    return Math.fround(fl * (hi - lo) + lo);
  }
}

const lerp = (t, a, b) => a + (b - a) * t;

// The gun's 64 recoil entries [{ angle, magnitude }] (CS:GO GenerateRecoilTable), cached per gun
const tables = new Map();
export function recoilTable(name) {
  if (tables.has(name)) return tables.get(name);
  const g = GUNS[name];
  const r = g?.recoil;
  const out = [];
  if (r) {
    const rnd = new UniformRandomStream(r.seed);
    let angle = 0, magnitude = 0;
    for (let j = 0; j < TABLE; j++) {
      const angleNew = r.angle + rnd.randomFloat(-r.angleVariance, r.angleVariance);
      const magNew = r.magnitude + rnd.randomFloat(-r.magnitudeVariance, r.magnitudeVariance);
      if (g.fullAuto && j > 0) { angle = lerp(VARIANCE, angle, angleNew); magnitude = lerp(VARIANCE, magnitude, magNew); }
      else { angle = angleNew; magnitude = magNew; }
      if (g.fullAuto && j < SUPPRESSION_SHOTS) magnitude *= lerp(j / SUPPRESSION_SHOTS, SUPPRESSION_FACTOR, 1);
      out.push({ angle, magnitude });
    }
  }
  tables.set(name, out);
  return out;
}

// One player's punch state. Time is the caller's (seconds, steady: the viewmodel's clock).
export class Recoil {
  constructor() { this.reset(); }

  reset() {
    this.baseVel = [0, 0];     // its angular velocity then (degrees / s)
    this.punch = [0, 0];       // unscaled punch now (on the 128 Hz grid)
    this.prev = [0, 0];        // the step before, to draw between steps
    this.t = 0;                // seconds since the base
    this.acc = 0;              // time past the last step
    this.view = [0, 0];        // view punch (degrees) and its age
    this.viewAge = 0;
    this.index = 0;            // m_flRecoilIndex
    this.sinceShot = 1e9;
  }

  _vel(t) {
    const k = Math.exp(-VEL_DECAY * t);
    const v = [this.baseVel[0] * k, this.baseVel[1] * k];
    return Math.hypot(v[0], v[1]) < MIN_VEL ? [0, 0] : v;
  }

  _step() {
    const p = this.punch;
    this.prev[0] = p[0]; this.prev[1] = p[1];
    p[0] *= EXP_STEP; p[1] *= EXP_STEP;
    const len = Math.hypot(p[0], p[1]);
    if (len <= LIN_STEP) { p[0] = 0; p[1] = 0; } else { const f = 1 - LIN_STEP / len; p[0] *= f; p[1] *= f; }
    const v0 = this._vel(this.t), v1 = this._vel(this.t + STEP);
    p[0] += (v0[0] + v1[0]) * STEP * 0.5;
    p[1] += (v0[1] + v1[1]) * STEP * 0.5;
    this.t += STEP;
  }

  // advance by dt seconds; cycle = the held gun's cycle time (for the recoil index's decay)
  tick(dt, cycle = 0.1) {
    if (!(dt > 0)) return;
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP && n++ < 512) { this.acc -= STEP; this._step(); }
    if (this.acc > STEP) this.acc = 0;
    this.viewAge += dt;
    this.sinceShot += dt;
    if (this.sinceShot > cycle * INDEX_DECAY_AFTER && this.index > 0) {
      this.index *= Math.exp(-INDEX_DECAY * dt);
      if (this.index < 1e-3) this.index = 0;
    }
  }

  // the punch as CS2 returns it: clamped, small values dropped, doubled. frac: draw between the 128 Hz steps
  aimPunch(frac = true) {
    const k = frac ? Math.min(1, this.acc / STEP) : 1;
    const out = [0, 0];
    for (let a = 0; a < 2; a++) out[a] = Math.max(-89, Math.min(89, this.prev[a] + (this.punch[a] - this.prev[a]) * k));
    if (Math.hypot(out[0], out[1]) < MIN_PUNCH) return [0, 0];
    return [out[0] * SCALE, out[1] * SCALE];
  }

  // the view punch now: decays by exp(-18 t)
  viewPunch() {
    const k = Math.exp(-VIEW_PUNCH_DECAY * this.viewAge);
    return [this.view[0] * k, this.view[1] * k];
  }

  // what the camera adds to your view: 45% of the aim punch, plus the view punch
  cameraOffset() {
    const a = this.aimPunch(), v = this.viewPunch();
    return [a[0] * VIEW_TRACKING + v[0], a[1] * VIEW_TRACKING + v[1]];
  }

  // a shot from gun `name`: kicks the punch velocity by the table entry at the recoil index, then counts the shot
  kick(name) {
    const table = recoilTable(name);
    if (!table.length) return;
    const e = table[Math.floor(this.index) % table.length];
    const a = e.angle * Math.PI / 180;
    const kv = [-Math.cos(a) * e.magnitude, -Math.sin(a) * e.magnitude];
    // re-base at now: the punch carries on from where it is, the new velocity is what is left plus the kick
    const v = this._vel(this.t);
    this.prev = [this.punch[0], this.punch[1]];
    this.baseVel = [v[0] + kv[0], v[1] + kv[1]];
    this.t = 0;
    const vp = this.viewPunch();
    this.view = [vp[0] - Math.cos(a) * e.magnitude * VIEW_PUNCH_EXTRA, vp[1] - Math.sin(a) * e.magnitude * VIEW_PUNCH_EXTRA];
    this.viewAge = 0;
    this.index += 1;
    this.sinceShot = 0;
  }
}
