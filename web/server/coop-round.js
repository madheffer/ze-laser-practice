// One co-op / versus round, run by the server. No player decides anything for anyone else:
//   - the server picks the seed and hands out the room's rules, so every client runs the same simulation;
//   - it keeps the round clock (clients pull their clock onto it) and stamps deaths itself;
//   - boss damage goes through it: each player's hits (and the team fire of one designated player, the
//     "leader") are capped to what a gun can do, summed, and sent back to everyone, who all apply the same hits;
//   - it decides the end: co-op = the survivors win when the stage clears (alone if they're the last one alive),
//     all dead = wiped; versus = the last one alive wins. A stage clear / fail is what the map's logic says on the
//     clients: the server takes it when every connected player's map says so, or most of them within 3 s.
// Players only ever talk to the server, so nobody learns anyone else's address.
import { cleanText } from '../src/lib/room-rules.js';

const COUNTDOWN = 3; // s: a round's run waits this long before the stage starts (app/session.js startAt)
const TICK = 1 / 64;
const CLOCK_MS = 250, BOSS_MS = 100, VOTE_MS = 3000;
const MAX_HIT_DMG = 250; // the knife's back-stab is the biggest single hit
const PERSONAL_HITS = 12; // per second, before the boss-HP scale (AK-47: 10 rounds/s)
const TEAM_HITS_PER_HUMAN = 12; // per second per simulated human, before the scale (the squad lands ~7)

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const vec = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => num(x, -1e6, 1e6));

export class Round {
  // room: { members: [client], owner }, io: { send(client, msg) }
  constructor(room, { map, stage, mode, kind, rules }, io) {
    this.room = room;
    this.io = io;
    this.r = (Math.floor(Math.random() * 0x7ffffffe) + 1);
    this.seed = Math.floor(Math.random() * 0xfffe) + 1;
    this.map = map; this.stage = stage; this.mode = mode; this.kind = kind; this.rules = rules;
    this.t0 = Date.now();
    this.countdown = stage.fastForward ? 0 : COUNTDOWN; // a fast-forwarded stage starts at once
    this.players = new Map(room.members.map((c) => [c.id, { id: c.id, name: c.name, alive: true, deadAt: null, hits: 0, budget: { at: 0, n: 0 } }]));
    this.dmg = new Map(); // "id:dmg" -> count, sent every BOSS_MS
    this.votes = new Map(); this.voteBy = 0;
    this.clockAt = 0; this.bossAt = 0;
    this.ended = false;
    this.leader = this.pickLeader();
  }

  get elapsed() { return (Date.now() - this.t0) / 1000; }
  get stageTime() { return Math.max(0, this.elapsed - this.countdown); }
  get alive() { return [...this.players.values()].filter((p) => p.alive); }
  broadcast(msg, except) { for (const c of this.room.members) if (c !== except && this.players.has(c.id)) this.io.send(c, msg); }

  startMessage() {
    return {
      t: 'start', r: this.r, seed: this.seed, map: this.map, stage: this.stage.id, mode: this.mode, kind: this.kind,
      rules: this.rules, leader: this.leader, roster: [...this.players.values()].map((p) => ({ id: p.id, name: p.name })),
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
  onState(c, m) {
    const p = this.players.get(c.id);
    if (!p || this.ended || !num(m.at, 0, 1e6) || !vec(m.o) || !num(m.yaw, -1e4, 1e4) || !num(m.pitch, -90, 90) || !num(m.duck, 0, 1)) return;
    if (num(m.hits, 0, 1e6)) p.hits = Math.floor(m.hits);
    const out = { t: 's', from: c.id, r: this.r, at: m.at, o: m.o, yaw: m.yaw, pitch: m.pitch, duck: m.duck, hp: num(m.hp, 0, 1e6) ? Math.round(m.hp) : 0 };
    this.broadcast(out, c);
  }

  onDead(c, m) {
    const p = this.players.get(c.id);
    if (!p || !p.alive || this.ended) return;
    const now = this.stageTime;
    // the client's own stage time, as long as it's plausible (a death can't be in the future or long ago)
    const t = num(m.at, now - 2, now + 0.25) ? Math.min(m.at, now) : now;
    if (num(m.hits, 0, 1e6)) p.hits = Math.floor(m.hits);
    this.kill(p, cleanText(m.by, 40) || 'the map', t);
  }

  onLeave(c) {
    const p = this.players.get(c.id);
    if (!p || this.ended) return;
    if (p.alive) this.kill(p, '', this.stageTime, 'left the game');
    this.votes.delete(c.id);
    this.checkVotes();
  }

  kill(p, by, t, note) {
    p.alive = false;
    p.deadAt = t;
    this.broadcast({ t: 'dead', r: this.r, id: p.id, by, at: t, note: note || '' });
    this.updateLeader();
    this.checkEnd();
  }

  onOutcome(c, m) {
    if (this.ended || !this.players.has(c.id) || !['win', 'lose'].includes(m.result)) return;
    this.votes.set(c.id, m.result);
    if (!this.voteBy) this.voteBy = Date.now() + VOTE_MS;
    this.checkVotes();
  }

  checkVotes(timeUp = false) {
    if (this.ended || !this.votes.size) return;
    const voters = this.room.members.filter((c) => this.players.has(c.id)).map((c) => c.id);
    const tally = new Map();
    for (const id of voters) { const v = this.votes.get(id); if (v) tally.set(v, (tally.get(v) || 0) + 1); }
    for (const [result, n] of tally) {
      if (n === voters.length || (timeUp && n * 2 >= voters.length)) { this.end(result); return; }
    }
    if (timeUp) { this.votes.clear(); this.voteBy = 0; } // no agreement: the round goes on
  }

  onHit(c, m) {
    const p = this.players.get(c.id);
    if (!p || this.ended || !Array.isArray(m.h)) return;
    const team = m.team === true;
    if (team && c.id !== this.leader) return; // only the leader carries the team's fire
    if (!team && !p.alive) return; // the dead don't shoot
    const scale = Math.ceil(100 / Math.max(1, this.rules.bossHp));
    const perSec = (team ? TEAM_HITS_PER_HUMAN * Math.max(0, this.rules.humans - 1) : PERSONAL_HITS) * scale;
    const b = team ? (p.teamBudget ||= { at: 0, n: 0 }) : p.budget;
    const now = Date.now();
    if (now - b.at > 1000) { b.at = now; b.n = 0; }
    for (const h of m.h.slice(0, 32)) {
      if (!Array.isArray(h) || !Number.isInteger(h[0]) || h[0] < 1 || !num(h[1], 0, MAX_HIT_DMG) || !Number.isInteger(h[2]) || h[2] < 1) continue;
      const n = Math.min(h[2], perSec - b.n);
      if (n <= 0) break; // over budget: dropped
      b.n += n;
      const k = `${h[0]}:${h[1]}`;
      this.dmg.set(k, (this.dmg.get(k) || 0) + n);
    }
  }

  // ---- every 100 ms
  tick(now) {
    if (this.ended) return;
    if (now - this.bossAt >= BOSS_MS && this.dmg.size) {
      this.bossAt = now;
      const h = [...this.dmg].map(([k, n]) => { const [id, dmg] = k.split(':').map(Number); return [id, dmg, n]; });
      this.dmg.clear();
      this.broadcast({ t: 'bd', r: this.r, h });
    }
    if (now - this.clockAt >= CLOCK_MS) { this.clockAt = now; this.broadcast({ t: 'clock', r: this.r, at: this.elapsed }); }
    if (this.voteBy && now >= this.voteBy) this.checkVotes(true);
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
    let winners = [];
    if (reason === 'win') {
      winners = alive;
      if (versus && alive.length > 1) { const best = Math.min(...alive.map((p) => p.hits)); winners = alive.filter((p) => p.hits === best); }
    } else if (reason === 'last' && alive.length) winners = alive;
    else if (reason === 'last' || (reason === 'wiped' && (endless || versus))) {
      const longest = Math.max(...all.map((p) => p.deadAt ?? 0)); // everyone is down: who lasted longest
      winners = all.filter((p) => (p.deadAt ?? 0) >= longest - TICK);
    } else if (reason === 'lose' && versus) winners = alive;
    const result = versus ? (winners.length === 1 ? 'win' : 'draw')
      : reason === 'win' ? 'win' : reason === 'wiped' && endless ? 'over' : 'lose';
    const t = this.stageTime;
    this.ended = true;
    this.result = { t: 'end', r: this.r, result, reason, at: t, winners: winners.map((p) => p.id),
      stats: all.map((p) => ({ id: p.id, alive: p.alive, at: p.deadAt == null ? null : Math.min(p.deadAt, t), hits: p.hits })) };
    this.broadcast(this.result);
  }
}
