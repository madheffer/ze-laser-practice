// One attempt at a stage, the engine half: build the map's entity world for a scenario exactly the same way in
// the browser (app/session.js) and on the co-op server's checker (server/coop-check.js), so the server's copy of
// a round can't drift from what players see. Pure: no DOM, no rendering, no audio, no player physics.
//
//   const run = createRunEngine({ entities, hulls, bounds, animations, traceBox, scenario, mode, seed, humans, bossHp, items, hooks })
//   hooks.attach(engine)    before the world spawns (renderer / sound / player hooks)
//   hooks.silent(on)        a fast-forward replay starts / ends (the client mutes its sounds)
//   hooks.win() / lose()    the scenario's win / lose input arrived (a disabled relay doesn't count)
//   hooks.place(spawn)      where the player starts ({ origin, yaw, pitch? }), before the `setup` inputs fire
//   fits(origin, solids)    does a standing player fit there (world/movement.js standsFree): a spawn that doesn't
//                           moves to the nearest spot that does (freeSpawn)
//   countdown               seconds from the spawn to the stage's start (COUNTDOWN; a replay passes its own)
// Fills and returns `run` (the caller's run object, or a new one) with
//   { engine, endless, fireStart(), endlessTick, ffStart, started, startAt, preFired, startTime, fireAcc, cvars }.
// Each tick before the start: startIfDue(run, t) starts the stage once its clock reaches startAt, and the map only
// ticks while mapRuns(run) (a mid-map stage stands still through its countdown).
import { EntityEngine, parseVec } from './entities/index.js';
import { mapCvars } from './entities/classes/server.js';
import { giveItems } from './items.js';
import { installEndless } from '../app/endless.js';
import { inputMatcher, nameKey, stripPrefix } from '../lib/names.js';
import { own } from '../lib/storage.js';

export const TICK = 1 / 64;
// s from the spawn to the stage's start, solo and in a round: time to look around, and for a round's guests to click
// in. A stage that starts mid-map (fastForward) holds the map still for it, where the replay left it.
export const COUNTDOWN = 3;
// a replay recorded before its meta carried the countdown: mid-map stages had none, the others 1 s solo
export const legacyCountdown = (scenario) => (scenario?.fastForward ? 0 : 1);
const DAMAGE_PER_HIT = 30;
const PERFECT_HITS_PER_HUMAN = 5;

export function createRunEngine({ entities, hulls, bounds, animations, traceBox, fits = null, countdown = COUNTDOWN, scenario, mode = 'normal', seed, humans = 20, bossHp = 100, items = [], hooks = {}, run: into = {} }) {
  const endless = mode === 'endless' && !!scenario?.endless;
  const engine = new EntityEngine(entities, { hulls, bounds, animations }, { seed });
  // physboxes (world/entities/classes/physics.js) slide along the static world only
  if (traceBox) engine.traceBox = traceBox;
  engine.humans = humans;
  hooks.attach?.(engine);
  engine.spawnWorld();

  const run = Object.assign(into, {
    engine, endless, started: false, startTime: 0, ffStart: undefined, fireAcc: 0, endlessTick: null,
    startAt: scenario ? Math.max(0, countdown) : Infinity, preFired: false,
  });
  // the map's server cvars: what it sets as it loads, then any point_servercommand during the run. Fall damage is
  // sv_falldamage_scale: 0 on GFL unless the map turns it on (for an area) itself
  run.cvars = mapCvars(engine);
  engine.on('cvar', (name, value) => { run.cvars[name] = value; });
  run.fireStart = () => {
    for (const s of scenario?.start || []) engine.fire(s.target, s.input, s.param || '', s.delay || 0, engine.playerEnt, null);
  };

  // win / lose when a named entity receives a named input (each may be one {target,input} or a list); a disabled
  // relay ignores Trigger (the escape boss's death disables relay_fail before its corpse "triggers" it)
  const wins = inputMatcher(endless ? null : scenario?.win), loses = inputMatcher(scenario?.lose);
  if (wins.size || loses.size) {
    engine.hookInput((e, input) => {
      if (run.started && !(e.cls === 'logic_relay' && !e.enabled)) {
        if (loses(e.key, input)) hooks.lose?.();
        else if (wins(e.key, input)) hooks.win?.();
      }
      return false; // watched, never swallowed
    });
  }
  if (endless) run.endlessTick = installEndless(engine, scenario, run.fireStart);

  // items: the map items (world/items.js mapItems entries) this player holds. Handed over BEFORE the replay, as a holder
  // carries them through the whole round: the map's own item rules during the replay reach them (mist: relay_escape
  // disables the heal at +80 s, the throne re-enables it; relay_dragon locks the others). Solo: the map's heals when the
  // heal option is on (app/items.js heldItems); in a room whatever the room gave this player.
  run.items = giveItems(engine, Array.isArray(items) ? items : []);

  // Later stages start by replaying the map's own sequence up to that point, silently, then placing you.
  if (scenario?.fastForward) {
    run.ffStart = engine.time;
    hooks.silent?.(true);
    run.fireStart();
    const n = Math.round(scenario.fastForward / TICK);
    // bosses that must already be dead by the stage you start at are shot down during the replay
    for (let k = 0; k < n; k++) { engine.tick(TICK); if (scenario.fastForwardBosses) replayBossFire(run, scenario, TICK, humans, bossHp); }
    // "hold": push everything the map still has queued back by N s, so you get time to look around
    if (scenario.hold) for (const q of engine.queue) q.t += scenario.hold;
    hooks.silent?.(false);
    // its start inputs went in at the replay's start: the countdown only holds the map still (startIfDue)
    run.preFired = true;
    if (run.startAt <= 0) { run.started = true; run.startTime = engine.time; }
  }

  const spawn = spawnPoint(engine, scenario);
  if (fits) { const solids = engine.solids(); spawn.origin = freeSpawn(spawn.origin, (o) => fits(o, solids)); }
  hooks.place?.(spawn);
  // `setup`: inputs that put the map where its own sequence would be by now, for a stage that starts past the relays
  // that do it (ze_deadcore's drills move des2, its catch-all fall destination, where the map keeps it for that part)
  for (const s of scenario?.setup || []) engine.fire(s.target, s.input, s.param || '', s.delay || 0, engine.playerEnt, null);
  // player.name: the targetname the map gives a human before this point (westersand's spawn room: "None")
  if (scenario?.player?.name) { engine.playerEnt.name = String(scenario.player.name); engine.playerEnt.key = nameKey(scenario.player.name); }
  return run;
}

// The simulated team shooting the scenario's fastForwardBosses during a replay: everyone, nonstop, no line of
// sight needed (the same on every client and on the server).
export function replayBossFire(run, scenario, dt, humans, bossHp) {
  const { engine } = run;
  const targets = [];
  for (const b of scenario.fastForwardBosses || []) {
    if (b.after && engine.time - (run.ffStart ?? 0) < b.after) continue;
    for (const e of engine.find(b.target)) if (e.alive && e.state.health != null) targets.push(e);
  }
  if (!targets.length) return;
  const scale = 100 / Math.max(1, bossHp);
  run.fireAcc += humans * PERFECT_HITS_PER_HUMAN * scale * dt;
  let guard = 0;
  while (run.fireAcc >= 1 && guard++ < 400) {
    run.fireAcc -= 1;
    for (const e of targets) if (bossHittable(e)) engine.damage(e, DAMAGE_PER_HIT, engine.teamEnt); // the team's replay fire
  }
  if (run.fireAcc > 400) run.fireAcc = 0;
}

// a physbox boss under 1% (strictly, as the map's compare is) is between segments: the map is about to top it
// back up
export const bossHittable = (e) => e.alive && (e.cls === 'func_breakable' || e.state.health >= e.state.max * 0.01);

// Where the player starts: the scenario's spawn (a fixed origin, or at / standing on a named entity), else the
// first CT spawn.
export function spawnPoint(engine, scenario) {
  let spawn = scenario?.spawn;
  if (spawn?.at || spawn?.on) {
    const e = engine.findOne(spawn.at || spawn.on);
    if (e) {
      const o = e.worldOrigin();
      let z = o[2];
      if (spawn.on) { const hs = e.hulls(); if (hs?.length) z = Math.max(...hs.map((h) => h.max[2])); }
      const off = spawn.offset || [0, 0, 0];
      spawn = { origin: [o[0] + off[0], o[1] + off[1], z + off[2]], yaw: spawn.yaw ?? 0, pitch: spawn.pitch };
    }
  }
  if (!spawn?.origin) {
    const ct = engine.findOne('info_player_counterterrorist');
    const a = ct ? parseVec(ct.kv.angles) : [0, 0, 0];
    spawn = { origin: ct ? ct.worldOrigin() : [0, 0, 0], yaw: a[1] };
  }
  return { origin: [spawn.origin[0], spawn.origin[1], spawn.origin[2] + 1], yaw: spawn.yaw ?? 0, pitch: spawn.pitch };
}

// A spawn the player doesn't fit at (a point under a floor the bake has since moved, deadcore's b_full; inside a
// platform's solid box, a_boss) moves to the nearest spot that fits: straight up first (a floor or a lid above),
// then around at that height, nearest first, 2 u above where it first fits. Nowhere within 640 u: left as it was.
const FREE_UP = 640, FREE_RINGS = [16, 32, 48, 64, 96, 128, 192, 256];
export function freeSpawn(origin, fits) {
  if (fits(origin)) return origin;
  const at = (dx, dy, dz) => [origin[0] + dx, origin[1] + dy, origin[2] + dz];
  const lift = (o) => { const up = [o[0], o[1], o[2] + 2]; return fits(up) ? up : o; };
  let ring = 0;
  for (let dz = 2; dz <= FREE_UP; dz += 2) {
    if (fits(at(0, 0, dz))) return lift(at(0, 0, dz));
    // a ring at the same height once going up has come as far as its radius
    while (ring < FREE_RINGS.length && FREE_RINGS[ring] <= dz) {
      const r = FREE_RINGS[ring++];
      for (let k = 0; k < 16; k++) {
        const o = at(r * Math.cos(k * Math.PI / 8), r * Math.sin(k * Math.PI / 8), 0);
        if (fits(o)) return lift(o);
      }
    }
  }
  return origin;
}

// Each tick before the stage has started (client loop.js, server coop-check.js): its start once the run's clock t
// reaches startAt. A mid-map stage fired its start inputs before its replay, so it only starts the clock.
export function startIfDue(run, t) {
  if (run.started || t < run.startAt) return false;
  run.started = true;
  run.startTime = run.engine.time;
  if (!run.preFired) run.fireStart();
  return true;
}
// does the map tick this tick: not while a mid-map stage counts down (it waits where its replay left it)
export const mapRuns = (run) => run.started || !run.preFired;

// What killed you, in words: the scenario's own name for it, or the entity name tidied up
// (hurt_finalbullet&0042 -> "finalbullet"). The kill feed's text, on the client and the server alike.
export function hazardName(source, scenario) {
  if (source === 'fall') return 'Fall damage';
  if (source === 'void') return 'the void';
  if (source === 'cage') return 'the zombies (sent to the zombie cage)';
  const raw = typeof source === 'string' ? source : (source?.name || '');
  const key = stripPrefix(raw).replace(/&\d+$/, '');
  const named = own(scenario?.hazards, key);
  if (typeof named === 'string' && named) return named;
  return key.replace(/^(hurt|tr|trigger)_/, '').replace(/_/g, ' ') || 'the map';
}
