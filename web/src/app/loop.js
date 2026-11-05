// The frame loop (render every frame, camera interpolated) and the 64-tick simulation step.
import { CS } from '../world/movement.js';
import { S, G } from './state.js';
import { settings } from './settings.js';
import { readInput, takeLookDelta } from './input.js';
import { bossFire, bossStatus, trackSegments } from './bosses.js';
import { startScenario, fireStart, hurtPlayer, healPlayer, finish, stageTime } from './session.js';
import { bossHudHtml } from '../ui/hud.js';
import { formatTime, plural } from '../lib/format.js';
import { getRecord } from './records.js';
import { cameraPosition } from './camera.js';

let acc = 0;
let last = performance.now();
let prevOrigin = null;

export function resetClock() { last = performance.now(); }

export function frame(now) {
  requestAnimationFrame(frame);
  const { player, engine, run } = S;
  if (!player) return;
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (engine && run && !S.paused) {
    acc += realDt * settings.timescale;
    let steps = 0;
    while (acc >= CS.tick && steps < 8) {
      acc -= CS.tick;
      steps++;
      prevOrigin = [...player.origin];
      step();
    }
  }
  // interpolate the camera between ticks
  const a = S.paused ? 1 : acc / CS.tick;
  const o = prevOrigin ? prevOrigin.map((v, i) => v + (player.origin[i] - v) * a) : player.origin;
  const eye = [o[0], o[1], o[2] + player.eyeHeight()];
  // third person (CS2Fixes !tp): camera behind you, your CT body drawn, no viewmodel (as CS2 does)
  const tp = !!(S.run && settings.thirdPerson);
  G.renderer.setView(cameraPosition(S.world, eye, player.yaw, player.pitch, tp, settings.tpDist), player.yaw, player.pitch);
  G.body?.update({ visible: tp, origin: o, yaw: player.yaw, ducked: player.ducked, duckAmount: player.duckAmount, onGround: player.onGround });
  G.renderer.updateEntities(engine ? engine.time + (S.paused ? 0 : acc) : 0);
  G.renderer.render();
  const look = takeLookDelta();
  G.vm.visible = !tp;
  if (S.run) {
    // the viewmodel keeps animating behind the menu (triggers are released on pause, shots are ignored)
    G.vm.update(Math.max(1e-3, realDt) * settings.timescale, {
      speed: Math.hypot(player.velocity[0], player.velocity[1]), onGround: player.onGround, ducked: player.ducked, ...look,
    });
    G.vm.render(G.renderer.camera.aspect);
  }
  G.audio.setListener(eye, player.yaw, player.pitch);
  hudClock += realDt;
  if (S.run && hudClock >= 0.05) { hudClock = 0; updateHud(); }
}
let hudClock = 0;

export function step() {
  const { engine, player, world } = S;
  const run = S.run;
  run.t += CS.tick;
  if (!run.started && run.t >= run.startAt) {
    run.started = true;
    run.startTime = engine.time;
    fireStart();
  }
  const ground = player.groundEntity && player.groundEntity.alive ? player.groundEntity : null;
  const groundBefore = ground ? ground.getWorld().clone() : null;
  engine.tick(CS.tick);
  G.renderer.record(engine.time);
  if (ground) player.ride(ground, groundBefore, ground.getWorld());
  world.dynamic = engine.solids();
  const inp = window.__lasersInput?.(run.t) || (S.locked ? readInput() : { forward: 0, side: 0, jump: false, duck: false, walk: false });
  player.maxSpeed = G.vm.weapon === 'knife' ? 250 : 215; // CS2: knife 250, AK-47 215
  const before = player.origin;
  player.tick(inp, settings);
  footsteps(inp, before);

  for (const ev of engine.updateTriggers(player)) {
    if (ev.type === 'hurt' && run.started && !run.done) {
      if (ev.first) { run.hits++; G.flash(); G.audio.play('hurt', { pos: player.origin }); }
      hurtPlayer(ev.damage, ev.ent);
    } else if (ev.type === 'heal' && run.started && !run.done) {
      healPlayer(ev.amount);
    } else if (ev.type === 'teleport') {
      player.teleport(ev.origin, ev.yaw);
    } else if (ev.type === 'push') {
      for (let i = 0; i < 3; i++) player.baseVelocity[i] += ev.dir[i] * ev.speed;
    }
  }
  if (run.done) return;
  // the team opens fire a second in, after arrival touches (boss HP per human) have landed
  trackSegments();
  if (run.started && engine.time - run.startTime >= 1) bossFire(CS.tick);
  if (run.started && run.endlessTick) run.endlessTick(CS.tick);
  if (run.started && run.winAfter && engine.time - run.startTime >= run.winAfter) finish('win');
  if (player.origin[2] < -20000) startScenario(S.scenarioIndex, run.mode);
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
  const t = run.started ? stageTime() : -(run.startAt - run.t);
  const bosses = [];
  for (const b of scenario?.bosses || []) { const s = bossStatus(b); if (s) bosses.push(s); }
  const sub = [];
  if (run.hits) sub.push(plural(run.hits, 'hit'));
  if (player.gravityScale !== 1) sub.push(`gravity ${player.gravityScale}×`);
  if (settings.timescale !== 1) sub.push(`${settings.timescale}× speed`);
  if (run.endless) {
    const best = getRecord(S.map.name, scenario.id, 'endless');
    sub.push(best ? `best ${formatTime(best.time)}` : 'endless');
  }
  G.hud.update({
    title: scenario ? scenario.name + (run.endless ? ' · ENDLESS' : '') : 'Free roam',
    timer: scenario ? (t < 0 ? `starts in ${(-t).toFixed(1)}` : formatTime(t)) : '',
    sub: sub.join(' · '),
    hp: run.hp, god: settings.god, armor: run.armor,
    weapon: G.vm.weapon, clip: G.vm.clip, reserve: G.vm.reserve, reloading: G.vm.reloading,
    bossHtml: bossHudHtml(bosses),
  });
}
