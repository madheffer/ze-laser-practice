// The server's copy of ONE player's run: the anti-cheat. Each client sends where its player stood on every tick;
// the server replays the map's own logic (world/run-engine.js, the browser's engine and setup) with that player in
// it, exactly as the player's own client does, and from that it alone decides:
//   - HP and death: the map's trigger_hurt / heal / teleport touches on the server's copy (client god mode, or a
//     client that never reports its death, changes nothing). God mode only if the ROOM has it on.
//   - movement: a position inside the world or a move through it (noclip), faster than CS2's sv_maxvelocity
//     (speed hacks), rising or hovering in the air with no jump / push (fly), a start away from the spawn, a
//     map teleport that didn't land where the map sends you;
//   - the clock: ticks from the future are refused; a run that falls far behind the round is out (slow-motion);
//   - shots: each boss hit must fit the gun held (lib/weapons.js: its damage, magazine, m_flCycleTime and reload;
//     every stage starts with the PP-Bizon, 'weapon' messages switch it) or the knife (its swing rate and reach),
//     and have a clear line from the player's eye to the boss.
//   - the stage's own win / lose (the map's win input or winAfter), instead of trusting a client.
// Violations are counted per kind; a few within two seconds and the player is out of the round.
import { createRunEngine, hazardName, TICK, COUNTDOWN, startIfDue, mapRuns, winDue, sentOut } from '../src/world/run-engine.js';
import { useItems } from '../src/world/items.js';
import { CollisionWorld, makeTrace } from '../src/world/collision.js';
import { bulletWorld, BULLET_MASK } from '../src/world/bullets.js';
import { waterQuery } from '../src/world/water-volumes.js';
import { CS, standsFree } from '../src/world/movement.js';
import { GUNS, PISTOLS, KNIFE, DEFAULT_GUN, DEFAULT_PISTOL } from '../src/lib/weapons.js';

const MAX_AXIS_SPEED = 3500 * 1.05; // CS2 clamps each velocity axis to sv_maxvelocity 3500
const BOOST_TICKS = 32; // after a push / map velocity: half a second of extra speed allowance, no fly check
const STRIKES = 3, STRIKE_WINDOW = 128; // this many of one kind within 2 s = out
const AIR_WINDOW = 24; // ticks in the air before the fly check judges
const BEHIND_LIMIT = 3 * 64; // ticks a run may trail the round clock
const AHEAD_LIMIT = 32; // ticks a run may lead it (jitter)
const SPAWN_SLACK = 96; // units: the first tick has to be this close to the spawn
const TELEPORT_SLACK = 96; // units: the tick after a map teleport, this close to its destination
const KNIFE_REACH = 32; // units added to a knife's range (hull / latency)
const KNIFE_DAMAGE = [KNIFE.slash.first, KNIFE.slash.follow, KNIFE.stab.damage];
const BURST = 6; // rounds that may arrive at once (network jitter bunches a few 100 ms batches)
const SWAP_GRACE = 1500; // ms the gun held before a buy still counts (its last rounds' hits trail the message)
const RELOAD_SLACK = 0.3; // s off a reported reload (the report travels; the last rounds' hits may trail it)
// A player's simulated ping (their own setting, 0-500 ms, sent with 'load' / 'ready': server/coop-round.js) is theirs
// alone: it never touches the round clock, the boss damage schedule (coop-round.js BD_DELAY_TICKS: the same tick on
// every copy, so the boss has one HP for everyone) or another player's copy. It widens two of this player's checks:
//   - behind(): the run may trail the round clock by its ping too, on top of BEHIND_LIMIT's 3 s of real jitter;
//   - shots: their client draws the map's entities ping late (render.js delay) and aims at that, so a hit is also
//     checked against where the boss was then (lag compensation, as CS2's, at most MAX_PING back).
// AHEAD_LIMIT doesn't change (a ping only ever makes a client later), nor do the fire-rate / reload checks (they
// count shots over wall time, which a constant delay doesn't change).
export const MAX_PING = 500;

const len3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class PlayerCheck {
  // assets: map-store's; scenario: the stage's full entry (or null for free roam)
  // items: the map items this player holds from the start (a round's heal holders)
  // countdown: seconds from the spawn to the stage start (a solo replay passes the one it was recorded with)
  constructor({ assets, scenario, mode, seed, rules, items = [], countdown = COUNTDOWN, onDeath, onOutcome, onCheat, onPenned = null, log = () => {} }) {
    this.scenario = scenario;
    this.rules = rules;
    this.onDeath = onDeath; this.onOutcome = onOutcome; this.onCheat = onCheat; this.log = log;
    // a round's player the map sends to the stage's holding pen (`loseTo`) plays on from there; without a round (a solo
    // replay being verified) the pen is the end of the run
    this.onPenned = onPenned; this.penned = false;
    this.world = new CollisionWorld(assets.bvh);
    // shots: CS2's bullet trace on the map's layered static world (shared by every check), as the client's bosses.js
    this.shotWorld = bulletWorld(assets.fx, this.world);
    this.pos = [0, 0, 0]; this.yaw = 0; this.ducked = false;
    this.hp = scenario?.player?.health ?? 100; this.maxHp = this.hp;
    this.gravity = scenario?.player?.gravity ?? 1;
    this.noFall = false;
    this.alive = true; this.hits = 0; this.ticks = 0; this.t = 0;
    this.boost = 0; this.boostSpeed = 0; this.skipMove = false; this.expectAt = null;
    this.strikes = new Map(); this.flagged = '';
    this.vz = 0; this.air = []; this.wasAir = false;
    this.uses = []; // ticks after which the player pressed their map item (E)
    this.bd = []; // [{ tick, hits }] boss damage to apply when this run reaches that tick
    this.ping = 0; this.lagTicks = 0; this.past = []; // past: [{ tick, hulls: Map boss id -> hulls }], lagTicks + 1 long
    this.gun = GUNS[DEFAULT_GUN]; this.prevGun = null; this.prevUntil = 0;
    this.pistol = PISTOLS[DEFAULT_PISTOL]; // every human's slot 2 (the USP-S): its own magazine, the same fire budget
    this.shots = { tokens: BURST, rounds: this.gun.clip, reloadUntil: 0, pistolRounds: this.pistol.clip, pistolReloadUntil: 0, knife: 2, at: Date.now() };
    const me = this;
    this.stub = { centre: () => [me.pos[0], me.pos[1], me.pos[2] + me.height / 2], half: () => [CS.halfWidth, CS.halfWidth, me.height / 2] };
    this.run = createRunEngine({
      entities: assets.entities, hulls: assets.hulls, bounds: assets.bounds, animations: assets.animations, soundDurations: assets.soundDurations,
      traceBox: (s, e, h) => this.world.traceBox(s, e, h, undefined, true),
      // the client's spawn test (app/session.js): the same spot, so the spawn check below agrees
      fits: (o, solids) => standsFree(this.world, o, solids), countdown,
      scenario, mode, seed, humans: rules.humans, bossHp: rules.bossHp, items,
      hooks: {
        attach(engine) {
          engine.player = {
            setHealth: (v) => { me.hp = v; me.maxHp = Math.max(me.maxHp, v); },
            setMaxHealth: (v) => { me.maxHp = v; },
            setGravity: (g) => { me.gravity = g; },
            setSpeed: () => {},
            setVelocity: (v) => { me.boostFor(Math.hypot(...v)); },
            setDamageFilter: (name) => {
              const f = engine.findOne(name);
              me.noFall = !!f && f.cls === 'filter_damage_type' && (parseInt(f.kv.damagetype, 10) & 32) && String(f.kv.negated) === '1';
            },
          };
          engine.onTeleportPlayer = (o) => { me.skipMove = true; me.expectAt = [...o]; };
          engine.playerMatrix = () => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, me.pos[0], me.pos[1], me.pos[2], 1] });
        },
        place(spawn) { me.spawn = spawn.origin; me.pos = [...spawn.origin]; },
        win() { if (me.alive) me.onOutcome('win'); },
        lose() { if (me.alive) me.onOutcome('lose'); },
      },
    });
    this.engine = this.run.engine;
    // the map's water (world/water-volumes.js): swimming has no gravity, so the fly check leaves a swimmer alone
    this.water = waterQuery(this.engine, assets.fx);
  }

  // CS2's water mode (world/water-move.js): m_flWaterLevel >= 0.5, eyes down to the feet
  swimming(o, ducked) {
    const eye = ducked ? CS.viewDuck : CS.viewStand;
    const r = this.water.trace([o[0], o[1], o[2] + eye], o);
    return r.fraction < 1 && 1 - r.fraction >= 0.5;
  }

  // a push or a map-set velocity: that much extra speed is allowed (and gravity may be fought) for a while
  boostFor(speed) { this.boost = BOOST_TICKS; this.boostSpeed = Math.max(this.boost > 0 ? this.boostSpeed : 0, Math.abs(speed) || 0); }

  get height() { return this.ducked ? CS.duckHeight : CS.standHeight; }
  get stageTime() { return this.run.started ? this.engine.time - this.run.startTime : 0; }
  eye() { return [this.pos[0], this.pos[1], this.pos[2] + (this.ducked ? CS.viewDuck : CS.viewStand)]; }

  strike(kind, detail = '') {
    if (!this.alive || this.flagged) return;
    const list = (this.strikes.get(kind) || []).filter((k) => this.ticks - k < STRIKE_WINDOW);
    list.push(this.ticks);
    this.strikes.set(kind, list);
    if (list.length >= STRIKES) {
      this.flagged = kind;
      this.log(`anti-cheat: ${kind}${detail ? ` (${detail})` : ''} at tick ${this.ticks}`);
      this.onCheat(kind);
    }
  }

  // ---- positions: [[x, y, z, ducked 0/1], ...] for ticks k0, k0+1, ...; roundTick = the round clock's tick
  feed(k0, samples, roundTick) {
    if (!this.alive || !Number.isInteger(k0) || !Array.isArray(samples)) return;
    if (k0 + samples.length - 1 > roundTick + AHEAD_LIMIT) { this.strike('clock', `tick ${k0} ahead of ${roundTick}`); return; }
    for (let i = 0; i < samples.length && this.alive; i++) {
      const k = k0 + i;
      if (k <= this.ticks) continue; // already have it
      const s = samples[i];
      if (!Array.isArray(s) || s.length < 4 || !s.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6)) { this.strike('data'); continue; }
      while (this.ticks < k - 1 && this.alive) this.step(this.pos, this.ducked); // a gap: hold still
      if (this.alive) this.step([s[0], s[1], s[2]], s[3] === 1);
    }
  }

  // the player pressed their item after tick k (the map's own cooldown limits how often it does anything)
  use(k) { if (this.alive && Number.isInteger(k) && k >= this.ticks && this.uses.length < 8) this.uses.push(k); }

  // boss damage the round applied at round tick `tick` (every client applies it as it arrives)
  queueBossDamage(tick, hits) { this.bd.push({ tick, hits }); }

  behind(roundTick) { return this.alive && this.ticks < roundTick - BEHIND_LIMIT - this.lagTicks; }

  // ms, already checked by the round (an integer in 0..MAX_PING)
  setPing(ms) { this.ping = ms; this.lagTicks = Math.ceil(ms / 1000 / TICK); if (!ms) this.past = []; }

  // the bosses that can be shot now: the stage's boss targets, alive with health
  bosses() {
    const out = [];
    for (const b of this.scenario?.bosses || []) for (const e of this.engine.find(b.target)) if (e.alive && e.state.health != null) out.push(e);
    return out;
  }

  // with a ping: where each boss is this tick, for the shots that arrive lagTicks later
  recordPast() {
    if (!this.lagTicks || !this.scenario?.bosses?.length) return;
    const hulls = new Map();
    for (const e of this.bosses()) hulls.set(e.id, e.hulls()); // a new array whenever it moves: no copy needed
    this.past.push({ tick: this.ticks, hulls });
    while (this.past.length > this.lagTicks + 1) this.past.shift();
  }

  step(pos, ducked) {
    const { engine, run } = this;
    this.ticks++;
    this.t += TICK;
    startIfDue(run, this.t); // the countdown (world/run-engine.js), as the client's loop.js step
    // an item press between ticks k and k + 1 is queued for the next engine tick, on the client too
    while (this.uses.length && this.uses[0] < this.ticks) { this.uses.shift(); if (run.items?.length && run.started) useItems(engine, run.items); }
    if (mapRuns(run)) engine.tick(TICK); // a mid-map stage holds still through its countdown
    while (this.bd.length && this.bd[0].tick <= this.ticks) {
      for (const [id, dmg, n, team] of this.bd.shift().hits) {
        const e = engine.ents[id - 1]?.id === id ? engine.ents[id - 1] : engine.ents.find((x) => x.id === id);
        const by = team === 1 ? engine.teamEnt : engine.playerEnt; // as the client's applyBossDamage
        for (let k = 0; k < n && e?.alive; k++) engine.damage(e, dmg, by);
      }
    }
    this.world.dynamic = engine.solids();
    this.checkMove(pos, ducked);
    this.pos = pos; this.ducked = ducked;
    if (!this.alive) return;
    for (const ev of engine.updateTriggers(this.stub)) {
      if (ev.type === 'hurt' && run.started) {
        if (ev.first) this.hits++;
        if (!this.rules.god) { this.hp -= ev.damage; if (this.hp <= 0) return this.die(hazardName(ev.ent, this.scenario)); }
      } else if (ev.type === 'heal' && run.started) this.hp = Math.min(this.maxHp, this.hp + ev.amount);
      else if (ev.type === 'teleport') {
        // a human the map sends into the zombie cage is out (app/loop.js does the same)
        if (ev.cage && run.started && engine.playerEnt.team === 3 && !this.rules.god) return this.die(hazardName('cage', this.scenario));
        if (sentOut(this.scenario, ev.dest) && run.started && !this.rules.god) {
          if (!this.onPenned) return this.die(hazardName(ev.dest, this.scenario));
          if (!this.penned) { this.penned = true; this.onPenned(); }
        }
        this.skipMove = true; this.expectAt = [...ev.origin];
      } else if (ev.type === 'push') this.boostFor(ev.speed);
    }
    this.recordPast();
    if (run.started && run.endlessTick) run.endlessTick(TICK);
    if (winDue(run, this.scenario?.winAfter)) this.onOutcome('win');
  }

  die(cause) {
    if (!this.alive) return;
    this.alive = false;
    this.onDeath(cause, this.stageTime);
  }

  // ---- movement
  checkMove(to, ducked) {
    const from = this.pos;
    if (this.ticks === 1) {
      if (len3(to, this.spawn) > SPAWN_SLACK) { this.flagged = 'spawn'; this.log(`anti-cheat: spawn ${len3(to, this.spawn).toFixed(0)} u away`); this.onCheat('spawn'); }
      return;
    }
    if (this.expectAt) {
      const off = len3(to, this.expectAt);
      this.expectAt = null;
      if (off > TELEPORT_SLACK) { this.flagged = 'teleport'; this.log(`anti-cheat: teleport landed ${off.toFixed(0)} u off`); this.onCheat('teleport'); return; }
    }
    const h = (ducked ? CS.duckHeight : CS.standHeight) / 2;
    const c = [to[0], to[1], to[2] + h];
    const tr = makeTrace();
    // inside the world: a hull embedded in solid geometry (shrunk 1 u: a real position rests a hair off surfaces)
    this.world.traceBox(c, c, [CS.halfWidth - 1, CS.halfWidth - 1, h - 1], tr, true);
    if (tr.startSolid) this.strike('noclip', 'inside the world');
    // a map teleport moves you in one tick: only where you landed is checked (above)
    const teleported = this.skipMove;
    this.skipMove = false;
    const boosted = this.boost > 0;
    if (boosted) this.boost--;
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    if (!teleported) {
      // through the world: the move's core (shrunk past stair steps and ceilings) must not cross a wall
      const fh = (this.ducked ? CS.duckHeight : CS.standHeight) / 2;
      const hc = Math.min(h, fh) - 12;
      if (hc > 2 && Math.hypot(d[0], d[1], d[2]) > 1) {
        this.world.traceBox([from[0], from[1], from[2] + fh], c, [CS.halfWidth - 6, CS.halfWidth - 6, hc], tr, true);
        if (tr.fraction < 1 && !tr.startSolid) this.strike('noclip', 'through a wall');
      }
      const limit = (MAX_AXIS_SPEED + (boosted ? this.boostSpeed : 0)) * TICK + 0.5;
      for (let a = 0; a < 3; a++) if (Math.abs(d[a]) > limit) { this.strike('speed', `${(Math.abs(d[a]) / TICK).toFixed(0)} u/s`); break; }
    }
    // the air: falling must decelerate at (at least half) the gravity the map set; rising needs a jump / push.
    // A crouch or unduck in the air moves the origin 9 u in one tick (CS2's FinishDuck / unduck: the hull changes
    // about its middle, world/movement.js handleDuck): not a velocity, so it's taken out of the fall speed here, or
    // every mid-air crouch read as a +576 u/s lift and three crouch-jumps in 2 s removed an honest player
    const duckShift = this.wasAir && ducked !== this.ducked ? (ducked ? 1 : -1) * (CS.standHeight - CS.duckHeight) * 0.5 : 0;
    const vz = (d[2] - duckShift) / TICK;
    const onGround = this.grounded(to, h);
    // a player wedged motionless against geometry in the air is stuck (CS movement can lock a falling hull in a
    // crease), not flying; a motionless hull touching nothing is hovering
    const wedged = !onGround && Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 0.01 && this.touching(to, h);
    const swim = this.swimming(from, this.ducked) || this.swimming(to, ducked);
    if (!onGround && !boosted && !teleported && !wedged && !swim && this.wasAir) {
      this.air.push(vz - this.vz);
      if (this.air.length >= AIR_WINDOW) {
        const mean = this.air.reduce((x, y) => x + y, 0) / this.air.length;
        const svGravity = parseFloat(this.run.cvars?.sv_gravity);
        const expect = -(Number.isFinite(svGravity) && svGravity >= 0 ? svGravity : CS.gravity) * this.gravity * TICK;
        if (mean > expect * 0.5 && expect < -0.5) this.strike('fly', `dv ${mean.toFixed(2)} vs ${expect.toFixed(2)}`);
        this.air.length = 0;
      }
    } else this.air.length = 0;
    // fall damage the client's own landing applies (580 safe .. 100 at 1024, × the map's sv_falldamage_scale, or 1
    // when the room forces fall damage on)
    const fallScale = this.rules.fallDamage ? 1 : Math.max(0, parseFloat(this.run.cvars?.sv_falldamage_scale) || 0);
    if (onGround && this.wasAir && fallScale && !this.noFall && this.run.started && -this.vz > 580) {
      if (!this.rules.god) this.hp -= (-this.vz - 580) * (100 / (1024 - 580)) * fallScale;
      if (this.hp <= 0) this.die(hazardName('fall', this.scenario));
    }
    this.vz = vz;
    this.wasAir = !onGround;
  }

  // does the hull touch geometry on any side (a 1 u sweep along +-x / +-y blocked at once)?
  touching(o, h) {
    const tr = makeTrace();
    const c = [o[0], o[1], o[2] + h];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      this.world.traceBox(c, [c[0] + dx, c[1] + dy, c[2]], [CS.halfWidth, CS.halfWidth, h], tr);
      if (tr.fraction < 0.5 || tr.startSolid) return true;
    }
    return false;
  }

  grounded(o, h) {
    const tr = makeTrace();
    const c = [o[0], o[1], o[2] + h];
    this.world.traceBox(c, [c[0], c[1], c[2] - 4], [CS.halfWidth, CS.halfWidth, h], tr);
    return tr.fraction < 1 || tr.startSolid;
  }

  // ---- shots: hits [[entity id, damage, count]]; mult = boss hits per landed shot (100 / boss HP %)
  // returns the hits that passed
  checkHits(hits, mult) {
    if (!this.alive || this.flagged) return [];
    const now = Date.now(), s = this.shots;
    const dt = Math.min(2, (now - s.at) / 1000);
    s.at = now;
    const g = this.gun;
    s.tokens = Math.min(BURST, s.tokens + dt / g.cycle);
    s.knife = Math.min(BURST / 2, s.knife + dt / KNIFE.slash.cycle);
    const gunDamage = (d) => d === g.damage || (now < this.prevUntil && d === this.prevGun?.damage);
    const P = this.pistol;
    // what can deal this damage: the primary, the pistol, the knife (the UMP-45 and the USP-S both hit for 35)
    const kindsOf = (d) => [gunDamage(d) && 'gun', d === P.damage && 'pistol', KNIFE_DAMAGE.includes(d) && 'knife'].filter(Boolean);
    const rangeOf = (k, d) => (k === 'gun' ? Math.max(g.range, now < this.prevUntil ? this.prevGun?.range || 0 : 0)
      : k === 'pistol' ? P.range : (d === KNIFE.stab.damage ? KNIFE.stab.range : KNIFE.slash.range) + KNIFE_REACH);
    // one shot from that weapon, if its magazine and the fire budget allow it
    const spend = (k, d) => {
      if (k === 'gun') {
        // the gun held before a buy: its last rounds were fired before the new gun's draw lock
        const old = d !== g.damage;
        if ((now < s.reloadUntil && !old) || s.tokens < 1) return false;
        s.tokens--; s.rounds--;
        if (s.rounds <= 0) { s.rounds = g.clip; s.reloadUntil = now + g.reload * 1000; }
      } else if (k === 'pistol') {
        // the budget is in the primary's cycles: a pistol shot costs its own cycle's worth
        const cost = P.cycle / g.cycle;
        if (now < s.pistolReloadUntil || s.tokens < cost) return false;
        s.tokens -= cost; s.pistolRounds--;
        if (s.pistolRounds <= 0) { s.pistolRounds = P.clip; s.pistolReloadUntil = now + P.reload * 1000; }
      } else {
        if (s.knife < 1) return false;
        s.knife--;
      }
      return true;
    };
    const bosses = this.bosses();
    const then = this.lagTicks ? this.past[0] : null; // the oldest kept: what a client lagTicks behind saw
    const out = [];
    for (const [id, dmg, n] of hits) {
      const e = bosses.find((x) => x.id === id);
      const kinds = kindsOf(dmg);
      if (!e || !kinds.length) { this.strike('shot', `damage ${dmg} on ${id}`); continue; }
      const range = Math.max(...kinds.map((k) => rangeOf(k, dmg)));
      // out of sight / reach, now and where the player's ping showed it: dropped (real lag can do this honestly)
      const past = then?.hulls.get(e.id);
      if (!this.canHit(e.hulls(), range) && !(past && this.canHit(past, range))) continue;
      let shotsWanted = Math.ceil(n / mult), ok = 0;
      while (shotsWanted-- > 0 && kinds.some((k) => spend(k, dmg))) ok++;
      if (ok * mult < n - mult) this.strike('firerate', `${n} hits, ${ok} shots allowed`); // one shot of slack
      if (ok) out.push([id, dmg, Math.min(n, ok * mult)]);
    }
    return out;
  }

  // the client started a reload of its primary or its pistol (w: the slot): no rounds until it's done, then a full
  // magazine (an early reload is legal; faking one only costs the shooter time)
  reload(w) {
    const now = Date.now(), s = this.shots;
    if (w === 'pistol') {
      if (now < s.pistolReloadUntil) return;
      s.pistolReloadUntil = now + (this.pistol.reload - RELOAD_SLACK) * 1000;
      s.pistolRounds = this.pistol.clip;
      return;
    }
    if (now < s.reloadUntil) return;
    s.reloadUntil = now + (this.gun.reload - RELOAD_SLACK) * 1000;
    s.rounds = this.gun.clip;
  }

  // the client bought a gun (app/buy.js): a full magazine of it, after its draw (m_flDeployDuration). Buying again and
  // again only costs the buyer the draw each time, so it is no way round the fire rate.
  setGun(name) {
    if (typeof name !== 'string' || !Object.hasOwn(GUNS, name)) return;
    const now = Date.now(), s = this.shots;
    if (GUNS[name] !== this.gun) { this.prevGun = this.gun; this.prevUntil = now + SWAP_GRACE; }
    this.gun = GUNS[name];
    s.rounds = this.gun.clip;
    s.reloadUntil = Math.max(s.reloadUntil, now + (this.gun.deploy - RELOAD_SLACK) * 1000);
  }

  // a clear line from the eye to the boss hull (its centre or a corner), within range
  canHit(hulls, range) {
    const eye = this.eye();
    const tr = makeTrace();
    for (const h of hulls || []) {
      const pts = [[(h.min[0] + h.max[0]) / 2, (h.min[1] + h.max[1]) / 2, (h.min[2] + h.max[2]) / 2]];
      for (let i = 0; i < 8; i++) pts.push([i & 1 ? h.max[0] : h.min[0], i & 2 ? h.max[1] : h.min[1], i & 4 ? h.max[2] : h.min[2]]);
      // the nearest point of the box, for reach
      const near = [0, 1, 2].map((a) => Math.min(h.max[a], Math.max(h.min[a], eye[a])));
      if (len3(near, eye) > range) continue;
      for (const p of pts) {
        this.shotWorld.traceBox(eye, p, [0, 0, 0], tr, true, BULLET_MASK);
        if (tr.fraction >= 0.98) return true;
      }
    }
    return false;
  }
}

