// World streaming: a map's world split into chunks (tools/chunk-world.mjs -> world/chunks.json + chunk_<n>.glb) is
// loaded around where you are instead of all at once. Rendering only: collision, hulls and entities are whole
// from the start, so the game plays the same whatever has been drawn yet.
//
// Every frame update(pos, see) asks for:
//   1. the area: chunks within `radius` of the camera, plus the always-loaded ones (meshes wider than a chunk that
//      can't be cut, such as props spanning cells), nearest first, a few at a time.
//   2. then (mode 'auto') what can still be seen from there: chunks within `see`, the far plane or where the map's
//      fog turns opaque (world/lighting.js viewDistance), one at a time so a load never stalls a frame for long.
//      Mode 'area' stops at 1 (slow PCs); 'all' loads everything.
// A stage waits only for what its first frames can show (gate): the always-loaded chunks and the area's chunks
// within GATE_RADIUS and the view distance (the far plane / opaque fog, `see`); the rest streams in while it plays.
// Chunks stay once loaded.

// the farthest a stage waits for (units, ~150 m): what fills a first view; past it (or past where the fog turns
// opaque) the world streams in while the stage plays, nearest first. Scenery only: collision is whole from the start.
const GATE_RADIUS = 6000;
const CONCURRENT = 6; // a browser's HTTP/1.1 connections per host (HTTP/2 multiplexes more; 6 keeps a frame's decode short)

export class WorldStream {
  // list: chunks.json entries { file, min, max, always }; load(file) -> Promise<THREE.Object3D>; add(scene)
  constructor(list, { load, add, radius = 12000, mode = 'auto', log = () => {} }) {
    this.chunks = list.map((c) => ({ ...c, state: 'idle' })); // idle | loading | done | failed
    this.load = load;
    this.add = add;
    this.radius = radius;
    this.mode = mode;
    this.see = Infinity;
    this.log = log;
    this.active = 0;
    this.disposed = false;
    this.dirty = true;
    this.waiters = [];
  }

  // distance from a point to a chunk's box (0 inside)
  static dist(c, p) {
    let s = 0;
    for (let k = 0; k < 3; k++) { const d = Math.max(c.min[k] - p[k], 0, p[k] - c.max[k]); s += d * d; }
    return Math.sqrt(s);
  }

  // the area a stage needs
  wanted(c, p) { return this.mode === 'all' || c.always || WorldStream.dist(c, p) <= this.radius; }
  // what a stage waits for at p: the area, no farther than can be seen
  gate(c, p) { return c.always || WorldStream.dist(c, p) <= Math.min(this.radius, this.see, GATE_RADIUS); }
  // visible from p, after the area
  extra(c, p) { return this.mode === 'auto' && WorldStream.dist(c, p) <= this.see; }

  // mode: 'auto' | 'area' | 'all'
  setMode(mode) { if (mode !== this.mode) { this.mode = mode; this.dirty = true; } }

  update(pos, see = Infinity) {
    if (this.disposed || !pos) return;
    if (Math.abs(see - this.see) > 256) { this.see = see; this.dirty = true; }
    // per frame: nothing to do unless something is left to load and you moved (or a load finished: dirty)
    const moved = !this.pos || Math.hypot(pos[0] - this.pos[0], pos[1] - this.pos[1], pos[2] - this.pos[2]) > 128;
    if (!moved && !this.dirty) return;
    this.dirty = false;
    this.pos = [pos[0], pos[1], pos[2]];
    if (this.active < CONCURRENT && this.chunks.some((c) => c.state === 'idle')) {
      const byDist = (a, b) => (b.always - a.always) || WorldStream.dist(a, this.pos) - WorldStream.dist(b, this.pos);
      const area = this.chunks.filter((c) => c.state === 'idle' && this.wanted(c, this.pos)).sort(byDist);
      if (area.length) for (const c of area.slice(0, CONCURRENT - this.active)) this.fetch(c);
      else if (this.active === 0) {
        const far = this.chunks.filter((c) => c.state === 'idle' && this.extra(c, this.pos)).sort(byDist);
        if (far.length) this.fetch(far[0]);
      }
    }
    this.checkWaiters();
  }

  fetch(c) {
    c.state = 'loading';
    this.active++;
    this.load(c.file).then((scene) => {
      if (this.disposed) return;
      c.state = 'done';
      this.add(scene, c);
    }, (e) => {
      c.state = 'failed'; // a missing chunk is a hole in the scenery, not the end of the map
      this.log(`world ${c.file}: ${e?.message || e}`);
    }).finally(() => {
      this.active--;
      this.dirty = true;
      if (!this.disposed && this.pos) this.update(this.pos, this.see);
    });
  }

  ready(pos) {
    return this.chunks.every((c) => c.state === 'done' || c.state === 'failed' || !this.gate(c, pos));
  }

  // the chunks a stage waits for at pos (gate): [loaded, total]
  progress(pos) {
    const need = this.chunks.filter((c) => this.gate(c, pos));
    return [need.filter((c) => c.state === 'done' || c.state === 'failed').length, need.length];
  }

  whenReady(pos) {
    this.dirty = true;
    this.update(pos, this.see);
    if (this.ready(pos)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ pos, resolve }));
  }

  checkWaiters() {
    this.waiters = this.waiters.filter((w) => (this.ready(w.pos) ? (w.resolve(), false) : true));
  }

  dispose() {
    this.disposed = true;
    for (const w of this.waiters) w.resolve();
    this.waiters = [];
  }
}

// chunks.json -> a checked list (untrusted: file names from the fixed chunk_<n>.glb set, finite boxes)
export function chunkList(json) {
  const list = Array.isArray(json?.chunks) ? json.chunks : [];
  const out = [];
  for (const c of list) {
    if (typeof c?.file !== 'string' || !/^world\/chunk_\d{1,6}\.glb$/.test(c.file)) continue;
    const min = Array.isArray(c.min) ? c.min.map(Number) : [], max = Array.isArray(c.max) ? c.max.map(Number) : [];
    if (min.length !== 3 || max.length !== 3 || ![...min, ...max].every(Number.isFinite)) continue;
    out.push({ file: c.file, min, max, always: c.always === true });
  }
  return out;
}
