// The frame loop (render every frame, camera interpolated) and the 64-tick simulation step.
import { CS } from '../world/movement.js';
import { S, G } from './state.js';
import { settings } from './settings.js';
import { rule, timescale, godMode, moveSettings } from './rules.js';
import { clamp } from '../lib/math.js';
import { readInput, takeLookDelta, syncLeaveGuard } from './input.js';
import { bossFire, bossStatus, bossShown, trackSegments, shootAs } from './bosses.js';
import { applyPose, eventsAfter, eventsDuring } from './replay-play.js';
import { replayView } from './replay-view.js';
import { useItems as pressItems } from '../world/items.js';
import { startScenario, hurtPlayer, healPlayer, finish, stageTime, landing } from './session.js';
import { startIfDue, mapRuns, winDue } from '../world/run-engine.js';
import { bossHudHtml } from '../ui/hud.js';
import { formatTime, plural } from '../lib/format.js';
import { getRecord } from './records.js';
import { cameraPosition } from './camera.js';
import { perfFrame } from './perf.js';

let acc = 0;
let last = performance.now();
let prevOrigin = null;

export function resetClock() { last = lastSim = performance.now(); }

// Advance the simulation to `now`. Solo: real time x timescale, and nothing moves while paused. In a round
// (S.mp) the map runs on the wall clock from the round start whatever you do (a server doesn't pause for your
// menu), catching up after a hidden tab, so every client's lasers stay in step; app/coop.js nudges wall0 to
// the server's round clock.
export function simulate(now) {
  const { player, engine, run } = S;
  if (!player || !engine || !run) return;
  // a round's clock starts at the server's go (every player loaded); until then nothing moves
  if (S.mp && !run.go) return;
  if (S.mp && !run.done) {
    const target = Math.floor((now - run.wall0) / 1000 / CS.tick);
    let steps = 0;
    while (run.ticks < target && steps++ < MAX_CATCHUP && S.run === run && !run.done) {
      prevOrigin = [...player.origin];
      step();
    }
    acc = clamp((now - run.wall0) / 1000 - run.ticks * CS.tick, 0, CS.tick);
    return;
  }
  if (S.paused || S.replay?.paused || S.replay?.fast) { lastSim = now; return; } // a replay's pause / seek (app/replay.js)
  // solo: a stage's clock waits until it is loaded and drawn (app/readiness.js: world, models, effects, shaders)
  if (!run.ready) { lastSim = now; return; }
  const realDt = Math.min(0.1, (now - lastSim) / 1000);
  lastSim = now;
  acc += realDt * timescale();
  let steps = 0;
  while (acc >= CS.tick && steps < 8 && S.run === run) {
    acc -= CS.tick;
    steps++;
    prevOrigin = [...player.origin];
    step();
  }
}
const MAX_CATCHUP = 320; // ticks per call (5 s): a long hidden tab catches up over a few calls
let lastSim = performance.now();

const camPos = [0, 0, 0];
const PAUSED_FRAME_MS = 100;
let lastPausedDraw = -Infinity;
export let lastFrameAt = 0; // app/coop.js keeps a round going when frames stop (hidden or throttled tab)
export function frame(now) {
  requestAnimationFrame(frame);
  lastFrameAt = now;
  syncLeaveGuard(); // the tab-close prompt only while a run is live (app/input.js)
  const { player, engine } = S;
  if (!player) return;
  // paused solo (the menu is up, nothing moves): redrawn a few times a second, enough for a setting changed behind
  // the menu, so a paused tab (a second tab, a test tab) stops taking the GPU from the game being played
  if (S.paused && !S.mp && !S.replay) {
    lastSim = now;
    if (now - lastPausedDraw < PAUSED_FRAME_MS) return;
    lastPausedDraw = now;
  }
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (S.paused && !S.mp) lastSim = now;
  simulate(now);
  S.mp?.pump(now);
  // interpolate the camera between ticks
  const live = !S.paused || !!S.mp;
  const a = live ? acc / CS.tick : 1;
  const o = prevOrigin ? prevOrigin.map((v, i) => v + (player.origin[i] - v) * a) : player.origin;
  let eye = [o[0], o[1], o[2] + player.eyeHeight()];
  let view = { yaw: player.yaw, pitch: player.pitch };
  // dead in a round: watch a teammate through their eyes (app/coop.js picks who)
  const spec = S.run?.spectating ? S.mp?.spectateView() : null;
  if (spec) { eye = spec.eye; view = spec; }
  // third person (CS2Fixes !tp): camera behind you, your CT body drawn, no viewmodel (as CS2 does)
  let tp = !!(S.run && settings.thirdPerson && !S.run.spectating);
  // a replay: its own camera (first person, third person or a free camera; app/replay-view.js)
  const rv = S.replay && S.run ? replayView(eye, a, realDt) : null;
  if (rv) { G.renderer.setView(rv.pos, rv.yaw, rv.pitch); tp = rv.body; }
  else G.renderer.setView(cameraPosition(S.world, eye, view.yaw, view.pitch, tp, settings.tpDist), view.yaw, view.pitch);
  G.body?.update({ visible: tp, origin: o, yaw: player.yaw, ducked: player.ducked, duckAmount: player.duckAmount, onGround: player.onGround });
  // your run time this frame, between ticks (as the camera is): each player is drawn their own delay behind it
  G.peers?.update(S.run && S.mp ? S.run.t + (live ? acc : 0) : null, G.renderer.camera, spec?.id);
  G.renderer.showHitboxes = rule('hitboxes'); // a round's are the room's
  G.stream?.update(G.renderer.camera.position.toArray(camPos), G.renderer.lighting?.viewDistance ?? Infinity); // the world's chunks around the camera (Source units)
  G.renderer.lighting?.update(engine, G.renderer.camera); // the map's fog (its own entities + I/O), far Z, the sky
  G.renderer.post?.update(engine); // the post_processing_volume the map's I/O has you in, fading (world/tonemap.js)
  G.renderer.updateEntities(engine ? engine.time + (live ? acc : 0) : 0);
  G.renderer.lighting?.setLights(S.map?.effects?.lights, G.renderer.camera); // particle lights, after the effects' update
  G.renderer.render();
  G.radar?.draw();
  const look = takeLookDelta();
  G.vm.visible = !tp && !S.run?.spectating;
  if (rv && S.replay.gunName && S.replay.gunName !== G.vm.gunName) { G.vm.setGun(S.replay.gunName); G.hud.showWeapons(G.vm.weapon, G.vm.gunName); } // a buy
  if (rv && S.replay.gun !== (G.vm.weapon === 'gun')) { G.vm.setWeapon(S.replay.gun ? 'gun' : 'knife'); G.hud.showWeapons(G.vm.weapon, G.vm.gunName); }
  if (S.run) {
    // the viewmodel keeps animating behind the menu (triggers are released on pause, shots are ignored)
    G.vm.update(Math.max(1e-3, realDt) * timescale(), {
      speed: Math.hypot(player.velocity[0], player.velocity[1]), onGround: player.onGround, ducked: player.ducked, ...look,
    });
    // the same particle lights as the world, at the world's pre-curve exposure (this pass is tone-mapped on its own)
    G.vm.setParticleLights(G.renderer.lighting?.barnUniforms, G.renderer.camera, (G.renderer.post?.uniforms?.cs2Exposure?.value ?? 1) * 2.8);
    G.vm.render(G.renderer.camera.aspect);
  }
  if (rv) G.audio.setListener(rv.pos, rv.yaw, rv.pitch);
  else G.audio.setListener(eye, player.yaw, player.pitch);
  // the frame rate (the meter) and the slow-PC check: only frames of a run being played count (app/perf.js)
  const throttled = S.paused && !S.mp && !S.replay; // the paused redraws above: not the game's pace
  perfFrame(now, { throttled, live: !!S.run && S.run.ready && S.run.go && !S.run.done && !S.run.spectating && !throttled && !S.replay });
  hudClock += realDt;
  if (S.run && hudClock >= 0.05) { hudClock = 0; updateHud(); }
}
let hudClock = 0;

export function step() {
  const { engine, player, world } = S;
  const run = S.run;
  run.t += CS.tick;
  run.ticks++;
  // a replay: what the player did between the last tick and this one (shots, E), as they did it
  if (S.replay) eventsAfter(run.ticks - 1, { shoot: replayShot, use: () => { if (run.items?.length && run.started) pressItems(engine, run.items); } });
  // the countdown (world/run-engine.js COUNTDOWN): the stage starts once it is over
  if (startIfDue(run, run.t)) run.startTick = run.ticks; // a replay's clock (app/replay.js)
  else if (!run.started && Number.isFinite(run.startAt)) {
    // its 3, 2, 1, heard as well as seen (ui/hud.js): CS2's map-pick tick on each new number (not while a replay seeks)
    const n = Math.ceil(run.startAt - run.t - 1e-6);
    if (n !== run.countdownShown && n >= 1 && n <= 3) { run.countdownShown = n; if (!S.replay?.fast) G.audio.play('countdown.tick'); }
  }
  // a spectator's map keeps running (lasers, the boss, the end), without them in it
  if (run.spectating) {
    if (mapRuns(run)) engine.tick(CS.tick); // a mid-map stage holds still through its countdown
    G.renderer.record(engine.time);
    world.dynamic = engine.solids();
    teamAndEnd(run);
    return;
  }
  // CS2's tick order (cs2_server CSource2Server::GameFrame -> the entity simulation, players first): you move first,
  // against the movers where they stood last tick (world.dynamic from the previous tick); then every other entity
  // simulates (movers, thinks) and the one you stand on carries you; then the physics step's touches
  // (CPhysicsGameSystem in ServerPostEntityThink) see everyone's new positions: engine.updateTriggers below.
  const before = player.origin;
  let inp = IDLE;
  if (!S.replay) {
    // window.__lasersInput drives the player in tests: solo only (no bots in a round)
    inp = (!S.mp && window.__lasersInput?.(run.t)) || (S.locked ? readInput() : IDLE);
    player.maxSpeed = G.vm.weapon === 'knife' ? 250 : G.vm.gun.maxSpeed; // CS2's m_flMaxSpeed: knife 250, PP-Bizon 240, AK-47 215
    player.tick(inp, moveSettings());
  }
  const ground = player.groundEntity && player.groundEntity.alive ? player.groundEntity : null;
  const groundBefore = ground ? ground.getWorld().clone() : null;
  if (mapRuns(run)) engine.tick(CS.tick); // a mid-map stage holds still through its countdown
  G.renderer.record(engine.time);
  if (ground && !S.replay) player.ride(ground, groundBefore, ground.getWorld());
  world.dynamic = engine.solids();
  if (S.replay) {
    // where the recorded player stood on this tick (app/replay-play.js); the recording's end is the replay's
    if (!applyPose(run.ticks, player)) { finish('end'); return; }
    eventsDuring(run.ticks, { hurt: hurtPlayer });
    footsteps(IDLE, before);
  } else {
    // the tick's final pose (moved, then carried): what the round's server checks against this tick's solids
    S.mp?.record(run.ticks, player); // a round's server replays your run from these (the anti-cheat)
    run.rec?.pose(run.ticks, player, G.vm.weapon === 'gun'); // your solo run's replay (app/replay-record.js)
    footsteps(inp, before);
  }

  for (const ev of engine.updateTriggers(player)) {
    if (ev.type === 'hurt' && run.started && !run.done) {
      if (ev.first) { run.hits++; G.flash(); G.audio.play('hurt', { pos: player.origin }); }
      hurtPlayer(ev.damage, ev.ent);
    } else if (ev.type === 'heal' && run.started && !run.done) {
      healPlayer(ev.amount);
    } else if (ev.type === 'teleport') {
      // CS2 trigger_teleport without a landmark keeps your momentum, turned with you from your facing to the
      // destination's (porter research 07 §2.2); a fall into a teleport lands still carrying its fall speed
      const turn = ((ev.yaw ?? player.yaw) - player.yaw) * Math.PI / 180;
      const [vx, vy, vz] = player.velocity;
      player.teleport(landing(ev.origin), ev.yaw); // never into the floor or a brush (session.js landing)
      player.velocity = [vx * Math.cos(turn) - vy * Math.sin(turn), vx * Math.sin(turn) + vy * Math.cos(turn), vz];
      // the map sent a human into the zombie cage (world/entities/classes/triggers.js zombieCages): on a server the
      // zombies there infect you. Solo or in a round it is a death (a round makes you a spectator: session.finish)
      // (humans only: a zombie-side player, engine.playerEnt.team 2, belongs there; team filters read the same field)
      if (ev.cage && engine.playerEnt.team === 3 && run.started && !run.done && !godMode()) { run.killedBy = 'cage'; finish('dead'); }
    } else if (ev.type === 'push') {
      for (let i = 0; i < 3; i++) player.baseVelocity[i] += ev.dir[i] * ev.speed;
    }
  }
  if (run.done) return;
  teamAndEnd(run);
  if (run.spectating || run.done) return;
  if (player.origin[2] < -20000) {
    // off the map: solo restarts, a round counts it as a death
    if (S.mp) { run.killedBy = 'void'; finish('dead'); } else if (S.replay) finish('end'); else startScenario(S.scenarioIndex, run.mode);
  }
}

const IDLE = Object.freeze({ forward: 0, side: 0, jump: false, duck: false, walk: false });

// a recorded shot: the same trace on the same tick, and the viewmodel plays it when you watch through their eyes
function replayShot(shot, yaw, pitch) {
  if (S.replay.cam === 'first' && !S.replay.fast) G.vm.playShot?.(shot.kind);
  shootAs(shot, yaw, pitch);
}

// the team's fire, endless repeats and the stage clock: these run for a spectator too
function teamAndEnd(run) {
  const { engine } = S;
  // the team opens fire a second in, after arrival touches (boss HP per human) have landed
  trackSegments();
  if (run.started && engine.time - run.startTime >= 1) bossFire(CS.tick);
  if (run.started && run.endlessTick) run.endlessTick(CS.tick);
  if (winDue(run, run.winAfter)) finish('win');
}

// CS footsteps: silent when walking (shift) or crouched, and below ~135 u/s
function footsteps(inp, before) {
  const { player, run } = S;
  const hs = Math.hypot(player.velocity[0], player.velocity[1]);
  if (!player.onGround || hs <= 135 || inp.walk || player.ducked) return;
  run.stepDist = (run.stepDist || 0) + Math.hypot(player.origin[0] - before[0], player.origin[1] - before[1]);
  if (run.stepDist >= 80) { run.stepDist = 0; G.audio.footstep?.(player.origin); }
}

export function updateHud() {
  const { run, scenario, player } = S;
  if (!run) return;
  G.itemHud?.update();
  const t = run.started ? stageTime() : -(run.startAt - run.t);
  const bosses = [];
  // a boss shows once it has taken damage (bosses.js bossShown: GFL BossHUD)
  for (const b of scenario?.bosses || []) { const s = bossStatus(b); if (s && bossShown(b, s)) bosses.push(s); }
  const sub = [];
  if (!run.ready && run.loading) {
    const [have, need] = G.stream ? G.stream.progress(player.origin) : [0, 0];
    sub.push(have < need ? `${run.loading} ${have}/${need}` : run.loading);
  } else if (S.mp && !run.go) sub.push(S.mp.waitLine());
  if (run.hits) sub.push(plural(run.hits, 'hit'));
  if (player.gravityScale !== 1) sub.push(`gravity ${player.gravityScale}×`);
  if (timescale() !== 1) sub.push(`${timescale()}× speed`);
  const mpLine = S.mp?.hudLine();
  if (mpLine) sub.push(mpLine);
  if (run.endless) {
    const best = getRecord(S.map.name, scenario.id, 'endless');
    sub.push(best ? `best ${formatTime(best.time)}` : 'endless');
  }
  G.hud.update({
    title: (S.replay ? 'REPLAY · ' : '') + (scenario ? scenario.name + (run.endless ? ' · ENDLESS' : '') : 'Free roam'),
    timer: scenario ? (t < 0 ? `starts in ${(-t).toFixed(1)}` : formatTime(t)) : '',
    // 3, 2, 1 big in the middle once the clock runs: loaded and drawn, and in a round everyone in (the server's go)
    countdown: scenario && t < 0 && run.ready && (!S.mp || run.go) ? Math.ceil(-t - 1e-6) : 0,
    sub: sub.join(' · '),
    hp: run.spectating ? (S.mp?.spectateView()?.hp ?? 0) : run.hp, god: godMode(), armor: run.armor, money: run.money,
    spectate: run.spectating ? S.mp?.spectateLabel() : '',
    weapon: G.vm.weapon, gun: G.vm.gunName, clip: G.vm.clip, reserve: G.vm.reserve, reloading: G.vm.reloading,
    bossHtml: bossHudHtml(bosses),
  });
}
