// A run's replay, as bytes: where the player stood and looked on every 64-tick step, plus the few things they did
// that change the map (shots at a boss, the map item's E, fall damage). Nothing about the map itself is stored:
// playback rebuilds the stage from the same seed and rules (app/replay-play.js), and the map's own entity logic
// replays everything else, exactly as the co-op anti-cheat does with a round's positions (server/coop-check.js).
//
// Shared by the page (app/replay-record.js writes it, app/replay-play.js reads it) and the server (server/replays.js
// checks an upload by decoding it). Pure functions, no DOM; everything read is bounds-checked (uploads are untrusted).
//
// Layout: varint(VERSION) varint(n) then n ticks, then varint(events) and the events.
//   tick:  zigzag deltas of x, y, z (1/32 unit), yaw, pitch (1/10 degree; yaw wraps), then one flags byte:
//          bits 0-3 duckAmount (0..15), bit 4 on the ground, bit 5 ducked, bit 6 the AK-47 is out
//   event: varint(tick delta from the last event), varint(type), then its fields (EVENT_FIELDS)
// The bytes are gzipped on the wire and in the database (CompressionStream / zlib).

export const VERSION = 1;
export const POS_SCALE = 32;
export const ANG_SCALE = 10;
export const MAX_TICKS = 64 * 60 * 30; // 30 minutes
export const MAX_EVENTS = 40000;
export const MAX_BYTES = 2 * 1024 * 1024; // decoded

// type -> its fields (all integers; *zz = signed). 'shot' carries the view it was fired at (mouse look moves between ticks)
export const EVENTS = ['shot', 'use', 'fall'];
const EVENT_FIELDS = {
  shot: ['kind', 'damage', 'range', 'yaw*zz', 'pitch*zz'], // kind: SHOT_KINDS index; yaw/pitch x ANG_SCALE
  use: [],
  fall: ['damage'], // x 10
};
export const SHOT_KINDS = ['bullet', 'slash', 'stab'];

const zig = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzig = (u) => (u % 2 ? -(u + 1) / 2 : u / 2);
const wrap = (d, span) => ((((d + span / 2) % span) + span) % span) - span / 2;

class Writer {
  constructor() { this.buf = new Uint8Array(4096); this.n = 0; }
  byte(b) {
    if (this.n >= this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    this.buf[this.n++] = b;
  }
  uint(v) { // v >= 0, < 2^53
    while (v >= 0x80) { this.byte((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
    this.byte(v);
  }
  int(v) { this.uint(zig(v)); }
  bytes() { return this.buf.subarray(0, this.n); }
}

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  byte() { if (this.i >= this.b.length) throw new Error('replay: truncated'); return this.b[this.i++]; }
  uint() {
    let v = 0, mul = 1;
    for (let k = 0; k < 8; k++) {
      const b = this.byte();
      v += (b & 0x7f) * mul;
      if (!(b & 0x80)) return v;
      mul *= 0x80;
    }
    throw new Error('replay: bad number');
  }
  int() { return unzig(this.uint()); }
}

// ticks: { x, y, z, yaw, pitch, flags } (Int32Arrays / Uint8Array, already quantised: x = round(origin x * POS_SCALE)...)
// events: [{ tick, type, ...fields }] in tick order
export function encodeReplay(ticks, n, events) {
  const w = new Writer();
  w.uint(VERSION);
  w.uint(n);
  let px = 0, py = 0, pz = 0, pyaw = 0, ppitch = 0;
  for (let i = 0; i < n; i++) {
    w.int(ticks.x[i] - px); w.int(ticks.y[i] - py); w.int(ticks.z[i] - pz);
    w.int(wrap(ticks.yaw[i] - pyaw, 360 * ANG_SCALE)); w.int(ticks.pitch[i] - ppitch);
    w.byte(ticks.flags[i]);
    px = ticks.x[i]; py = ticks.y[i]; pz = ticks.z[i]; pyaw = ticks.yaw[i]; ppitch = ticks.pitch[i];
  }
  w.uint(events.length);
  let last = 0;
  for (const ev of events) {
    w.uint(ev.tick - last);
    last = ev.tick;
    w.uint(EVENTS.indexOf(ev.type));
    for (const f of EVENT_FIELDS[ev.type]) {
      const [name, signed] = f.split('*');
      if (signed) w.int(ev[name]); else w.uint(ev[name]);
    }
  }
  return w.bytes();
}

// -> { n, x, y, z, yaw, pitch, flags, events }; throws on anything malformed
export function decodeReplay(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) throw new Error('replay: too large');
  const r = new Reader(bytes);
  if (r.uint() !== VERSION) throw new Error('replay: unknown version');
  const n = r.uint();
  if (n < 1 || n > MAX_TICKS) throw new Error('replay: bad length');
  const out = {
    n, x: new Int32Array(n), y: new Int32Array(n), z: new Int32Array(n),
    yaw: new Int32Array(n), pitch: new Int32Array(n), flags: new Uint8Array(n), events: [],
  };
  const LIMIT = 40000 * POS_SCALE; // well past any map's bounds (Source caps at +-16384)
  let x = 0, y = 0, z = 0, yaw = 0, pitch = 0;
  for (let i = 0; i < n; i++) {
    x += r.int(); y += r.int(); z += r.int();
    yaw = wrap(yaw + r.int(), 360 * ANG_SCALE); pitch += r.int();
    if (Math.abs(x) > LIMIT || Math.abs(y) > LIMIT || Math.abs(z) > LIMIT || Math.abs(pitch) > 90 * ANG_SCALE) throw new Error('replay: out of range');
    out.x[i] = x; out.y[i] = y; out.z[i] = z; out.yaw[i] = yaw; out.pitch[i] = pitch;
    out.flags[i] = r.byte();
  }
  const count = r.uint();
  if (count > MAX_EVENTS) throw new Error('replay: too many events');
  let tick = 0;
  for (let k = 0; k < count; k++) {
    tick += r.uint();
    const type = EVENTS[r.uint()];
    if (!type || tick > n) throw new Error('replay: bad event');
    const ev = { tick, type };
    for (const f of EVENT_FIELDS[type]) {
      const [name, signed] = f.split('*');
      ev[name] = signed ? r.int() : r.uint();
    }
    if (type === 'shot' && !SHOT_KINDS[ev.kind]) throw new Error('replay: bad shot');
    out.events.push(ev);
  }
  if (r.i !== bytes.length) throw new Error('replay: trailing bytes');
  return out;
}

// The replay's header (what to rebuild the stage with), cleaned the same way on both sides.
// seed: the run's own seed, without which the stage would not play out the same.
const STAGE_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
export function cleanMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const rules = m.rules && typeof m.rules === 'object' ? m.rules : {};
  if (!Number.isInteger(m.seed) || m.seed < 0 || m.seed > 0x7fffffff) return null;
  if (typeof m.stage !== 'string' || !STAGE_ID.test(m.stage)) return null;
  return {
    v: VERSION,
    seed: m.seed,
    map: typeof m.map === 'string' ? m.map.slice(0, 80) : '',
    mapVersion: typeof m.mapVersion === 'string' ? m.mapVersion.slice(0, 64) : '',
    stage: m.stage,
    mode: m.mode === 'endless' ? 'endless' : 'normal',
    weapon: m.weapon === 'gun' ? 'gun' : 'knife',
    rules: {
      humans: Math.round(num(rules.humans, 1, 64, 20)), bossHp: Math.round(num(rules.bossHp, 1, 100, 100)),
      autoFire: rules.autoFire !== false, perfectTeam: rules.perfectTeam === true, fallDamage: rules.fallDamage === true,
      healItem: rules.healItem === true,
    },
  };
}
