import * as THREE from 'three';

// ── AG2 clip pose source (P3) ────────────────────────────────────────────────
// A clip in the AG2 graph is sampled to a POSE (per-bone local transform) at a
// time t. We build the pose source from a three.js AnimationClip baked out of
// the .vnmclip by VRF (VRF already did the smallest-three quaternion +
// quantized translation/scale decode at export). The evaluator needs bone-level
// pose access (not AnimationMixer's global action weights) so it can blend
// per-bone (layer blend, bone masks, blend1d) exactly like the real graph.

export class Pose {
  constructor() { this.bones = new Map(); }          // boneName -> {pos,quat,scale}
  get(name) {
    let b = this.bones.get(name);
    if (!b) this.bones.set(name, b = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) });
    return b;
  }
  clear() { this.bones.clear(); return this; }       // MUST clear before pool reuse:
  // a stale pooled pose reads as a full absolute pose, and an additive layer
  // composing it on top doubles every bone position (the stretched-arm bug).
}

function findIdx(times, t) {                          // last index with times[i] <= t
  const n = times.length;
  if (t <= times[0]) return 0;
  if (t >= times[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

export class ClipSource {
  constructor(animClip, eventData = null) {
    this.name = animClip.name;
    this.duration = animClip.duration;
    // The clip's CNmIDEvent windows (clip-events.json, seconds): the sections
    // graph transitions test (IDEventCondition) and seek to (targetSyncID) -
    // hold-to-inspect pivots on WPN_INSPECT_INTRO/LOOP/OUTRO. The glTF bake
    // cannot carry them, so they ride in as a sidecar; null = none known.
    this.events = eventData?.events ?? null;
    this.tracks = new Map();                          // bone -> {position?, quaternion?, scale?}
    for (const tr of animClip.tracks) {
      const dot = tr.name.lastIndexOf('.');
      const bone = tr.name.slice(0, dot);
      const prop = tr.name.slice(dot + 1);            // position | quaternion | scale
      let e = this.tracks.get(bone);
      if (!e) this.tracks.set(bone, e = {});
      e[prop] = { times: tr.times, values: tr.values };
    }
  }

  // Sample the whole clip at time t into `pose` (a Pose). Bones without a track
  // for a channel keep their last value (caller seeds bind pose if needed).
  sample(t, pose) {
    t = Math.max(0, Math.min(t, this.duration || 0));
    for (const [bone, tr] of this.tracks) {
      const p = pose.get(bone);
      if (tr.position) sampleVec(tr.position, t, p.pos);
      if (tr.quaternion) sampleQuat(tr.quaternion, t, p.quat);
      if (tr.scale) sampleVec(tr.scale, t, p.scale);
    }
    return pose;
  }
}

function sampleVec(tr, t, out) {
  const { times, values } = tr;
  const i = findIdx(times, t);
  if (i >= times.length - 1) { out.set(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]); return; }
  const t0 = times[i], t1 = times[i + 1];
  const a = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const j = (i + 1) * 3, k = i * 3;
  out.set(
    values[k] + (values[j] - values[k]) * a,
    values[k + 1] + (values[j + 1] - values[k + 1]) * a,
    values[k + 2] + (values[j + 2] - values[k + 2]) * a);
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function sampleQuat(tr, t, out) {
  const { times, values } = tr;
  const i = findIdx(times, t);
  if (i >= times.length - 1) { out.set(values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]); return; }
  const t0 = times[i], t1 = times[i + 1];
  const a = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const k = i * 4, j = (i + 1) * 4;
  _qa.set(values[k], values[k + 1], values[k + 2], values[k + 3]);
  _qb.set(values[j], values[j + 1], values[j + 2], values[j + 3]);
  out.copy(_qa).slerp(_qb, a);
}
