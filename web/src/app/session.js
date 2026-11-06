// One attempt at a stage: build a fresh entity world (world/run-engine.js, shared with the co-op server's
// anti-cheat), replay the map up to the stage (fast-forward), place the player, watch for win / lose / death, and
// hand the result to the end card (and the records).
import * as THREE from 'three';
import { DEG } from '../world/entities/index.js';
import { createRunEngine, hazardName as hazardText, COUNTDOWN, legacyCountdown, freeSpawn } from '../world/run-engine.js';
import { standsFree } from '../world/movement.js';
import { viewBox } from '../world/view-box.js';
import { heldItems, heldMates } from './items.js';
import { prepareStage } from './readiness.js';
import { warmTemplates } from '../world/warm.js';
import { DEFAULT_GUN } from '../lib/weapons.js';
import { S, G, log } from './state.js';
import { settings } from './settings.js';
import { rule, godMode, stripperOff } from './rules.js';
import { mapEdits } from '../world/assets.js';
import { submitRun, getRecord } from './records.js';
import { reportSolo } from './activity.js';
import { ReplayRecorder, keepLastRun, lastRun } from './replay-record.js';
import { account, SIGN_IN_URL } from './account.js';
import { formatTime, plural } from '../lib/format.js';
import { consoleSay } from './chat.js';
import { simulatedPing } from './coop-load.js';
import { waterQuery } from '../world/water-volumes.js';
import { waterSound } from './water-sounds.js';

export function endRun() {
  G.audio.stopAll();
  G.renderer.clearEntities();
  S.engine = null;
  S.run = null;
  S.scenario = null;
  S.scenarioIndex = -2;
}

// The scenario's `start` inputs (at the stage start, and again for each endless repeat).
export function fireStart() { S.run?.fireStart?.(); }

// mode: 'normal' | 'endless'. A replay (S.replay, app/replay.js) rebuilds its run: its seed, its rules, no recording.
export function startScenario(i, mode = 'normal') {
  const { map, player } = S;
  if (!map?.loaded || !player) return; // a stage needs its map's world first (main.js loadStage)
  endRun();
  G.overlay.hide();
  S.scenarioIndex = i;
  const scenario = S.scenario = i >= 0 ? S.scenarios[i] : null;
  const endless = mode === 'endless' && !!scenario?.endless;
  // what of the map this stage draws (world/view-box.js): the whole map unless the scenario names a view box
  const view = viewBox(scenario);
  G.renderer.setViewBox(view);
  G.stream?.setView(view);
  G.renderer.setHidden([...(S.mapHide || []), ...(scenario?.hide || [])]); // entities this stage doesn't draw

  // ZE humans spawn with the knife out and an assault suit (CS2Fixes ZR: weapon_knife + item_assaultsuit when
  // cs2f_free_armor 2); scenario.player can override health/armor/gravity for a stage that starts mid-map.
  const hp0 = scenario?.player?.health ?? 100;
  const run = S.run = {
    // startAt: world/run-engine.js (COUNTDOWN, 3 s solo and in a round; a replay plays its own)
    t: 0, ticks: 0, started: false, hp: hp0, maxHp: hp0,
    armor: scenario?.player?.armor ?? 100, helmet: true,
    money: 16000, // what you spend on !kevlar / weapons (app/chat-commands.js); the HUD's money
    hits: 0, done: false, result: '', mode: endless ? 'endless' : 'normal', endless,
    winAfter: endless ? null : scenario?.winAfter, fireAcc: 0, myHits: 0, myDamage: 0, noFall: false, bossPeak: new Map(),
    endlessTick: null,
    // the stage's random rolls; a replay must play on the seed it was recorded with
    seed: S.replay ? S.replay.meta.seed : (S.mp?.rules.seed || settings.seed || (Date.now() & 0xffff)),
    // ready: the stage is loaded and drawn (app/readiness.js); go: a round's server started everyone's clock
    ready: false, go: !S.mp, loading: 'loading',
  };

  player.gravityScale = scenario?.player?.gravity ?? 1;
  player.speedScale = 1;
  player.stamina = 0;
  player.landTick = -Infinity; // no landing penalty carried into a new run (world/movement.js jumpScale)
  player.runSpeed = 1;
  player.onLand = (v) => {
    G.audio.play('land', { pos: player.origin });
    // CS fall damage: safe below 580 u/s, 100 at 1024, linear between, × sv_falldamage_scale. The map's scale
    // (GFL servers run none; a map sets it for an area); the "Fall damage everywhere" option forces scale 1
    const scale = rule('fallDamage') ? 1 : Math.max(0, parseFloat(run.cvars?.sv_falldamage_scale) || 0);
    if (!run.started || run.done || run.noFall || !scale || v <= 580) return;
    const dmg = (v - 580) * (100 / (1024 - 580)) * scale;
    run.rec?.event(run.ticks, 'fall', { damage: Math.round(dmg * 10) });
    hurtPlayer(dmg, 'fall');
  };
  player.onJump = () => G.audio.play('jump', { pos: player.origin });

  // map sounds arrive with the entities they belong to: as late as the simulated ping draws them
  // During a silent fast-forward, remember what is still sounding, so it can join at the right point after.
  const sounding = new Map(); // `${ent.id}:${slot}` -> { ev, at }
  // the map's entities with the GFL edits this run leaves out (app/rules.js stripperOff; world/assets.js mapEdits)
  const runEdits = { off: mapEdits(map, stripperOff(map.name)) };
  createRunEngine({
    entities: map.entities, hulls: map.hulls, bounds: map.bounds, animations: map.animations, soundDurations: map.soundDurations,
    traceBox: (s, e, h) => S.world.traceBox(s, e, h, undefined, true),
    physics: map.physics, // the bake's physics.bin, for CS2's physics (world/physics-world.js)
    fits: (o, solids) => standsFree(S.world, o, solids), // never spawn inside the floor or a moving brush
    countdown: S.replay ? (S.replay.meta.countdown ?? legacyCountdown(scenario)) : COUNTDOWN,
    scenario, mapUpdated: S.mapUpdated, mode, seed: run.seed,
    humans: rule('humans'), bossHp: rule('bossHp'), items: heldItems(), mates: heldMates(), run,
    // kept on the run: a replay's seek mutes the map the same way (app/replay.js)
    hooks: run.hooks = {
      attach(engine) {
        if (S.engine !== engine) S.engine?.physics?.destroy(); // the last run's physics world (world/physics-world.js)
        S.engine = engine;
        engine.on('spawn', (e) => G.renderer.addEntity(e, map));
        engine.on('kill', (e) => G.renderer.removeEntity(e));
        engine.on('log', (m) => log(m));
        engine.on('say', consoleSay); // point_servercommand "say ..." -> the chat, as CS2Fixes prints it
        engine.on('sound', (ev) => {
          if (run.silent) {
            const key = `${ev.ent.id}:${ev.slot ?? ''}`;
            if (ev.type === 'start') sounding.set(key, { ev, at: engine.time });
            else if (ev.type === 'stop') {
              if (ev.slot != null) sounding.delete(key);
              else for (const k of [...sounding.keys()]) if (k.startsWith(`${ev.ent.id}:`)) sounding.delete(k);
            }
            return;
          }
          const lag = simulatedPing(); // a round's is locked at its start (app/coop-load.js)
          if (lag > 0) setTimeout(() => { if (S.engine === engine) G.audio.onSound(ev); }, lag);
          else G.audio.onSound(ev);
        });
        // a Source 1 map's sparks / tesla beams and screen shakes (entities/classes/sparks.js), not while replaying silently
        G.shake.clear();
        G.fade.clear(); // and its screen fades (env_fade: classes/fade.js -> app/screen-fade.js)
        engine.on('fade', (ev) => { if (!run.silent && (!ev.only || ev.only === engine.playerEnt)) G.fade.request(ev, engine.time); });
        engine.on('tempfx', (ev) => { if (!run.silent) G.renderer.tempFx.request(ev, engine.time); });
        engine.on('shake', (ev) => {
          if (run.silent) return;
          const at = [player.origin[0], player.origin[1], player.origin[2] + player.eyeHeight() / 2];
          G.shake.request(ev, at, player.onGround, engine.time);
        });
        engine.onTeleportPlayer = (o, yaw) => player.teleport(landing(o), yaw ?? player.yaw);
        engine.playerMatrix = () => new THREE.Matrix4().compose(
          new THREE.Vector3(...player.origin),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), player.yaw * DEG),
          new THREE.Vector3(1, 1, 1));
        // what the map can do to you: !activator SetHealth / KeyValue gravity, speed, max_health, absvelocity
        engine.player = {
          setHealth: (v) => { run.hp = v; run.maxHp = Math.max(run.maxHp, v); },
          setMaxHealth: (v) => { run.maxHp = v; },
          setGravity: (g) => { player.gravityScale = g; },
          setSpeed: (sp) => { player.speedScale = sp; },
          setRunSpeed: (r) => { player.runSpeed = r; }, // KeyValue runspeed (CS2Fixes m_flVelocityModifier)
          setVelocity: (v) => { player.velocity = [...v]; if (v[2] > 0) player.onGround = false; },
          setDamageFilter: (name) => {
            const f = engine.findOne(name);
            // filter_damage_type, negated, DMG_FALL (32): "everything but fall damage" = no fall damage
            run.noFall = !!f && f.cls === 'filter_damage_type' && (parseInt(f.kv.damagetype, 10) & 32) && String(f.kv.negated) === '1';
          },
        };
      },
      silent(on) {
        run.silent = on;
        if (on) return;
        // what the map started during the replay and hasn't stopped (music, loops) carries on from where it'd be
        for (const { ev, at } of sounding.values()) {
          if (ev.ent.alive) G.audio.onSound({ ...ev, pos: ev.ent.worldOrigin(), offset: run.engine.time - at });
        }
      },
      win: () => finish('win'),
      lose: () => finish('lose'),
      place(spawn) {
        player.teleport(spawn.origin, spawn.yaw);
        if (spawn.pitch != null) player.pitch = spawn.pitch;
      },
    },
  });
  // the map's movement cvars, as it loads and live after (ze_dreamin: sv_airaccelerate 9.6, 12 later, 1000 for its
  // surf push; westersand: sv_friction 4, sv_accelerate 5); world/movement.js falls back to CS2's for the rest
  player.cvars = {};
  for (const [n, v] of Object.entries(run.cvars || {})) setMoveCvar(player, n, v);
  S.engine.on('cvar', (n, v) => setMoveCvar(player, n, v));
  // the map's water (world/water-volumes.js: func_water, water-layer shapes, the world's water) and its sounds
  player.water = waterQuery(S.engine, map.collisionFx);
  player.waterFrac = 0; player.waterLevel = 0; player.swimSoundMs = 0; player.waterJumpMs = 0;
  player.onWaterSound = waterSound;
  // a round runs on the wall clock from here (loop.js simulate), so every client's map stays in step
  run.wall0 = performance.now();
  // nothing moves until the stage is loaded and drawn; a round then tells the server and waits for its go
  prepareStage(run, (step) => { run.loading = step; }).then(() => {
    if (S.run !== run) return;
    run.ready = true;
    run.loading = '';
    if (S.mp) S.mp.sendReady();
    // what the map spawns mid-stage, made ready in idle time so its first spawn doesn't stall a frame (world/warm.js)
    if (!S.replay?.fast) warmTemplates({ renderer: G.renderer, map, engine: S.engine, scenario, view, origin: [...player.origin], isCurrent: () => S.run === run && !run.done }).catch((e) => console.warn('warm-up:', e));
  });
  // the loading screen (ui/loading.js) covers it until the clock starts; a restart on a loaded map is usually
  // ready within a few frames, so it shows only if it isn't by then
  G.loading?.follow(run, map.name, scenario ? scenario.id : null);
  // your solo runs on a stage are recorded for their replay (app/replay-record.js), never a round's or a replay's
  if (scenario && !S.mp && !S.replay) {
    run.rec = new ReplayRecorder({
      seed: run.seed, map: map.name, mapVersion: map.version || '', stage: scenario.id, mode: run.mode, countdown: run.startAt,
      weapon: scenario.weapon || 'knife', gun: DEFAULT_GUN,
      rules: { humans: rule('humans'), bossHp: rule('bossHp'), autoFire: rule('autoFire'), perfectTeam: rule('perfectTeam'), fallDamage: rule('fallDamage'), healItem: !!settings.healItem, ultimaItem: settings.ultimaItem, ultimaAt: settings.ultimaAt, stripperOff: runEdits.off },
    });
  }
  // every stage starts with the PP-Bizon (a replay: the gun its run started with, then its buys: app/replay-play.js)
  const gun = S.replay ? S.replay.meta.gun : DEFAULT_GUN;
  if (S.replay) S.replay.gunName = gun;
  G.vm.reset(scenario?.weapon || 'knife', gun);
  G.vm.retryLoad(); // hands that failed to load before (weapons/viewmodel.js): this stage tries them again
  G.hud.showWeapons(G.vm.weapon, G.vm.gunName);
  G.menu.update();
}

// Where a map teleport lands you: its destination, or the nearest spot a player fits when that is inside something
// (dreamin's boss_des, where its Crystal stages begin, sits 8 u inside the arena floor's brush): the spawn's rule
// (world/run-engine.js freeSpawn). The server's check allows a landing this close (coop-check.js TELEPORT_SLACK).
export function landing(origin) {
  const solids = S.engine ? S.engine.solids() : [];
  return freeSpawn(origin, (o) => standsFree(S.world, o, solids));
}

export function stageTime() {
  const run = S.run;
  return run?.started ? S.engine.time - run.startTime : 0;
}

export function hurtPlayer(dmg, source) {
  const run = S.run;
  if (run.spectating) return;
  run.lastHurt = { dmg, source };
  G.hud.damaged();
  if (godMode()) return;
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

// What killed you, in words (world/run-engine.js hazardName, with this stage's own names for its hazards).
export const hazardName = (source) => hazardText(source, S.scenario);

// End of an attempt: pause behind a card, record the run. result: 'win' | 'dead' | 'lose' | 'quit' (End run on the
// pause screen, an endless run only: kept like a death at that time)
export function finish(result) {
  const run = S.run;
  if (!run || run.done) return;
  // in a round your death makes you a spectator, and the server decides how the round ends (app/coop.js)
  if (S.mp) {
    // the stage's clear / fail goes to the server once (winAfter would say it every tick); the round runs on
    if (result !== 'dead') { if (!run.reported) { run.reported = result; S.mp.outcome(result); } return; }
    if (run.spectating) return;
    run.spectating = true;
    run.deadAt = stageTime();
    // CS2's death-cam mix (DeathFadeLayer to 0.15 over 2 s, audio/layers.js) only with nobody left to watch: with a
    // teammate alive you are in their eyes at once (app/coop.js spectateView), hearing what they hear
    if (!S.mp.watchable) G.audio.deathFade?.('death');
    G.vm.trigger(false); G.vm.trigger2(false);
    S.mp.died(hazardName(run.killedBy));
    return;
  }
  run.done = true;
  run.result = result;
  const t = stageTime();
  if (S.replay) { G.replayOver?.(result, t); return; } // app/replay.js: its own end card, nothing recorded
  const scenario = S.scenario;
  const map = S.map.name;
  const stage = scenario?.id || 'free';
  G.pause();
  document.exitPointerLock?.();

  let rec = null;
  if (scenario && (result === 'win' || run.endless)) {
    rec = submitRun(map, stage, run.mode, { time: t, hits: run.hits, humans: rule('humans'), bossHp: settings.bossHp });
  }
  // the run's replay (app/replay-record.js): kept for "Watch replay" and sent with the run (app/activity.js)
  const replay = run.rec?.finish() || null;
  const info = { name: account.user?.name || G.lobby?.name || 'You', time: t, result };
  keepLastRun(replay, info);
  reportSolo({ map, stage, mode: run.mode, result, time: t, hits: run.hits, cause: result === 'dead' ? hazardName(run.killedBy) : '', name: G.lobby?.name || '', god: godMode() }, replay)
    .then((r) => { if (r?.replay && lastRun()?.info === info) info.id = String(r.replay); }); // its link (Copy link)
  const best = getRecord(map, stage, run.mode);
  const retry ={ label: 'Retry', key: 'Enter', primary: result !== 'win', onClick: () => G.play(S.scenarioIndex, run.mode) };
  const menu = { label: 'Menu', key: 'Escape', onClick: () => { G.overlay.hide(); G.menu.update(); } };
  const watch = replay ? [{ label: 'Watch replay', onClick: () => G.watchLastRun() }] : []; // no key: W is a movement key (held at death it would start the replay)
  // a guest's run isn't kept on the server: Steam's sign-in page and back, then it is sent (app/activity.js)
  const save = !account.user && scenario && !godMode()
    ? [{ label: 'Sign in with Steam to save', primary: result === 'win' && !scenario.endless, onClick: () => { location.href = SIGN_IN_URL; } }] : []; // no key: S is a movement key
  const stats = [
    [run.endless ? 'Survived' : result === 'win' ? 'Time' : 'Survived', formatTime(t), !!rec?.improved.time],
    ['Hits taken', String(run.hits), !!rec?.improved.hits],
  ];
  if (run.myHits) stats.push(['Your boss hits', String(run.myHits)]);
  if (best && !rec?.improved.time) stats.push([run.endless ? 'Best survived' : 'Best time', formatTime(best.time)]);

  if (run.endless) {
    G.overlay.show({
      kind: 'endless', kicker: `${scenario.name} · endless`, title: 'RUN OVER',
      subtitle: result === 'dead' ? `Killed by ${hazardName(run.killedBy)}` : result === 'quit' ? 'You ended the run' : 'Stage failed',
      record: rec?.improved.time ? 'New personal best' : '', stats, buttons: [retry, ...save, ...watch, menu],
    }); G.menu.update();
    return;
  }
  if (result === 'win') {
    const buttons = [];
    if (scenario?.endless) buttons.push({ label: 'Endless mode', key: 'e', primary: true, onClick: () => G.play(S.scenarioIndex, 'endless') });
    buttons.push(...save, { ...retry, primary: !scenario?.endless && !save.length }, ...watch, menu);
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
    stats, buttons: [retry, ...save, ...watch, menu],
  });
  G.menu.update();
}

// sv_* movement cvar -> the player's override (world/movement.js); a non-number is ignored
const MOVE_CVARS = { sv_accelerate: 'accelerate', sv_airaccelerate: 'airAccelerate', sv_friction: 'friction', sv_gravity: 'gravity', sv_stopspeed: 'stopSpeed', sv_jump_impulse: 'jumpImpulse' };
function setMoveCvar(player, name, value) {
  const key = MOVE_CVARS[name];
  const v = parseFloat(value);
  if (key && Number.isFinite(v)) player.cvars[key] = v;
}
