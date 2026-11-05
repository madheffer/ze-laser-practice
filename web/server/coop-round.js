// One co-op / versus round, run by the server. No player decides anything for anyone else, not even for themself:
//   - the server picks the seed and hands out the room's rules, so every client runs the same simulation;
//   - it keeps the round clock (clients pull their clock onto it);
//   - it runs its own copy of every player's run (coop-check.js, the anti-cheat): HP, deaths, the stage's win /
//     lose and cheat flags come from that copy, fed by the per-tick positions each client sends;
//   - boss damage goes through it: each hit is checked against the weapon and line of sight, the team's fire
//     (one designated client, the "leader") is capped per human, and the sum goes back to every client;
//   - it decides the end: co-op = the survivors win when the stage clears (alone if they're the last one alive),
//     all dead = wiped; versus = the last one alive wins.
// Players only ever talk to the server, so nobody learns anyone else's address.
import { cleanText, healHolders } from '../src/lib/room-rules.js';
import { TICK } from '../src/world/run-engine.js';
import { PlayerCheck } from './coop-check.js';

const COUNTDOWN = 3; // s: a round's run waits this long before the stage starts (app/session.js startAt)
const CLOCK_MS = 250, BOSS_MS = 100;
const BD_DELAY_TICKS = 3; // boss damage reaches clients about this late
const MAX_SAMPLES = 160; // per state message (2.5 s of ticks, for a tab catching up)
const TEAM_HITS_PER_HUMAN = 12; // per second per simulated human, before the boss-HP scale (the squad lands ~7)

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export class Round {
  // room: { members: [client], owner }; stage: scenarios.js's; assets: map-store's; io: { send(client, msg), log }
  constructor(room, { map, stage, mode, kind, rules, assets }, io) {
    this.room = room;
    this.io = io;
    this.r = Math.floor(Math.random() * 0x7ffffffe) + 1;
    this.seed = Math.floor(Math.random() * 0xfffe) + 1;
    this.map = map; this.stage = stage; this.mode = mode; this.kind = kind; this.rules = rules;
    this.t0 = Date.now();
    this.countdown = stage.fastForward ? 0 : COUNTDOWN;
    this.dmg = new Map();
    this.clockAt = 0; this.bossAt = 0;
    this.ended = false;
    this.players = new Map(room.members.map((c) => [c.id, { id: c.id, name: c.name, steamId: c.user?.steamId || null, alive: true, deadAt: null, cheat: '', budget: { at: 0, n: 0 } }]));
    // who starts holding the map's heal: the room's choice against who is in this round
    this.holders = assets.heals.length ? healHolders(rules.heal, [...this.players.keys()], this.seed) : [];
    for (const p of this.players.values()) {
      p.check = new PlayerCheck({
        assets, scenario: stage.full, mode, seed: this.seed, rules, items: this.holders.includes(p.id) ? assets.heals : [],
        onDeath: (cause, t) => this.kill(p, cause, t),
        onOutcome: (result) => { if (!p.cheat) this.end(result === 'win' ? 'win' : 'lose'); },
        onCheat: (kind) => { p.cheat = kind; this.kill(p, '', p.check.stageTime, `was removed by the anti-cheat (${kind})`); },
        log: (m) => io.log?.(`round ${this.r} player ${p.id}: ${m}`),
      });
    }
    this.leader = this.pickLeader();
  }

  get elapsed() { return (Date.now() - this.t0) / 1000; }
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

  // ---- from players
  // { k: first tick, p: [[x, y, z, ducked], ...], yaw, pitch }: checked, then the newest relayed to the others
  onState(c, m) {
    const p = this.players.get(c.id);
    if (!p || !p.alive || this.ended || !Number.isInteger(m.k) || m.k < 1 || !Array.isArray(m.p) || !m.p.length || m.p.length > MAX_SAMPLES) return;
    p.check.feed(m.k, m.p, this.roundTick);
    if (!p.alive || this.ended) return;
    const last = p.check.pos;
    this.broadcast({
      t: 's', from: c.id, r: this.r, at: p.check.ticks * TICK, o: last,
      yaw: num(m.yaw, -1e4, 1e4) ? m.yaw : 0, pitch: num(m.pitch, -90, 90) ? m.pitch : 0, duck: p.check.ducked ? 1 : 0, hp: Math.max(0, Math.round(p.check.hp)),
    }, c);
  }

  // the client says it died (giving up early is allowed; the server's copy kills the cheaters who don't say)
  onDead(c, m) {
    const p = this.players.get(c.id);
    if (!p || !p.alive || this.ended) return;
    p.check.alive = false;
    this.kill(p, cleanText(m.by, 40) || 'the map', p.check.stageTime);
  }

  onLeave(c) {
    const p = this.players.get(c.id);
    if (!p || this.ended) return;
    if (p.alive) { p.check.alive = false; this.kill(p, '', p.check.stageTime, 'left the game'); }
  }

  kill(p, by, t, note) {
    if (!p.alive || this.ended) return;
    p.alive = false;
    p.check.alive = false;
    p.deadAt = Math.min(t, this.stageTime);
    this.broadcast({ t: 'dead', r: this.r, id: p.id, by, at: p.deadAt, note: note || '' });
    this.updateLeader();
    this.checkEnd();
  }

  onHit(c, m) {
    const p = this.players.get(c.id);
    if (!p || this.ended || !Array.isArray(m.h)) return;
    const hits = m.h.slice(0, 32).filter((h) => Array.isArray(h) && Number.isInteger(h[0]) && h[0] > 0 && num(h[1], 1, 1000) && Number.isInteger(h[2]) && h[2] > 0 && h[2] < 10000);
    const mult = Math.max(1, Math.round(100 / Math.max(1, this.rules.bossHp)));
    if (m.team === true) {
      if (c.id !== this.leader) return; // only the leader carries the team's fire
      const perSec = TEAM_HITS_PER_HUMAN * Math.max(0, this.rules.humans - 1) * mult;
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
    if (!p?.alive || this.ended || !this.holders.includes(c.id)) return;
    p.check.use(m.k);
    this.broadcast({ t: 'use', r: this.r, id: c.id }, c);
  }

  onReload(c) { const p = this.players.get(c.id); if (p?.alive && !this.ended) p.check.reload(); }

  // team = the simulated team's fire: its bullets carry the team (engine.teamEnt) as activator, not a player
  addDamage(id, dmg, n, team = false) { const k = `${id}:${dmg}:${team ? 1 : 0}`; this.dmg.set(k, (this.dmg.get(k) || 0) + n); }

  // ---- every 100 ms
  tick(now) {
    if (this.ended) return;
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
    if (this.kind === 'versus' && this.players.size >= 2) { if (a <= 1) this.end('last'); } else if (a === 0) this.end('wiped');
  }

  end(reason) {
    if (this.ended) return;
    const all = [...this.players.values()];
    const alive = all.filter((p) => p.alive);
    const versus = this.kind === 'versus' && all.length >= 2;
    const endless = this.mode === 'endless';
    const hits = (p) => p.check.hits;
    let winners = [];
    if (reason === 'win') {
      winners = alive;
      if (versus && alive.length > 1) { const best = Math.min(...alive.map(hits)); winners = alive.filter((p) => hits(p) === best); }
    } else if (reason === 'last' && alive.length) winners = alive;
    else if (reason === 'last' || (reason === 'wiped' && (endless || versus))) {
      // everyone is down: whoever lasted longest (within a tick = a draw); the anti-cheat's removals don't count
      const fair = all.filter((p) => !p.cheat);
      const longest = Math.max(0, ...fair.map((p) => p.deadAt ?? 0));
      winners = fair.filter((p) => (p.deadAt ?? 0) >= longest - TICK);
    } else if (reason === 'lose' && versus) winners = alive;
    const result = versus ? (winners.length === 1 ? 'win' : 'draw')
      : reason === 'win' ? 'win' : reason === 'wiped' && endless ? 'over' : 'lose';
    const t = this.stageTime;
    this.ended = true;
    this.result = { t: 'end', r: this.r, result, reason, at: t, winners: winners.map((p) => p.id),
      stats: all.map((p) => ({ id: p.id, alive: p.alive, at: p.deadAt == null ? null : Math.min(p.deadAt, t), hits: hits(p), cheat: p.cheat || undefined })) };
    this.broadcast(this.result);
    // the copies are done: free their engines
    for (const p of all) p.check = { hits: p.check.hits, alive: false, stageTime: p.check.stageTime, behind: () => false, queueBossDamage() {}, feed() {}, checkHits: () => [] };
  }
}
