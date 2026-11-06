// One multiplayer round, run by the server. No player decides anything for anyone else, not even for themself:
//   - the server picks the seed and hands out the room's rules, so every client runs the same simulation;
//   - it keeps the round clock (clients pull their clock onto it);
//   - it runs its own copy of every player's run (coop-check.js, the anti-cheat): HP, deaths, the stage's win /
//     lose and cheat flags come from that copy, fed by the per-tick positions each client sends;
//   - boss damage goes through it: each hit is checked against the weapon and line of sight, the team's fire
//     (one designated client, the "leader") is capped per human, and the sum goes back to every client;
//   - it decides the end and who did best (end): the survivors win when the stage clears (the last one alive plays
//     on alone), fewest hits is the best run; all down, whoever lasted longest.
// Players only ever talk to the server, so nobody learns anyone else's address.
import { cleanText, healHolders, bossHumans } from '../src/lib/room-rules.js';
import { TICK, COUNTDOWN } from '../src/world/run-engine.js'; // COUNTDOWN: s a round's run waits before the stage starts
import { PlayerCheck, MAX_PING } from './coop-check.js';

// The round's clock starts only when every player has loaded the stage and drawn it (their 'ready'), so a slow
// device (a phone streaming the world) never meets the lasers on a black screen. Who holds the rest up for too long
// is left out (tick): once at least half of the players are ready, the others get a grace period of
// max(GRACE_MIN_MS, half the time the slowest ready player took), counted from that moment; one whose reported progress
// ('load') hasn't moved for STALL_MS within it is dropped at once; and nobody waits past LOAD_CAP_MS from the start.
// A dropped player is out of the round (dead, 'could not load in time') and watches once their stage is drawn.
const LOAD_CAP_MS = 60_000; // the most anyone waits, however few are ready: the round then goes on without the rest
const GRACE_MIN_MS = 15_000;
const STALL_MS = 10_000;
const WAIT_MS = 500; // the loading roster ('wait': who is ready, everyone's progress) goes out at most this often
const CLOCK_MS = 250, BOSS_MS = 100;
const BD_DELAY_TICKS = 3; // boss damage reaches clients about this late
const MAX_SAMPLES = 160; // per state message (2.5 s of ticks, for a tab catching up)
const RELAY_TICKS = 8; // a state message's ticks relayed to the others (a 30 Hz batch holds 2-3)
const TEAM_HITS_PER_HUMAN = 12; // per second per simulated human, before the boss-HP scale (the squad lands ~7)

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export class Round {
  // room: { members: [client], owner }; stage: scenarios.js's; assets: map-store's; io: { send(client, msg), log }
  constructor(room, { map, stage, mode, kind, rules, assets }, io) {
    this.room = room;
    this.io = io;
    this.r = Math.floor(Math.random() * 0x7ffffffe) + 1;
    this.seed = Math.floor(Math.random() * 0xfffe) + 1;
    // the boss HP's humans, fixed for the round from who starts it (lib/room-rules.js bossHumans): every client and
    // every server copy runs the map at this count, and a death doesn't lower it
    rules = { ...rules, humans: bossHumans(rules, room.members.length) };
    this.map = map; this.stage = stage; this.mode = mode; this.kind = kind; this.rules = rules;
    this.t0 = null; // set by go(): until then the round is loading and its clock stands at 0
    this.ready = new Set();
    this.loadT0 = Date.now();
    this.halfAt = null; // when half of the players were first ready (the stragglers' grace starts)
    this.waitAt = 0; this.waitDirty = false;
    this.countdown = COUNTDOWN; // a mid-map stage too: it holds still through it (world/run-engine.js)
    this.dmg = new Map();
    this.clockAt = 0; this.bossAt = 0;
    this.ended = false;
    this.players = new Map(room.members.map((c) => [c.id, { id: c.id, name: c.name, steamId: c.user?.steamId || null, alive: true, deadAt: null, cheat: '', budget: { at: 0, n: 0 },
      load: 0, loadAt: Date.now(), readyMs: null, left: false, ping: 0 }])); // left: gone or never loaded (out, not beaten)
    // who starts holding the map's heal: the room's choice against who is in this round
    this.holders = assets.heals.length ? healHolders(rules.heal, [...this.players.keys()], this.seed) : [];
    for (const p of this.players.values()) {
      p.check = new PlayerCheck({
        assets, scenario: stage.full, mode, seed: this.seed, rules, items: this.holders.includes(p.id) ? assets.heals : [],
        onDeath: (cause, t) => this.kill(p, cause, t),
        onOutcome: (result) => { if (!p.cheat) this.end(result === 'win' ? 'win' : 'lose'); },
        onCheat: (kind) => { p.cheat = kind; this.kill(p, '', p.check.stageTime, `was removed by the anti-cheat (${kind})`); },
        // sent to the stage's holding pen (scenario loseTo): still in the round, out of the play (checkEnd)
        onPenned: () => this.checkEnd(),
        log: (m) => io.log?.(`round ${this.r} player ${p.id}: ${m}`),
      });
    }
    this.leader = this.pickLeader();
  }

  get elapsed() { return this.t0 == null ? 0 : (Date.now() - this.t0) / 1000; }
  get started() { return this.t0 != null; }
  get roundTick() { return Math.floor(this.elapsed / TICK); }
  get stageTime() { return Math.max(0, this.elapsed - this.countdown); }
  get alive() { return [...this.players.values()].filter((p) => p.alive); }
  broadcast(msg, except) { for (const c of this.room.members) if (c !== except && this.players.has(c.id)) this.io.send(c, msg); }

  startMessage() {
    return {
      t: 'start', r: this.r, seed: this.seed, map: this.map, stage: this.stage.id, mode: this.mode, kind: this.kind,
      rules: this.rules, leader: this.leader, holders: this.holders, roster: [...this.players.values()].map((p) => ({ id: p.id, name: p.name })),
    };
  }

  // the team's fire runs on one client: the owner while alive, else the first player alive
  pickLeader() {
    const alive = this.alive;
    if (alive.some((p) => p.id === this.room.owner)) return this.room.owner;
    return alive[0]?.id ?? 0;
  }
  updateLeader() {
    const id = this.pickLeader();
    if (id !== this.leader) { this.leader = id; this.broadcast({ t: 'leader', r: this.r, id }); }
  }

  // ---- loading: every player says when its stage is loaded and drawn; the clock starts when all have
  onReady(c, m = {}) {
    const p = this.players.get(c.id);
    if (this.started || this.ended || !p?.alive || this.ready.has(c.id)) return;
    this.setPing(p, m.ping);
    this.ready.add(c.id);
    p.load = 1; p.readyMs = Date.now() - this.loadT0;
    this.sendWait();
    this.maybeGo();
  }

  // { p: 0..1 }: how far this player's load is (untrusted: a number, clamped, only ever up)
  onLoad(c, m) {
    const p = this.players.get(c.id);
    if (this.started || this.ended || !p?.alive || this.ready.has(c.id)) return;
    this.setPing(p, m.ping);
    const n = Number(m.p);
    if (typeof m.p !== 'number' || !Number.isFinite(n)) return;
    const v = Math.min(0.99, Math.max(0, n));
    if (v <= p.load + 0.005) return;
    p.load = v; p.loadAt = Date.now();
    this.waitDirty = true;
  }

  // the player's simulated ping (ms, their own setting): untrusted, so an integer clamped to 0..MAX_PING, and only
  // taken while the round loads, so nobody changes it mid-round. It widens that player's own checks only
  // (coop-check.js MAX_PING): the round clock, the boss damage schedule and the other players' copies never see it.
  setPing(p, ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
    p.ping = Math.max(0, Math.min(MAX_PING, Math.round(ms)));
    p.check.setPing(p.ping);
  }

  // who is ready and everyone's progress (percent): the loading screens' roster
  sendWait() {
    this.waitAt = Date.now(); this.waitDirty = false;
    this.broadcast({ t: 'wait', r: this.r, ready: [...this.ready], load: [...this.players.values()].map((p) => [p.id, Math.round(p.load * 100)]) });
  }

  // before go (every 100 ms): the roster, and the stragglers left out by the rule at the top
  loadTick(now) {
    if (this.waitDirty && now - this.waitAt >= WAIT_MS) this.sendWait();
    const alive = this.alive;
    const ready = alive.filter((p) => this.ready.has(p.id));
    const late = alive.filter((p) => !this.ready.has(p.id));
    if (!late.length) { this.maybeGo(); return; }
    let drop = [];
    if (now - this.loadT0 >= LOAD_CAP_MS) drop = late;
    else if (ready.length && ready.length * 2 >= alive.length) {
      this.halfAt ??= now;
      const grace = Math.max(GRACE_MIN_MS, Math.max(...ready.map((p) => p.readyMs)) / 2);
      drop = now - this.halfAt >= grace ? late : late.filter((p) => now - Math.max(p.loadAt, this.halfAt) >= STALL_MS);
    }
    for (const p of drop) { p.left = true; this.kill(p, '', 0, 'could not load in time'); }
    if (drop.length) { this.sendWait(); this.maybeGo(); }
  }

  maybeGo() {
    if (this.started || this.ended) return;
    const waiting = [...this.players.values()].filter((p) => p.alive && !this.ready.has(p.id));
    if (waiting.length) return;
    this.go();
  }

  go() {
    this.t0 = Date.now();
    this.clockAt = 0;
    this.broadcast({ t: 'go', r: this.r });
    this.ev('round.go', { loadMs: this.t0 - this.loadT0, playing: this.alive.map((p) => `#${p.id}`), out: [...this.players.values()].filter((p) => !p.alive).map((p) => `#${p.id}`) });
  }

  // the event log (coop-log.js), with the room and round on every line
  ev(event, fields) { this.io.ev?.(event, { room: this.room.code, r: this.r, ...fields }); }

  // ---- from players
  // { k: first tick, p: [[x, y, z, ducked], ...], yaw, pitch }: checked, then the newest relayed to the others
  onState(c, m) {
    const p = this.players.get(c.id);
    if (!p || !p.alive || this.ended || !this.started || !Number.isInteger(m.k) || m.k < 1 || !Array.isArray(m.p) || !m.p.length || m.p.length > MAX_SAMPLES) return;
    p.check.feed(m.k, m.p, this.roundTick);
    if (!p.alive || this.ended) return;
    const last = p.check.pos;
    // tr: the batch's own ticks (its last RELAY_TICKS), so the others draw every tick of the movement, not one
    // position per batch (world/peers.js); the newest is the server copy's, the one it checked
    const ok = (s) => Array.isArray(s) && s.length >= 4 && [s[0], s[1], s[2]].every((v) => num(v, -1e6, 1e6));
    const tr = m.p.slice(-RELAY_TICKS, -1).filter(ok).map((s) => [s[0], s[1], s[2], s[3] ? 1 : 0]);
    tr.push([last[0], last[1], last[2], p.check.ducked ? 1 : 0]);
    this.broadcast({
      t: 's', from: c.id, r: this.r, at: p.check.ticks * TICK, o: last, tr,
      yaw: num(m.yaw, -1e4, 1e4) ? m.yaw : 0, pitch: num(m.pitch, -90, 90) ? m.pitch : 0, duck: p.check.ducked ? 1 : 0, hp: Math.max(0, Math.round(p.check.hp)),
    }, c);
  }

  // the client says it died (giving up early is allowed; the server's copy kills the cheaters who don't say)
  onDead(c, m) {
    const p = this.players.get(c.id);
    if (!p || !p.alive || this.ended || !this.started) return;
    p.check.alive = false;
    this.kill(p, cleanText(m.by, 40) || 'the map', p.check.stageTime);
  }

  onLeave(c) {
    const p = this.players.get(c.id);
    if (!p || this.ended) return;
    // out of the round, not beaten: the others play on (checkEnd), and nobody waits for them to load
    if (p.alive) { p.left = true; p.check.alive = false; this.kill(p, '', p.check.stageTime, 'left the game'); }
    if (!this.started && !this.ended) { this.sendWait(); this.maybeGo(); }
  }

  kill(p, by, t, note) {
    if (!p.alive || this.ended) return;
    p.alive = false;
    p.check.alive = false;
    p.deadAt = Math.min(t, this.stageTime);
    this.broadcast({ t: 'dead', r: this.r, id: p.id, by, at: p.deadAt, note: note || '' });
    this.ev('round.dead', { id: `#${p.id}`, name: p.name, by: by || undefined, note: note || undefined, at: p.deadAt, started: this.started, alive: this.alive.length });
    this.updateLeader();
    this.checkEnd();
  }

  onHit(c, m) {
    const p = this.players.get(c.id);
    if (!p || this.ended || !this.started || !Array.isArray(m.h)) return;
    const hits = m.h.slice(0, 32).filter((h) => Array.isArray(h) && Number.isInteger(h[0]) && h[0] > 0 && num(h[1], 1, 1000) && Number.isInteger(h[2]) && h[2] > 0 && h[2] < 10000);
    const mult = Math.max(1, Math.round(100 / Math.max(1, this.rules.bossHp)));
    if (m.team === true) {
      if (c.id !== this.leader) return; // only the leader carries the team's fire
      // the simulated team: the humans the boss is scaled for that aren't players in the round
      const perSec = TEAM_HITS_PER_HUMAN * Math.max(0, this.rules.humans - this.players.size) * mult;
      const b = p.budget, now = Date.now();
      if (now - b.at > 1000) { b.at = now; b.n = 0; }
      for (const h of hits) {
        const n = Math.min(h[2], perSec - b.n);
        if (n <= 0) break;
        b.n += n;
        this.addDamage(h[0], h[1], n, true);
      }
      return;
    }
    if (!p.alive) return; // the dead don't shoot
    for (const [id, dmg, n] of p.check.checkHits(hits, mult)) this.addDamage(id, dmg, n);
  }

  // an item press: checked on the presser's copy, and shown on everyone's item HUD
  onUse(c, m) {
    const p = this.players.get(c.id);
    if (!p?.alive || this.ended || !this.started || !this.holders.includes(c.id)) return;
    p.check.use(m.k);
    this.broadcast({ t: 'use', r: this.r, id: c.id }, c);
  }

  onReload(c, w) { const p = this.players.get(c.id); if (p?.alive && !this.ended && this.started) p.check.reload(w === 'pistol' ? 'pistol' : 'gun'); }
  // a bought gun (app/buy.js): any of lib/weapons.js GUNS, held to its numbers (PlayerCheck.setGun drops the rest)
  onWeapon(c, gun) { const p = this.players.get(c.id); if (p?.alive && !this.ended) p.check.setGun?.(gun); }

  // team = the simulated team's fire: its bullets carry the team (engine.teamEnt) as activator, not a player
  addDamage(id, dmg, n, team = false) { const k = `${id}:${dmg}:${team ? 1 : 0}`; this.dmg.set(k, (this.dmg.get(k) || 0) + n); }

  // ---- every 100 ms
  tick(now) {
    if (this.ended) return;
    if (!this.started) { this.loadTick(Date.now()); return; } // still loading
    const rt = this.roundTick;
    if (now - this.bossAt >= BOSS_MS && this.dmg.size) {
      this.bossAt = now;
      const h = [...this.dmg].map(([k, n]) => { const [id, dmg, team] = k.split(':').map(Number); return [id, dmg, n, team]; });
      this.dmg.clear();
      this.broadcast({ t: 'bd', r: this.r, h });
      for (const p of this.players.values()) p.check.queueBossDamage(rt + BD_DELAY_TICKS, h);
    }
    if (now - this.clockAt >= CLOCK_MS) { this.clockAt = now; this.broadcast({ t: 'clock', r: this.r, at: this.elapsed }); }
    // a run that falls far behind the round (a frozen tab, or slowed down on purpose) is out
    for (const p of this.players.values()) if (p.check.behind(rt)) this.kill(p, '', p.check.stageTime, 'fell behind the round');
  }

  checkEnd() {
    if (this.ended) return;
    const a = this.alive.length;
    // the last one standing plays on until they clear the stage (end('win') from their run) or go down too
    if (a === 0) this.end('wiped');
    // everyone still alive is in the holding pen the map keeps the humans it took out (scenario loseTo): nobody can
    // finish the stage any more, so it is lost; a stage that clears first carries the penned on with it (end('win'))
    else if (this.alive.every((p) => p.check.penned)) this.end('lose');
  }

  // One mode for every room: the stage is everyone's, and everyone is up against each other on it.
  //   cleared ('win')  everyone still alive cleared it (winners); best = the survivors with the fewest hits
  //   all down         nobody did (endless: the run is over); best = whoever lasted longest (within a tick: a tie)
  //   failed ('lose')  the stage was lost with players alive; best = the survivors with the fewest hits
  // The anti-cheat's removals and players who left never count as best.
  // why: for the log only (the owner's End round)
  end(reason, why) {
    if (this.ended) return;
    const all = [...this.players.values()];
    const alive = all.filter((p) => p.alive);
    const fair = (list) => list.filter((p) => !p.cheat && !p.left);
    const hits = (p) => p.check.hits;
    const fewestHits = (list) => { const f = fair(list); const m = Math.min(...f.map(hits)); return f.filter((p) => hits(p) === m); };
    let winners = [], best;
    if (reason === 'win') { winners = alive; best = fewestHits(alive); }
    else if (reason === 'lose') best = fewestHits(alive);
    else {
      const f = fair(all);
      const longest = Math.max(0, ...f.map((p) => p.deadAt ?? 0));
      best = f.filter((p) => (p.deadAt ?? 0) >= longest - TICK);
    }
    const result = reason === 'win' ? 'win' : reason === 'wiped' && this.mode === 'endless' ? 'over' : 'lose';
    const t = this.stageTime;
    this.ended = true;
    this.result = { t: 'end', r: this.r, result, reason, at: t, winners: winners.map((p) => p.id), best: all.length > 1 ? best.map((p) => p.id) : [],
      stats: all.map((p) => ({ id: p.id, alive: p.alive, at: p.deadAt == null ? null : Math.min(p.deadAt, t), hits: hits(p), cheat: p.cheat || undefined })) };
    this.broadcast(this.result);
    this.ev('round.end', { result, reason, why, at: t, sentTo: this.room.members.filter((c) => this.players.has(c.id)).length,
      players: all.map((p) => `#${p.id}:${p.alive ? 'alive' : 'dead'}:${hits(p)}h${p.cheat ? `:cheat-${p.cheat}` : ''}${p.left ? ':left' : ''}`) });
    this.free();
  }

  // replaced by a new round (the owner restarted, or a new owner started one): over without a verdict. Its players
  // are already loading the new one, so nothing is sent (an 'end' would put up an end card and drop their mouse lock)
  close() {
    if (this.ended) return;
    this.ended = true;
    this.fed = true; // no verdict, so nothing for the home page's feed
    this.ev('round.replaced', { at: this.stageTime });
    this.free();
  }

  // the copies are done: free their engines
  free() {
    for (const p of this.players.values()) p.check.dispose?.();
    for (const p of this.players.values()) p.check = { hits: p.check.hits, alive: false, stageTime: p.check.stageTime, behind: () => false, queueBossDamage() {}, feed() {}, checkHits: () => [] };
  }
}
