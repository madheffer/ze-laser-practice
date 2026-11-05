// path_track: the nodes func_tracktrain / func_tanktrain ride (classes/trains.js). CS2 CPathTrack, read from
// server.dll (2026-09-23 build, Ghidra project D:\tools\ghidra_projects; addresses below), with Source's
// pathtrack.cpp (CS2Fixes sdk/game/server) for what CS2 inherited unchanged.
//
// Keys (CS2 datamap CPathTrack): target, altpath, speed (m_flSpeed +0x4b4), orientationtype (+0x4cc), spawnflags
// (+0x360), radius (NPC paths only). orientationtype is the CS2 FGD's (game/core/base.fgd) and Source's
// TrackOrientationType_t: 0 "No change", 1 "Face direction of motion" (the default; Source's constructor and the
// Valve importer back-fill it), 2 "Face this path_track's angles". 0 and 1 behave the same in GetOrientation.
import { register } from '../registry.js';
import { stripName } from '../entity.js';
import { num, vectorAngles, quatAngles, rotationOf } from '../math.js';

// spawnflags (FGD; Source pathtrack.h). FIREONCE is unused: CS2's InPass (FUN_180e4d5e0) and the train's
// FirePassInputs (inside FUN_180fb8ef0) fire OnPass every time, as Source (SF_PATH_FIREONCE is commented out there)
export const SF_PATH = { DISABLED: 1, FIREONCE: 2, ALTREVERSE: 4, DISABLE_TRAIN: 8, TELEPORT: 16, ALTERNATE: 0x8000 };

// the node's live spawnflags (Enable/DisablePath and the alternate-path inputs flip bits in them)
export function flags(n) {
  const s = n.state;
  if (s.flags == null) s.flags = num(n.kv.spawnflags) | 0;
  return s.flags;
}
const setFlag = (n, bit, on) => { const f = flags(n); n.state.flags = on ? f | bit : f & ~bit; };

export const orientType = (n) => num(n.kv.orientationtype, 1);

// Link (Source CPathTrack::Link): target / altpath name the first path_track with that name; a node naming itself
// links nothing. Resolved when asked rather than once at Activate, so a killed node reads as a dead end at once.
function linked(n, name) {
  if (!name) return null;
  const t = n.engine.findOne(name);
  return t && t !== n && t.alive && t.cls === 'path_track' ? t : null;
}
const alt = (n) => linked(n, n.kv.altpath);

// m_pprevious: set by every node linking to this one (target or altpath), the last one wins, except the node this
// one names as its own altpath (Source SetPrevious)
function linkedPrevious(n) {
  let p = null;
  const own = n.kv.altpath ? stripName(n.kv.altpath) : null;
  for (const e of n.engine.byClass.get('path_track') || []) {
    if (e === n || !e.alive || (own && e.key === own)) continue;
    if (linked(e, e.kv.target) === n || alt(e) === n) p = e;
  }
  return p;
}

// GetNext (FUN_180e77150): the alternate path when it is switched on and not a reverse branch
export function next(n) {
  const a = alt(n);
  return a && (flags(n) & (SF_PATH.ALTERNATE | SF_PATH.ALTREVERSE)) === SF_PATH.ALTERNATE ? a : linked(n, n.kv.target);
}
// GetPrevious (FUN_180e77620): the alternate path when it is switched on and a reverse branch
export function previous(n) {
  const a = alt(n);
  return a && (flags(n) & (SF_PATH.ALTERNATE | SF_PATH.ALTREVERSE)) === (SF_PATH.ALTERNATE | SF_PATH.ALTREVERSE) ? a : linkedPrevious(n);
}
// GetNextInDir (FUN_180e77230)
export const nextInDir = (n, forward) => (forward ? next(n) : previous(n));
// ValidPath (FUN_180e98990): null for a disabled node when testing
export const validPath = (n, test = true) => (n && !(test && flags(n) & SF_PATH.DISABLED) ? n : null);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);

// LookAhead (FUN_180e7fbf0): walk `dist` units along the path from `origin` (mutated: where you end up; negative
// dist walks backward). Returns { node: the node you are past when you get there (null at a dead end, or a
// disabled node when `move`), nextNext: the node after it }. Without `move` a dead end projects `origin` on along
// the last segment (Project).
export function lookAhead(start, origin, dist, move) {
  const forward = dist >= 0;
  let left = Math.abs(dist);
  let cur = start;
  let pos = [...origin];
  while (left > 0) {
    const nxt = nextInDir(cur, forward);
    if (!nxt) {
      if (!move) project(nextInDir(cur, !forward), cur, origin, left);
      return { node: null, nextNext: null };
    }
    if (move && flags(nxt) & SF_PATH.DISABLED) return { node: null, nextNext: null };
    const np = nxt.worldOrigin();
    const d = sub(np, pos);
    const l = len(d);
    if (l === 0) {
      // standing on the next node with nothing valid beyond it
      const nn = nextInDir(nxt, forward);
      if (!nn || (move && flags(nn) & SF_PATH.DISABLED)) return { node: left === dist ? null : nxt, nextNext: null };
    }
    if (left < l) {
      const k = left / l;
      origin[0] = pos[0] + d[0] * k; origin[1] = pos[1] + d[1] * k; origin[2] = pos[2] + d[2] * k;
      return { node: cur, nextNext: nextInDir(cur, forward) };
    }
    left -= l;
    pos = np;
    cur = nxt;
    origin[0] = np[0]; origin[1] = np[1]; origin[2] = np[2];
  }
  return { node: cur, nextNext: nextInDir(cur, forward) };
}

// Project: on past `end` along the direction from `start`, `dist` units
function project(start, end, origin, dist) {
  if (!start || !end) return;
  const a = start.worldOrigin(), b = end.worldOrigin();
  const d = sub(b, a);
  const l = len(d) || 1;
  origin[0] = b[0] + (d[0] / l) * dist; origin[1] = b[1] + (d[1] / l) * dist; origin[2] = b[2] + (d[2] / l) * dist;
}

// The node's own angles (GetLocalAngles; world angles here, as the train works in world space)
export const nodeAngles = (n) => quatAngles(rotationOf(n.getWorld()));

// GetOrientation (FUN_180e773e0): type 2 = the node's angles; otherwise the direction of the segment leaving it
// (or, at the end of the path, of the one arriving). null for a lone node (CS2 would read through a null pointer).
export function orientation(n, forward) {
  if (orientType(n) === 2) return nodeAngles(n);
  let a = n, b = nextInDir(n, forward);
  if (!b) { b = n; a = nextInDir(n, !forward); }
  if (!a) return null;
  return vectorAngles(sub(b.worldOrigin(), a.worldOrigin()));
}

// InPass (FUN_180e4d5e0): OnPass with the passing train as activator
export function pass(n, activator) {
  n.fireOutput('OnPass', activator);
}

register('path_track', {
  input(e, inp, p, act) {
    const a = alt(e);
    switch (inp) {
      case 'inpass': pass(e, act); return true;
      // FUN_180e4def0 / FUN_180e4df80 / FUN_180e4e080
      case 'enablepath': setFlag(e, SF_PATH.DISABLED, false); return true;
      case 'disablepath': setFlag(e, SF_PATH.DISABLED, true); return true;
      case 'togglepath': setFlag(e, SF_PATH.DISABLED, !(flags(e) & SF_PATH.DISABLED)); return true;
      // FUN_180e4dc30 / FUN_180e4dda0 / FUN_180e94430: only a node with a live alternate path switches
      case 'enablealternatepath': if (a) setFlag(e, SF_PATH.ALTERNATE, true); return true;
      case 'disablealternatepath': if (a) setFlag(e, SF_PATH.ALTERNATE, false); return true;
      case 'togglealternatepath': if (a) setFlag(e, SF_PATH.ALTERNATE, !(flags(e) & SF_PATH.ALTERNATE)); return true;
    }
    void p;
  },
});
