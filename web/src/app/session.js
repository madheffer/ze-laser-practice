// One attempt at a stage: build a fresh entity world, replay the map up to the stage (fast-forward), place the
// player, watch for win / lose / death, and hand the result to the end card (and the records).
import * as THREE from 'three';
import { EntityEngine, parseVec, DEG } from '../world/entities/index.js';
import { CS } from '../world/movement.js';
import { S, G, log } from './state.js';
import { settings } from './settings.js';
import { bossFire } from './bosses.js';
import { installEndless } from './endless.js';
import { submitRun, getRecord } from './records.js';
import { formatTime, plural } from '../lib/format.js';
import { inputMatcher, stripPrefix } from '../lib/names.js';
import { own } from '../lib/storage.js';

export function endRun() {
  G.audio.stopAll();
  G.renderer.clearEntities();
  S.engine = null;
  S.run = null;
  S.scenario = null;
  S.scenarioIndex = -2;
}

// The scenario's `start` inputs (at the stage start, and again for each endless repeat).
export function fireStart() {
  for (const s of S.scenario?.start || []) S.engine.fire(s.target, s.input, s.param || '', s.delay || 0, S.engine.playerEnt, null);
}

// mode: 'normal' | 'endless'
export function startScenario(i, mode = 'normal') {
  const { map, player } = S;
  endRun();
  G.overlay.hide();
  S.scenarioIndex = i;
  const scenario = S.scenario = i >= 0 ? S.scenarios[i] : null;
  const endless = mode === 'endless' && !!scenario?.endless;
  const engine = S.engine = new EntityEngine(map.entities, { hulls: map.hulls, bounds: map.bounds }, { seed: settings.seed || (Date.now() & 0xffff) });
  engine.on('spawn', (e) => G.renderer.addEntity(e, map));
  engine.on('kill', (e) => G.renderer.removeEntity(e));
  engine.on('log', (m) => log(m));
  // map sounds arrive with the entities they belong to: as late as the simulated ping draws them
  // During a silent fast-forward, remember what is still sounding, so it can join at the right point after.
  const sounding = new Map(); // ent.id -> { ev, at }
  engine.on('sound', (ev) => {
    if (S.run?.silent) {
      if (ev.type === 'start') sounding.set(ev.ent.id, { ev, at: engine.time });
      else if (ev.type === 'stop') sounding.delete(ev.ent.id);
      return;
    }
    if (settings.ping > 0) setTimeout(() => { if (S.engine === engine) G.audio.onSound(ev); }, settings.ping);
    else G.audio.onSound(ev);
  });
  engine.onTeleportPlayer = (o, yaw) => player.teleport(o, yaw ?? player.yaw);
  engine.playerMatrix = () => new THREE.Matrix4().compose(
    new THREE.Vector3(...player.origin),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), player.yaw * DEG),
    new THREE.Vector3(1, 1, 1));
  engine.humans = settings.humans;
  // what the map can do to you: !activator SetHealth / KeyValue gravity, speed, max_health, absvelocity
  engine.player = {
    setHealth: (v) => { S.run.hp = v; S.run.maxHp = Math.max(S.run.maxHp, v); },
    setMaxHealth: (v) => { S.run.maxHp = v; },
    setGravity: (g) => { player.gravityScale = g; },
    setSpeed: (s) => { player.speedScale = s; },
    setVelocity: (v) => { player.velocity = [...v]; if (v[2] > 0) player.onGround = false; },
    setDamageFilter: (name) => {
      const f = engine.findOne(name);
      // filter_damage_type, negated, DMG_FALL (32): "everything but fall damage" = no fall damage
      S.run.noFall = !!f && f.cls === 'filter_damage_type' && (parseInt(f.kv.damagetype, 10) & 32) && String(f.kv.negated) === '1';
    },
  };
  player.gravityScale = scenario?.player?.gravity ?? 1;
  player.speedScale = 1;
  player.stamina = 0;
  player.onLand = (v) => {
    G.audio.play('land', { pos: player.origin });
    // CS fall damage: safe below 580 u/s, fatal at 1024, linear between (sv_falldamage_scale 1)
    const run = S.run;
    if (!run.started || run.done || run.noFall || !settings.fallDamage || v <= 580) return;
    hurtPlayer((v - 580) * (100 / (1024 - 580)), 'fall');
  };
  player.onJump = () => G.audio.play('jump', { pos: player.origin });
  engine.spawnWorld();

  // ZE humans spawn with the knife out and an assault suit (CS2Fixes ZR: weapon_knife + item_assaultsuit when
  // cs2f_free_armor 2); scenario.player can override health/armor/gravity for a stage that starts mid-map.
  const hp0 = scenario?.player?.health ?? 100;
  S.run = {
    t: 0, startAt: scenario ? 1.0 : Infinity, started: false, hp: hp0, maxHp: hp0,
    armor: scenario?.player?.armor ?? 100, helmet: true,
    hits: 0, done: false, result: '', mode: endless ? 'endless' : 'normal', endless,
    winAfter: endless ? null : scenario?.winAfter, fireAcc: 0, myHits: 0, myDamage: 0, noFall: false, bossPeak: new Map(),
    endlessTick: null,
  };
  const run = S.run;

  watchWinLose(engine, scenario, endless);
  if (endless) run.endlessTick = installEndless(engine, scenario, fireStart);

  // Later stages start by replaying the map's own sequence up to that point, silently, then placing you.
  if (scenario?.fastForward) {
    run.ffStart = engine.time;
    run.silent = true;
    fireStart();
    const n = Math.round(scenario.fastForward / CS.tick);
    // bosses that must already be dead by the stage you start at are shot down during the replay
    for (let k = 0; k < n; k++) { engine.tick(CS.tick); if (scenario.fastForwardBosses) bossFire(CS.tick, true); }
    // "hold": push everything the map still has queued back by N s, so you get time to look around
    if (scenario.hold) for (const q of engine.queue) q.t += scenario.hold;
    run.silent = false;
    run.started = true;
    run.startTime = engine.time;
    // what the map started during the replay and hasn't stopped (music, loops) carries on from where it'd be
    for (const { ev, at } of sounding.values()) {
      if (ev.ent.alive) G.audio.onSound({ ...ev, pos: ev.ent.worldOrigin(), offset: engine.time - at });
    }
  }

  placePlayer(scenario);
  G.vm.reset(scenario?.weapon || 'knife');
  G.hud.showWeapons(G.vm.weapon);
  G.menu.update();
}

// Win / lose when a named entity receives a named input (each may be one {target,input} or a list).
function watchWinLose(engine, scenario, endless) {
  const wins = inputMatcher(endless ? null : scenario?.win), loses = inputMatcher(scenario?.lose);
  if (!wins.size && !loses.size) return;
  engine.hookInput((e, input) => {
    const run = S.run;
    // a disabled relay ignores Trigger (the escape boss's death disables relay_fail before its corpse reaches
    // the end and "triggers" it), so it doesn't count either
    if (run && !run.done && run.started && !(e.cls === 'logic_relay' && !e.enabled)) {
      if (loses(e.key, input)) finish('lose');
      else if (wins(e.key, input)) finish('win');
    }
    return false; // watched, never swallowed
  });
}

function placePlayer(scenario) {
  const { engine, player } = S;
  let spawn = scenario?.spawn;
  if (spawn?.at || spawn?.on) {
    // spawn on a named entity: at its origin, or standing on top of it
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
  player.teleport([spawn.origin[0], spawn.origin[1], spawn.origin[2] + 1], spawn.yaw ?? 0);
  if (spawn.pitch != null) player.pitch = spawn.pitch;
}

export function stageTime() {
  const run = S.run;
  return run?.started ? S.engine.time - run.startTime : 0;
}

export function hurtPlayer(dmg, source) {
  const run = S.run;
  run.lastHurt = { dmg, source };
  G.hud.damaged();
  if (settings.god) return;
  run.hp -= dmg;
  if (run.hp <= 0) {
    run.killedBy = source;
    finish('dead');
  }
}

export function healPlayer(amount) {
  const run = S.run;
  run.hp = Math.min(run.maxHp, run.hp + amount);
}

// What killed you, in words: the scenario's own name for it, or the entity name tidied up
// (hurt_finalbullet&0042 -> "finalbullet").
function hazardName(source) {
  if (source === 'fall') return 'Fall damage';
  const raw = typeof source === 'string' ? source : (source?.name || '');
  const key = stripPrefix(raw).replace(/&\d+$/, '');
  const named = own(S.scenario?.hazards, key);
  if (typeof named === 'string' && named) return named;
  return key.replace(/^(hurt|tr|trigger)_/, '').replace(/_/g, ' ') || 'the map';
}

// End of an attempt: pause behind a card, record the run.
export function finish(result) {
  const run = S.run;
  if (!run || run.done) return;
  run.done = true;
  run.result = result;
  const t = stageTime();
  const scenario = S.scenario;
  const map = S.map.name;
  const stage = scenario?.id || 'free';
  G.pause();
  document.exitPointerLock?.();

  let rec = null;
  if (scenario && (result === 'win' || run.endless)) {
    rec = submitRun(map, stage, run.mode, { time: t, hits: run.hits, humans: settings.humans, bossHp: settings.bossHp });
  }
  const best = getRecord(map, stage, run.mode);
  const retry = { label: 'Retry', key: 'Enter', primary: result !== 'win', onClick: () => G.play(S.scenarioIndex, run.mode) };
  const menu = { label: 'Menu', key: 'Escape', onClick: () => { G.overlay.hide(); G.menu.update(); } };
  const stats = [
    [run.endless ? 'Survived' : result === 'win' ? 'Time' : 'Survived', formatTime(t), !!rec?.improved.time],
    ['Hits taken', String(run.hits), !!rec?.improved.hits],
  ];
  if (run.myHits) stats.push(['Your boss hits', String(run.myHits)]);
  if (best && !rec?.improved.time) stats.push([run.endless ? 'Best survived' : 'Best time', formatTime(best.time)]);

  if (run.endless) {
    G.overlay.show({
      kind: 'endless', kicker: `${scenario.name} · endless`, title: 'RUN OVER',
      subtitle: result === 'dead' ? `Killed by ${hazardName(run.killedBy)}` : 'Stage failed',
      record: rec?.improved.time ? 'New personal best' : '', stats, buttons: [retry, menu],
    }); G.menu.update();
    return;
  }
  if (result === 'win') {
    const buttons = [];
    if (scenario?.endless) buttons.push({ label: 'Endless mode', key: 'e', primary: true, onClick: () => G.play(S.scenarioIndex, 'endless') });
    buttons.push({ ...retry, primary: !scenario?.endless }, menu);
    G.overlay.show({
      kind: 'win', kicker: scenario?.name || '', title: 'STAGE CLEARED',
      subtitle: run.hits ? `${plural(run.hits, 'hit')} taken` : 'Clean run, no hits',
      record: rec?.improved.time ? 'New best time' : rec?.improved.hits ? 'Fewest hits yet' : '', stats, buttons,
    }); G.menu.update();
    return;
  }
  G.overlay.show({
    kind: 'dead', kicker: scenario?.name || 'Free roam', title: result === 'dead' ? 'YOU DIED' : 'STAGE FAILED',
    subtitle: result === 'dead' ? `Killed by ${hazardName(run.killedBy)}${run.lastHurt ? ` (${Math.round(run.lastHurt.dmg)})` : ''}` : 'The boss got away',
    stats, buttons: [retry, menu],
  });
  G.menu.update();
}
