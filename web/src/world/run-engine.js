// One attempt at a stage, the engine half: build the map's entity world for a scenario exactly the same way in
// the browser (app/session.js) and on the co-op server's checker (server/coop-check.js), so the server's copy of
// a round can't drift from what players see. Pure: no DOM, no rendering, no audio, no player physics.
//
//   const run = createRunEngine({ entities, hulls, bounds, traceBox, scenario, mode, seed, humans, bossHp, items, hooks })
//   hooks.attach(engine)    before the world spawns (renderer / sound / player hooks)
//   hooks.silent(on)        a fast-forward replay starts / ends (the client mutes its sounds)
//   hooks.win() / lose()    the scenario's win / lose input arrived (a disabled relay doesn't count)
//   hooks.place(spawn)      where the player starts ({ origin, yaw, pitch? }), before the `setup` inputs fire
// Fills and returns `run` (the caller's run object, or a new one) with
//   { engine, endless, fireStart(), endlessTick, ffStart, started, startTime, fireAcc, cvars }.
import { EntityEngine, parseVec } from './entities/index.js';
import { mapCvars } from './entities/classes/server.js';
import { giveItems } from './items.js';
import { installEndless } from '../app/endless.js';
import { inputMatcher, nameKey, stripPrefix } from '../lib/names.js';
import { own } from '../lib/storage.js';

export const TICK = 1 / 64;
const DAMAGE_PER_HIT = 30;
const PERFECT_HITS_PER_HUMAN = 5;

export function createRunEngine({ entities, hulls, bounds, traceBox, scenario, mode = 'normal', seed, humans = 20, bossHp = 100, items = [], hooks = {}, run: into = {} }) {
  const endless = mode === 'endless' && !!scenario?.endless;
  const engine = new EntityEngine(entities, { hulls, bounds }, { seed });
  // physboxes (world/entities/classes/physics.js) slide along the static world only
  if (traceBox) engine.traceBox = traceBox;
  engine.humans = humans;
  hooks.attach?.(engine);
  engine.spawnWorld();

  const run = Object.assign(into, { engine, endless, started: false, startTime: 0, ffStart: undefined, fireAcc: 0, endlessTick: null });
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
    run.started = true;
    run.startTime = engine.time;
  }

  hooks.place?.(spawnPoint(engine, scenario));
  // `setup`: inputs that put the map where its own sequence would be by now, for a stage that starts past the relays
  // that do it (ze_deadcore's drills move des2, its catch-all fall destination, where the map keeps it for that part)
  for (const s of scenario?.setup || []) engine.fire(s.target, s.input, s.param || '', s.delay || 0, engine.playerEnt, null);
  // player.name: the targetname the map gives a human before this point (westersand's spawn room: "None")
  if (scenario?.player?.name) { engine.playerEnt.name = String(scenario.player.name); engine.playerEnt.key = nameKey(scenario.player.name); }
  // items: the map items (world/items.js mapItems entries) this player holds from the start: solo the map's heals
  // when the heal option is on (app/items.js heldItems), in a room whatever the room gave this player
  run.items = giveItems(engine, Array.isArray(items) ? items : []);
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
    for (const e of targets) if (bossHittable(e)) engine.damage(e, DAMAGE_PER_HIT, engine.playerEnt);
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
