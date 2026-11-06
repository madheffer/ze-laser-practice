// Keyvalue parsing and Source angle maths shared by the engine and the entity classes.
import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const ONE = new THREE.Vector3(1, 1, 1);

export function parseVec(s, def = [0, 0, 0]) {
  if (s == null || s === '') return [...def];
  const nums = String(s).replace(/[\[\],]/g, ' ').trim().split(/\s+/).map(Number);
  return [nums[0] || 0, nums[1] || 0, nums[2] || 0];
}
export const num = (s, d = 0) => { const v = parseFloat(s); return Number.isFinite(v) ? v : d; };

// Does a trigger touch players? Its "Clients" (1) or "Everything" (64) spawnflag (CS2 FGD), then its filter decides
// (ze_tyranny2's boss steering triggers are 64 only). UNSETTLED: CS2's trigger flag test isn't decompiled yet; that
// "Everything" includes players is the FGD's wording, not traced in server.dll
export const touchesPlayers = (kv) => (num(kv.spawnflags) & (1 | 64)) !== 0;
export const bool = (s) => s === true || s === 'true' || s === '1' || s === 1;

// Source QAngle (pitch, yaw, roll in degrees) -> quaternion. Rz(yaw) * Ry(pitch) * Rx(roll).
export function angleQuat(a, q = new THREE.Quaternion()) {
  return q.setFromEuler(new THREE.Euler(a[2] * DEG, a[0] * DEG, a[1] * DEG, 'ZYX'));
}
// A world matrix from an origin [x,y,z] and a rotation (quaternion).
export function poseMatrix(origin, quat) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...origin), quat, ONE);
}
// The rotation part of a matrix, as a quaternion.
export const rotationOf = (m) => new THREE.Quaternion().setFromRotationMatrix(m);

// Source angles -> unit forward vector (also the view direction for pitch/yaw).
export function angleForward(a) {
  const p = a[0] * DEG, y = a[1] * DEG;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}

// A camera's rotation from your view angles, as Source builds the view (AngleMatrix on the QAngle, roll 0): a pitch
// past +-90 (an aim punch on top of looking straight up or down) rolls the view on over the top, never turns it round.
// three's camera looks down its -Z with +Y up; Source's view frame is forward +X, left +Y, up +Z.
const VIEW_BASIS = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
  0, 0, -1, 0,
  -1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1));
export function viewQuat(pitch, yaw, q = new THREE.Quaternion()) {
  return angleQuat([pitch, yaw, 0], q).multiply(VIEW_BASIS);
}

// The same direction with pitch inside [-90, 90] (pitch -99 at yaw y is pitch -81 at yaw y + 180): for a shot whose
// punch went past vertical, which replays and the co-op server keep as a +-90 pitch.
export function foldPitch(pitch, yaw) {
  const p = ((((pitch + 180) % 360) + 360) % 360) - 180;
  if (p < -90) return [-180 - p, yaw + 180];
  if (p > 90) return [180 - p, yaw + 180];
  return [p, yaw];
}

// ---- CS2 mathlib angle rules (server.dll 2026-09-23 build, read in Ghidra; Source's mathlib_base.cpp has the same
// shapes). Angles are degrees, QAngle order [pitch, yaw, roll].

// AngleDistance (FUN_181469180): next - cur, wrapped once into (-180, 180]
export function angleDistance(next, cur) {
  const d = next - cur;
  if (d <= -180) return d + 360;
  return d > 180 ? d - 360 : d;
}

// anglemod as ApproachAngle does it (FUN_181469650): into [0, 360)
function angleMod(a) {
  if (a < -180 || a > 180) a = Math.min(180, Math.max(-180, a - Math.floor(a / 360 + 0.5) * 360));
  return a < 0 ? a + 360 : a;
}

// ApproachAngle (FUN_181469650): turn value toward target by at most |speed|, the short way round
export function approachAngle(target, value, speed) {
  target = angleMod(target); value = angleMod(value); speed = Math.abs(speed);
  let d = target - value;
  if (d < -180) d += 360; else if (d > 180) d -= 360;
  if (d > speed) return value + speed;
  return d < -speed ? value - speed : target;
}

// VectorAngles (FUN_18146fb60): a direction -> [pitch, yaw, 0], each in [0, 360); straight up / down is pitch 270 / 90
export function vectorAngles(v) {
  if (v[0] === 0 && v[1] === 0) return [v[2] > 0 ? 270 : 90, 0, 0];
  let yaw = Math.atan2(v[1], v[0]) / DEG;
  if (yaw < 0) yaw += 360;
  let pitch = Math.atan2(-v[2], Math.hypot(v[0], v[1])) / DEG;
  if (pitch < 0) pitch += 360;
  return [pitch, yaw, 0];
}

// FixupAngles (FUN_180e73960, Source movement.cpp): each component into [0, 360], in place
export function fixupAngles(a) {
  for (let i = 0; i < 3; i++) {
    let x = Number.isFinite(a[i]) ? a[i] : 0;
    if (Math.abs(x) > 1e6) x %= 360;
    while (x < 0) x += 360;
    while (x > 360) x -= 360;
    a[i] = x;
  }
  return a;
}

// A rotation (quaternion) -> QAngle [pitch, yaw, roll]: the inverse of angleQuat
export function quatAngles(q) {
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  return [e.y / DEG, e.z / DEG, e.x / DEG];
}

// Seeded PRNG for logic_case picks and random timers, so a seed replays a run exactly.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
