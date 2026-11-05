#!/usr/bin/env node
// A CS2 world clip, decoded to pose JSON, -> the stance file web/src/world/body.js poses the player with.
//
// The decode is vpkstuff's lab pipeline (its tools/previewer/extract-tp-clips.py): Source2Viewer-CLI turns the
// .vnmclip_c into DMX, pose_extract.py turns the DMX into {skeleton, order, clips[0].bones}. DMX is Y-up, so that
// file's ROOT bones (root_motion's children: pelvis, wpnPivot, ...) are still in the Y-up frame; the weaponviewer
// bake (Z:\weaponviewer\tp\clips\pose_idle_knife.json) carries them rotated into Source's Z-up frame. This does that
// one step: q' = Q q, p' = Q p for root_motion's children, Q = (0.5, 0.5, 0.5, 0.5) (x->y, y->z, z->x), in the
// skeleton and in every key. Measured: it reproduces the weaponviewer idle on all 74 bones (`--check <file>`).
//
//   node tools/tp-pose.mjs <pose_extract.json> <out.json> [--check <reference.json>]
import fs from 'node:fs';
import path from 'node:path';

const [src, out, flag, ref] = process.argv.slice(2);
if (!src || !out || !out.endsWith('.json')) {
  console.error('usage: node tools/tp-pose.mjs <pose_extract.json> <out.json> [--check <reference.json>]');
  process.exit(2);
}
const pose = JSON.parse(fs.readFileSync(src, 'utf8'));
const ROOT = 'root_motion';

// Q * (x, y, z, w) and Q * v, for Q = (0.5, 0.5, 0.5, 0.5)
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const Q = [0.5, 0.5, 0.5, 0.5];
const rotV = ([x, y, z]) => [z, x, y];
const rnd = (v) => Math.round(v * 1e6) / 1e6;

const roots = Object.entries(pose.skeleton).filter(([, b]) => b.parent === ROOT).map(([n]) => n);
for (const n of roots) {
  const b = pose.skeleton[n];
  b.pos = rotV(b.pos).map(rnd);
  b.rot = qmul(Q, b.rot).map(rnd);
  for (const clip of pose.clips) {
    const tr = clip.bones[n];
    if (!tr) continue;
    if (tr.pos) tr.pos = tr.pos.map(([t, ...v]) => [t, ...rotV(v).map(rnd)]);
    if (tr.rot) tr.rot = tr.rot.map(([t, ...q]) => [t, ...qmul(Q, q).map(rnd)]);
  }
}

if (flag === '--check' && ref) {
  const want = JSON.parse(fs.readFileSync(ref, 'utf8')).clips[0].bones;
  const got = pose.clips[0].bones;
  let worst = 0, at = '';
  for (const [n, tr] of Object.entries(want)) {
    for (const k of ['pos', 'rot']) {
      const a = tr[k]?.[0], b = got[n]?.[k]?.[0];
      if (!a) continue;
      if (!b) { worst = Infinity; at = `${n} missing`; continue; }
      // a quaternion and its negation are the same rotation
      const d = (s) => Math.max(...a.slice(1).map((v, i) => Math.abs(v - s * b[i + 1])));
      const e = k === 'rot' ? Math.min(d(1), d(-1)) : d(1);
      if (e > worst) { worst = e; at = `${n}.${k}`; }
    }
  }
  console.log(`check vs ${path.basename(ref)}: worst difference ${worst} (${at})`);
}
fs.writeFileSync(out, JSON.stringify(pose));
console.log(`${roots.length} root bones converted -> ${out}`);
