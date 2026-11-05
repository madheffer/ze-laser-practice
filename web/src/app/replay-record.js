// Recording your solo run for its replay (lib/replay-codec.js): loop.js hands over the player after every tick,
// bosses.js your shots, items.js your E, session.js fall damage. ~6-8 bytes a tick before gzip.
import { encodeReplay, POS_SCALE, ANG_SCALE, MAX_TICKS, MAX_EVENTS, SHOT_KINDS } from '../lib/replay-codec.js';

const q = (v, s) => Math.round(v * s);

export class ReplayRecorder {
  // meta: lib/replay-codec.js cleanMeta's fields (seed, map, stage, mode, rules, weapon...)
  constructor(meta) {
    this.meta = meta;
    this.cap = 64 * 60;
    this.n = 0;
    this.t = this.alloc(this.cap);
    this.events = [];
    this.full = false;
  }

  alloc(cap) {
    return { x: new Int32Array(cap), y: new Int32Array(cap), z: new Int32Array(cap), yaw: new Int32Array(cap), pitch: new Int32Array(cap), flags: new Uint8Array(cap) };
  }

  // tick k (1, 2, 3...: run.ticks) after the player has moved
  pose(k, player, gun) {
    if (this.full) return;
    if (k !== this.n + 1 || this.n >= MAX_TICKS) { this.full = true; return; } // a gap: stop (never a wrong replay)
    if (this.n >= this.cap) {
      const t = this.alloc(this.cap *= 2);
      for (const key of Object.keys(t)) t[key].set(this.t[key]);
      this.t = t;
    }
    const i = this.n++, o = player.origin, t = this.t;
    t.x[i] = q(o[0], POS_SCALE); t.y[i] = q(o[1], POS_SCALE); t.z[i] = q(o[2], POS_SCALE);
    t.yaw[i] = q((((player.yaw % 360) + 540) % 360) - 180, ANG_SCALE); t.pitch[i] = q(Math.max(-89, Math.min(89, player.pitch)), ANG_SCALE);
    t.flags[i] = Math.round(Math.max(0, Math.min(1, player.duckAmount)) * 15) | (player.onGround ? 16 : 0) | (player.ducked ? 32 : 0) | (gun ? 64 : 0);
  }

  event(tick, type, fields = {}) {
    if (this.full || this.events.length >= MAX_EVENTS) return;
    this.events.push({ tick, type, ...fields });
  }
  shot(tick, shot, yaw, pitch) {
    const kind = SHOT_KINDS.indexOf(shot.kind);
    if (kind < 0) return;
    this.event(tick, 'shot', {
      kind, damage: Math.max(0, Math.round(shot.damage || 0)), range: Math.max(0, Math.round(shot.range || 0)),
      yaw: q((((yaw % 360) + 540) % 360) - 180, ANG_SCALE), pitch: q(Math.max(-89, Math.min(89, pitch)), ANG_SCALE),
    });
  }

  // -> { meta, bytes } (not gzipped), or null when nothing usable was recorded
  finish() {
    if (this.full || !this.n) return null;
    return { meta: { ...this.meta, ticks: this.n }, bytes: encodeReplay(this.t, this.n, this.events) };
  }
}

// your own last recorded run, for its end card's "Watch replay" (app/replay.js): { meta, bytes, info } or null
let last = null;
export function keepLastRun(rec, info) { last = rec ? { meta: rec.meta, bytes: rec.bytes, info } : null; }
export const lastRun = () => last;
