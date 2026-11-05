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

// Seeded PRNG for logic_case picks and random timers, so a seed replays a run exactly.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
