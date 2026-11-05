// Co-op and versus rounds over the relay (net/coop-client.js). How a round stays 1:1 for everyone without
// syncing a single entity:
//   - the host's start carries the map, the stage, the mode and the rules (app/rules.js: seed, humans, boss HP,
//     team fire). Every client builds the same run from them, and the map's logic is deterministic for a seed;
//   - a round runs on the wall clock (loop.js simulate), and guests pull their clock onto the host's from the
//     run time stamped on its states, so the same laser is in the same place on every screen;
//   - boss damage is the host's: guests send their hits, the host applies them with the team's fire and sends
//     back every hit it applied, so the boss (and what its death triggers) is the same everywhere;
//   - each client owns its own player: it sends where it is ~20 times a second and says when it dies.
// The host decides the end: co-op = the survivors win when the stage clears (alone, if you're the last one
// alive), everyone dead = wiped (endless: whoever lasted longest); versus = the last one alive wins.
//
// S.mp is the Round while you're in one (session, bosses and loop call its hooks); null solo.
import { S, G, log } from './state.js';
import { CoopClient } from '../net/coop-client.js';
import { hostRules, cleanRules } from './rules.js';
import { startScenario, stageTime, finish } from './session.js';
import { bossTargets, bossHittable, applyBossDamage } from './bosses.js';
import { showRoundEnd } from './coop-end.js';
import { isMapName } from '../lib/paths.js';
import { CS } from '../world/movement.js';
import { lastFrameAt } from './loop.js';

export const net = new CoopClient();
export const KINDS = ['coop', 'versus'];
export const lobby = { kind: 'coop', busy: false }; // the host's mode choice; busy = a round you're not in

const STATE_MS = 50; // 20 Hz
const BOSS_MS = 100;
const MAX_HITS = 500; // per boss message entry

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const vec = (v, lim) => Array.isArray(v) && v.length === 3 && v.every((x) => num(x, -lim, lim));
const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n); // eslint-disable-line no-control-regex
const r1 = (v) => Math.round(v * 10) / 10;

class Round {
  constructor(d) {
    this.r = d.r;
    this.kind = d.kind;
    this.rules = d.rules;
    this.mode = d.mode;
    this.players = new Map(d.roster.map((m) => [m.id, { id: m.id, name: m.name, alive: true, deadAt: null, by: '', hits: 0 }]));
    this.me = net.you;
    this.ended = false;
    this.interpDelay = 0.1; // others are drawn this far in the past (s), between two of their states
    this.sendAt = 0; this.bossAt = 0;
    this.hitOut = new Map(); // guest: hits for the host
    this.dmgOut = new Map(); // host: hits applied, for everyone
    this.specId = null;
    this.lastAliveSaid = false;
  }

  get isHost() { return net.isHost; }
  get alive() { return [...this.players.values()].filter((p) => p.alive); }
  name(id) { return this.players.get(id)?.name || net.member(id)?.name || 'Player'; }

  // ---- hooks for session.js / bosses.js / loop.js
  bossHit(e, dmg) { add(this.hitOut, e.id, dmg); }
  bossDamaged(e, dmg) { if (this.isHost) add(this.dmgOut, e.id, dmg); }

  died(cause) {
    const p = this.players.get(this.me);
    if (!p || !p.alive) return;
    const t = stageTime();
    net.send({ k: 'dead', r: this.r, by: cause, t, hits: S.run.hits });
    this.markDead(this.me, cause, t, S.run.hits);
  }

  outcome(result) { if (this.isHost && !this.ended) this.end(result === 'win' ? 'win' : 'lose'); }

  pump(now) {
    const run = S.run;
    if (!run || run.done || this.ended) return;
    if (now - this.sendAt >= STATE_MS) {
      this.sendAt = now;
      const p = S.player;
      net.send({ k: 's', r: this.r, t: run.t, o: p.origin.map(r1), yaw: r1(p.yaw), pitch: r1(p.pitch), duck: Math.round(p.duckAmount * 100) / 100, hp: Math.max(0, Math.round(run.hp)), hits: run.hits });
    }
    if (now - this.bossAt >= BOSS_MS) {
      this.bossAt = now;
      if (this.hitOut.size && !this.isHost) net.send({ k: 'hit', r: this.r, h: drain(this.hitOut) }, net.room?.host);
      if (this.dmgOut.size && this.isHost) net.send({ k: 'bd', r: this.r, h: drain(this.dmgOut) });
    }
  }

  spectateView() {
    if (this.specId == null || !this.players.get(this.specId)?.alive) this.specId = this.alive.find((p) => p.id !== this.me)?.id ?? null;
    return this.specId == null ? null : G.peers.eye(this.specId, S.run.t - this.interpDelay);
  }
  spectateNext() {
    const ids = this.alive.filter((p) => p.id !== this.me).map((p) => p.id);
    if (ids.length) this.specId = ids[(ids.indexOf(this.specId) + 1) % ids.length];
  }
  spectateLabel() {
    const v = this.spectateView();
    return v ? `Spectating ${this.name(v.id)}` : 'You died';
  }

  hudLine() {
    const n = this.players.size;
    const a = this.alive.length;
    return `${this.kind === 'versus' ? 'Versus' : 'Co-op'}${n > 1 ? ` · ${a}/${n} alive` : ''}`;
  }

  // ---- round state
  markDead(id, cause, t, hits, note) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.ended) return;
    p.alive = false; p.deadAt = t; p.by = cause; p.hits = hits ?? p.hits;
    G.peers.setAlive(id, false);
    const self = id === this.me;
    if (note) G.killfeed.push({ note: `${p.name} ${note}`, self });
    else G.killfeed.push({ victim: p.name, cause, self });
    const alive = this.alive;
    if (!this.lastAliveSaid && this.players.size > 1 && alive.length === 1) {
      this.lastAliveSaid = true;
      const last = alive[0];
      G.killfeed.push({ note: last.id === this.me ? 'You are the last one alive' : `${last.name} is the last one alive`, self: last.id === this.me });
    }
    if (this.isHost) this.checkEnd();
  }

  checkEnd() {
    if (this.ended) return;
    const a = this.alive.length;
    if (this.kind === 'versus' && this.players.size >= 2) { if (a <= 1) this.end('last'); } else if (a === 0) this.end('wiped');
  }

  // host: decide the result and tell everyone
  end(reason) {
    const all = [...this.players.values()];
    const alive = all.filter((p) => p.alive);
    const versus = this.kind === 'versus' && all.length >= 2;
    let winners = [];
    if (reason === 'win') {
      winners = alive;
      if (versus && alive.length > 1) { const best = Math.min(...alive.map((p) => p.hits)); winners = alive.filter((p) => p.hits === best); }
    } else if (reason === 'last' && alive.length) winners = alive;
    else if (reason === 'last' || (reason === 'wiped' && (S.run?.endless || versus))) {
      // everyone is down: whoever lasted longest (within a tick = a draw)
      const longest = Math.max(...all.map((p) => p.deadAt ?? 0));
      winners = all.filter((p) => (p.deadAt ?? 0) >= longest - CS.tick);
    } else if (reason === 'lose' && versus) winners = alive;
    const result = reason === 'win' && !versus ? 'win' : versus ? (winners.length === 1 ? 'win' : 'draw') : reason === 'wiped' && S.run?.endless ? 'over' : 'lose';
    const t = stageTime();
    const d = {
      k: 'end', r: this.r, result, reason, t, winners: winners.map((p) => p.id),
      // a guest's clock can run a frame ahead of the host's: nobody died after the round ended
      stats: all.map((p) => ({ id: p.id, alive: p.alive, t: p.deadAt == null ? null : Math.min(p.deadAt, t), hits: p.id === this.me ? S.run.hits : p.hits })),
    };
    net.send(d);
    this.applyEnd(d);
  }

  applyEnd(d) {
    if (this.ended) return;
    this.ended = true;
    for (const s of d.stats) {
      const p = this.players.get(s.id);
      if (p) { p.alive = s.alive; p.deadAt = s.t; p.hits = s.hits; }
    }
    const run = S.run;
    if (run) run.done = true;
    G.pause();
    document.exitPointerLock?.();
    showRoundEnd(this, d);
  }
}

function add(map, id, dmg) { const k = `${id}:${dmg}`; map.set(k, (map.get(k) || 0) + 1); }
function drain(map) {
  const out = [...map].map(([k, n]) => { const [id, dmg] = k.split(':').map(Number); return [id, dmg, n]; });
  map.clear();
  return out;
}

// boss hits from the network: [entity id, damage, count], each one a live boss of this stage
function applyHits(list, viaHost) {
  if (!Array.isArray(list) || !S.engine) return;
  const targets = new Map(bossTargets().map(({ e }) => [e.id, e]));
  for (const h of list.slice(0, 32)) {
    if (!Array.isArray(h) || !Number.isInteger(h[0]) || !num(h[1], 0, 100000) || !Number.isInteger(h[2]) || h[2] < 1) continue;
    const e = targets.get(h[0]);
    if (!e) continue;
    for (let k = 0; k < Math.min(h[2], MAX_HITS); k++) {
      if (!viaHost && !bossHittable(e)) break; // the host checks a guest's hits like its own
      applyBossDamage(e, h[1]);
    }
  }
}

// ---- starting a round
export function hostStart(i, mode) {
  if (!S.map || !net.isHost) return;
  const sc = i >= 0 ? S.scenarios[i] : null;
  const d = {
    k: 'start', r: (Date.now() & 0x7fffffff) || 1, map: S.map.name, stage: sc?.id ?? null,
    mode: mode === 'endless' && sc?.endless ? 'endless' : 'normal', kind: lobby.kind, rules: hostRules(),
    roster: net.room.members.map((m) => ({ id: m.id, name: m.name })),
  };
  net.send(d);
  begin(d, i);
}

function begin(d, i) {
  G.overlay.hide();
  G.killfeed.clear();
  lobby.busy = false;
  S.mp = new Round(d);
  G.peers.set(d.roster.filter((m) => m.id !== net.you));
  startScenario(i, d.mode);
  G.lobby.render();
}

async function onStart(from, d) {
  if (from !== net.room?.host) return;
  const roster = Array.isArray(d.roster) ? d.roster.filter((m) => Number.isInteger(m?.id)).slice(0, 8).map((m) => ({ id: m.id, name: text(m.name, 20) || 'Player' })) : [];
  if (!Number.isInteger(d.r) || !isMapName(d.map) || !KINDS.includes(d.kind) || !['normal', 'endless'].includes(d.mode)) return;
  if (!roster.some((m) => m.id === net.you)) { lobby.busy = true; G.lobby.render(); return; } // a round we joined too late for
  const clean = { k: 'start', r: d.r, map: d.map, stage: d.stage == null ? null : text(d.stage, 80), mode: d.mode, kind: d.kind, rules: cleanRules(d.rules), roster };
  lobby.kind = d.kind;
  if (S.map?.name !== clean.map) {
    try { await G.selectMap(clean.map); } catch (e) { G.lobby.note(`Could not load ${clean.map}: ${e.message || e}`); return; }
  }
  const i = clean.stage == null ? -1 : S.scenarios.findIndex((s) => s.id === clean.stage);
  if (clean.stage != null && i < 0) { G.lobby.note(`This copy has no stage "${clean.stage}"`); return; }
  begin(clean, i);
  // our run starts without a click (the host's click started the round): the menu shows Resume until you click in
  G.menu.update();
}

function onState(from, d) {
  const mp = S.mp, run = S.run;
  if (!mp || d.r !== mp.r || !run || !num(d.t, 0, 1e6) || !vec(d.o, 1e6) || !num(d.yaw, -1e4, 1e4) || !num(d.pitch, -90, 90) || !num(d.duck, 0, 1)) return;
  G.peers.push(from, { t: d.t, o: d.o, yaw: d.yaw, pitch: d.pitch, duck: d.duck, hp: num(d.hp, 0, 1e6) ? d.hp : 0 });
  const p = mp.players.get(from);
  if (p && num(d.hits, 0, 1e6)) p.hits = d.hits;
  // keep our clock on the host's: half the gap each time, so one late frame can't jerk the world around
  if (from === net.room?.host && !mp.isHost && !run.done) {
    const drift = d.t - run.t;
    if (Math.abs(drift) > 0.04) run.wall0 -= drift * 500;
  }
}

function onMsg(from, d) {
  const mp = S.mp;
  switch (d.k) {
    case 'start': onStart(from, d); break;
    case 's': onState(from, d); break;
    case 'dead':
      if (mp && d.r === mp.r && from !== net.you) mp.markDead(from, text(d.by, 40) || 'the map', num(d.t, 0, 1e6) ? d.t : stageTime(), num(d.hits, 0, 1e6) ? d.hits : undefined);
      break;
    case 'hit': if (mp && d.r === mp.r && mp.isHost && !mp.ended) applyHits(d.h, false); break;
    case 'bd': if (mp && d.r === mp.r && !mp.isHost && from === net.room?.host && !mp.ended) applyHits(d.h, true); break;
    case 'end': if (mp && d.r === mp.r && from === net.room?.host && Array.isArray(d.stats) && Array.isArray(d.winners)) mp.applyEnd(cleanEnd(d)); break;
    case 'lobby': if (from === net.room?.host && KINDS.includes(d.kind)) { lobby.kind = d.kind; lobby.busy = !!d.busy && !S.mp; G.lobby.render(); } break;
  }
}

function cleanEnd(d) {
  return {
    k: 'end', r: d.r, result: ['win', 'lose', 'draw', 'over'].includes(d.result) ? d.result : 'lose', reason: text(d.reason, 10),
    t: num(d.t, 0, 1e6) ? d.t : 0, winners: d.winners.filter(Number.isInteger).slice(0, 8),
    stats: d.stats.slice(0, 8).filter((s) => Number.isInteger(s?.id)).map((s) => ({ id: s.id, alive: !!s.alive, t: num(s.t, 0, 1e6) ? s.t : null, hits: num(s.hits, 0, 1e6) ? s.hits : 0 })),
  };
}

// Room changes: someone left mid-round counts as dead; a newcomer is told the mode (and that a round is on).
function onRoom(room, prev) {
  const mp = S.mp;
  if (mp && !mp.ended) {
    const here = new Set(room.members.map((m) => m.id));
    for (const p of mp.players.values()) if (p.alive && !here.has(p.id)) mp.markDead(p.id, '', stageTime(), undefined, 'left the game');
    if (mp.isHost) mp.checkEnd();
  }
  if (net.isHost) {
    const fresh = room.members.filter((m) => !prev?.members.some((x) => x.id === m.id) && m.id !== net.you);
    for (const m of fresh) net.send({ k: 'lobby', kind: lobby.kind, busy: !!(mp && !mp.ended) }, m.id);
  }
  G.lobby.render();
}

// Leaving the room: a live run carries on solo (dead = that's your run over).
function onLeft() {
  const run = S.run;
  S.mp = null;
  lobby.busy = false;
  G.peers.clear();
  if (run && !run.done && run.spectating) { run.spectating = false; finish('dead'); }
  G.lobby.render();
}

export function setKind(kind) {
  if (!KINDS.includes(kind) || !net.isHost) return;
  lobby.kind = kind;
  net.send({ k: 'lobby', kind, busy: false });
  G.lobby.render();
}

// The host walked away from a live round (changed map): it ends for everyone as it stands.
export function abortRound() {
  if (S.mp && !S.mp.ended && S.mp.isHost && S.run && !S.run.done) S.mp.end('lose');
}

export function installCoop() {
  net.on('msg', onMsg);
  net.on('room', onRoom);
  net.on('left', onLeft);
  net.on('error', (m) => G.lobby.note(m));
  net.on('status', () => G.lobby.render());
  // dead: Mouse 1 watches the next teammate (CS2's spectator)
  document.addEventListener('mousedown', (ev) => { if (ev.button === 0 && S.locked && S.run?.spectating) S.mp?.spectateNext(); });
  // a hidden (or throttled) tab gets few or no animation frames: keep the round's clock and messages going anyway
  setInterval(() => {
    const now = performance.now();
    if (S.mp && now - lastFrameAt > 150) { G.simulate(now); S.mp?.pump(now); }
  }, 100);
  log('co-op: ready');
}
