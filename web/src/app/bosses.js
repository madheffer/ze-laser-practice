// Bosses: the simulated team's fire, your own shots, and the boss HUD numbers.
//
// The rest of the team shoots the boss while it's in sight. Boss HP % is applied as extra hits, so a map that
// counts bullets (OnHealthChanged -> Subtract 1) scales exactly like one that counts health.
import { S, G } from './state.js';
import { fireSound } from './weapon-sounds.js';
import { rule, players } from './rules.js';
import { rayHullEntry } from '../world/collision.js';
import { angleForward, foldPitch } from '../world/entities/index.js';
import { stripPrefix } from '../lib/names.js';
import { clamp } from '../lib/math.js';
import { bossHittable, replayBossFire } from '../world/run-engine.js';
import { bulletWorld, BULLET_MASK } from '../world/bullets.js';

// the static world as bullets see it: the map's particle collision set with layer bits, else the player-solid one
const shotWorld = () => bulletWorld(S.map?.collisionFx, S.world);

// The other humans, as a squad. Each carries a rifle (AK-47: 10 rounds/s, 36 dmg), an SMG (P90: 14.3/s,
// 26 dmg) or just a knife (no boss damage), lands about half its rounds, and is only firing part of the time:
// ~80% when calm, ~55% while lasers / attacks are out (they're dodging), with a slow random swing on top so
// damage comes in waves. ze_mist_p's dragon gets 900 HP per human per segment, so the fight length doesn't
// depend on how many humans: this mix gives ~2.5 minutes. "Perfect team" = everyone always firing.
const SQUAD = [
  { share: 0.55, rate: 10, damage: 36 }, // rifles
  { share: 0.35, rate: 14.3, damage: 26 }, // SMGs
  { share: 0.10, rate: 0, damage: 0 }, // knife out
];
const ACCURACY = 0.5;
const DUTY_CALM = 0.8, DUTY_ATTACK = 0.55;
const DAMAGE_PER_HIT = 30; // your own shots' fallback, and the perfect team's
const PERFECT_HITS_PER_HUMAN = 5;

export function eyePos() {
  const p = S.player;
  return [p.origin[0], p.origin[1], p.origin[2] + p.eyeHeight()];
}

export function bossTargets(list = S.scenario?.bosses) {
  const { engine, run } = S;
  const out = [];
  for (const b of list || []) {
    // "after": seconds into the stage before this boss can be shot (fast-forward only)
    if (b.after && engine.time - (run.ffStart ?? 0) < b.after) continue;
    for (const e of engine.find(b.target)) if (e.alive && e.state.health != null) out.push({ e, b });
  }
  return out;
}

// Can the team see it? A world ray from your eye to the middle of its hull (8192 u max).
function bossVisible(e) {
  if (S.run?.spectating) return true; // the leader is dead: the rest of the team still fights
  const hs = e.hulls();
  if (!hs?.length) return false;
  const h = hs[0];
  const c = [(h.min[0] + h.max[0]) / 2, (h.min[1] + h.max[1]) / 2, (h.min[2] + h.max[2]) / 2];
  const eye = eyePos();
  const d = Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]);
  if (d > 8192) return false;
  return shotWorld().traceRay(eye, c, undefined, true, BULLET_MASK).fraction >= 0.999;
}


// how: 'me' (your shot), 'team' (the simulated team), 'replay' (a fast-forward, the same on every client)
function hitBoss(e, damage, how = 'me') {
  if (!bossHittable(e)) return false;
  // in a round, boss damage goes through the server, which sends everyone's (capped) hits back to all clients
  if (S.mp && how !== 'replay') { S.mp.bossHit(e, damage, how === 'team'); return true; }
  applyBossDamage(e, damage, how !== 'me');
  return true;
}

// Damage that lands (yours solo; in a round, the hits the server sends back).
export function applyBossDamage(e, damage, byTeam = false) {
  // the team's bullets carry the team as activator (engine.teamEnt), yours carry you. A shot is a trace hit: the
  // breakable's hit sound (world/entities/sound.js hitSound); its RandomInt(0, 1) is rolled here, off the engine's stream
  S.engine.damage(e, damage, byTeam ? S.engine.teamEnt : S.engine.playerEnt, { trace: true, alt: Math.random() < 0.5 });
}

// silent: during a fast-forward replay (shoots the scenario's fastForwardBosses, no line of sight needed)
export function bossFire(dt, silent = false) {
  const { run, scenario } = S;
  // a fast-forward replay: the same on every client and on the server (world/run-engine.js)
  if (silent) { replayBossFire(run, scenario, dt, rule('humans'), rule('bossHp')); return; }
  if (!silent && (!rule('autoFire') || run.endless && scenario.endless?.noBossDamage)) return;
  // in a round the simulated team fires from one client, the round's leader (a replay runs everywhere)
  if (!silent && S.mp && !S.mp.isLeader) return;
  const how = silent ? 'replay' : 'team';
  const targets = silent ? bossTargets(scenario.fastForwardBosses) : bossTargets().filter(({ e }) => bossVisible(e));
  if (!targets.length) return;
  // the simulated team: the humans the boss is scaled for that aren't real players (solo: humans - 1, you shoot with
  // your gun; a round's players shoot their own). None when the boss is scaled to the lobby
  // scenario.shooters: only that many of them are on it (a mini boss a few humans meet, not the whole server)
  const all = silent ? rule('humans') : Math.max(0, rule('humans') - players());
  const team = Number.isFinite(scenario?.shooters) ? Math.min(all, Math.max(0, scenario.shooters)) : all;
  const scale = 100 / Math.max(1, rule('bossHp'));
  let guard = 0;
  if (silent || rule('perfectTeam')) {
    run.fireAcc += team * PERFECT_HITS_PER_HUMAN * scale * dt;
    while (run.fireAcc >= 1 && guard++ < 400) {
      run.fireAcc -= 1;
      for (const { e } of targets) hitBoss(e, DAMAGE_PER_HIT, how);
    }
  } else {
    // slow wave (period ~9 s and ~4 s mixed) so the squad's fire ebbs and surges
    run.waveT = (run.waveT || 0) + dt;
    const wave = 1 + 0.25 * Math.sin(run.waveT * 0.7) + 0.12 * Math.sin(run.waveT * 1.6 + 1.3);
    const duty = (attackActive() ? DUTY_ATTACK : DUTY_CALM) * wave;
    for (const w of SQUAD) {
      if (!w.rate) continue;
      const k = `fire${w.rate}`;
      run[k] = (run[k] || 0) + team * w.share * w.rate * ACCURACY * duty * scale * dt;
      while (run[k] >= 1 && guard++ < 400) {
        run[k] -= 1;
        for (const { e } of targets) hitBoss(e, w.damage, how);
      }
    }
  }
  if (run.fireAcc > 400) run.fireAcc = 0;
}

// Is an attack on? Any map-spawned hurt (lasers, balls, fire) alive and on, within 2000 u of you.
function attackActive() {
  const { engine, player, run } = S;
  if (run.attackCheckT > engine.time) return run.attackOn;
  run.attackCheckT = engine.time + 0.25;
  const p = player.origin;
  run.attackOn = false;
  for (const h of engine.byClass.get('trigger_hurt') || []) {
    if (!h.fromTemplate || !h.alive || !h.enabled) continue;
    const o = h.worldOrigin();
    if (Math.abs(o[0] - p[0]) < 2000 && Math.abs(o[1] - p[1]) < 2000 && Math.abs(o[2] - p[2]) < 1500) { run.attackOn = true; break; }
  }
  return run.attackOn;
}

// A shot from the viewmodel (bullet or knife): trace it against the world and the bosses.
export function onShot(shot) {
  const { run, engine, player } = S;
  if (!run || S.paused || run.done || run.spectating || !engine || S.replay) return;
  // it leaves along your view + the aim punch it was fired with (lib/recoil.js); a replay and the co-op server redo it
  // from that direction, so neither needs the recoil itself
  const p = shot.punch || [0, 0];
  // CS2 doesn't clamp eye + punch: past straight up the shot goes on over the top, kept as a pitch inside +-90
  const [pitch, yaw] = foldPitch(player.pitch + p[0], player.yaw + p[1]);
  run.rec?.shot(run.ticks, shot, yaw, pitch); // its replay redoes it on the same tick (app/replay-play.js)
  shootAs(shot, yaw, pitch);
}

// the shot itself, fired along yaw / pitch from the player's eye (a replay passes the recorded view)
export function shootAs(shot, yaw, pitch) {
  const { run, engine, player, scenario } = S;
  if (!run || run.done || !engine) return;
  G.audio.play(shot.kind === 'bullet' ? fireSound(shot.gun) : shot.kind === 'stab' ? 'knife.stab' : 'knife.slash', { pos: player.origin });
  const noDamage = run.endless && scenario?.endless?.noBossDamage;
  const dir = angleForward([pitch, yaw, 0]);
  const eye = eyePos();
  const range = shot.range || 8192;
  // CS2's bullet trace (world/bullets.js): player clips don't stop it (knife too: the same static world here)
  const wallTr = shotWorld().traceRay(eye, eye.map((v, i) => v + dir[i] * range), undefined, true, BULLET_MASK);
  const wallDist = wallTr.fraction * range;
  for (const { e } of bossTargets()) {
    for (const h of e.hulls() || []) {
      const t = rayHullEntry(eye, dir, h);
      if (t == null || t > Math.min(range, wallDist + 1)) continue;
      if (!noDamage) {
        const n = Math.max(1, Math.round(100 / Math.max(1, rule('bossHp'))));
        let landed = false;
        for (let k = 0; k < n; k++) landed = hitBoss(e, shot.damage || DAMAGE_PER_HIT) || landed;
        if (landed) { run.myHits++; run.myDamage += shot.damage || DAMAGE_PER_HIT; G.hitmark(); }
      }
      if (shot.kind !== 'bullet') G.audio.play('knife.hit', { pos: player.origin });
      return;
    }
  }
  if (shot.kind !== 'bullet' && wallTr.fraction < 1) G.audio.play('knife.hitwall', { pos: player.origin });
  // a bullet that hit no boss: the surface it hits plays its bullet impact sound there (world/impacts.js)
  if (shot.kind === 'bullet') { const hit = G.impacts?.hit(eye, dir, range); if (hit) G.audio.bulletImpact(hit.hash, hit.pos); }
}

// Every tick: remember each segmented boss's segment size (the most its health + offset has held, ignoring
// the spawn placeholder), so the bar reads right even between HUD redraws.
export function trackSegments() {
  const { engine, run } = S;
  for (const b of S.scenario?.bosses || []) {
    if (!b.counter || b.counterMode === 'hits') continue;
    const e = engine.findOne(b.target);
    // above half of spawn health = the spawn placeholder (the map has not set the first segment yet)
    if (!e?.alive || e.state.health == null || e.state.health > e.state.max * 0.5) continue;
    const cur = e.state.health + (b.offset || 0);
    run.segMax ||= new Map();
    if (cur > (run.segMax.get(b.target) || 0)) run.segMax.set(b.target, cur);
  }
}

// A BossHUD iterator's segments left, counting this one (gflze/CS2-ZE-Configs bosshud/template.jsonc "iterator",
// "reverseiterator"): a reversed one counts up to its max (westersand's Boss_Overlay_Counter: set to 1, +1 per
// emptied segment, OnHitMax at 7 ends the boss), a plain one down to its min. null: no iterator entity.
// UNSETTLED: the BossHUD plugin source is not public; this reading matches the HP the map's logic has left.
function segmentsLeft(b) {
  const it = S.engine.findOne(b.iterator);
  const s = it?.state;
  if (s?.v == null) return null;
  return b.reverseIterator ? (s.max ?? s.v) - s.v : s.v - (s.min ?? 0);
}

// Boss HP the way CS2Fixes BossHUD computes it. A segmented boss (counter of segments + a breakable that
// refills each segment, ze_mist's "BreakableHPBar") shows (segments left - 1) x segment HP + this segment;
// a hit-counted boss shows the counter; a plain breakable shows its health.
export function bossStatus(b) {
  const { engine, run } = S;
  const e = engine.findOne(b.target);
  const c = b.counter ? engine.findOne(b.counter) : null;
  if (!e?.alive && !(c?.alive)) return null;
  let hp, peak;
  const off = b.offset || 0; // BossHUD's "offset": health below it isn't real boss HP (mist dragon: -10000)
  const segs = b.iterator && c?.state.v != null ? segmentsLeft(b) : null;
  if (segs != null) {
    // BossHUD counter + iterator (+ backup): the counter is this segment, the iterator counts segments and the backup
    // holds what the map refills the counter to (westersand's Boss_Health / Boss_Overlay_Counter / Boss_Health_Init:
    // 6 refills of 50 + 15 per human). Shown as the HP actually left: (segments left - 1) x refill + this segment.
    const bk = b.backup ? engine.findOne(b.backup) : null;
    const refill = bk?.state.v ?? Math.max(c.state.v, run.bossPeak.get(b.counter) || 0);
    if (!bk) run.bossPeak.set(b.counter, refill);
    hp = segs <= 0 ? 0 : (segs - 1) * refill + Math.max(0, c.state.v + off); // 0 left: the iterator ended the boss
  } else if (b.counterMode === 'hits' && c?.state.v != null) hp = c.state.v;
  else if (c?.state.v != null && e?.state.health != null) {
    // BreakableHPBar: (segments left - 1) x segment HP + this segment's (health + offset). The segment's size
    // is the most it has held (the map tops it up to the same amount every segment).
    const cur = Math.max(0, e.state.health + off);
    const seg = run.segMax?.get(b.target) || cur;
    hp = Math.max(0, c.state.v - 1) * seg + Math.min(cur, seg);
    peak = Math.max(c.state.max || c.state.v, c.state.v) * seg;
  } else if (e?.state.health != null) hp = Math.max(0, e.state.health + off);
  else return null;
  if (peak == null) {
    peak = Math.max(run.bossPeak.get(b.target) || 0, hp);
    run.bossPeak.set(b.target, peak);
  }
  return { name: b.name || stripPrefix(b.target), hp: Math.round(hp), pct: Math.round(clamp((hp / Math.max(1, peak)) * 100, 0, 100)) };
}

// Whether a boss shows on the HUD (GFL's BossHUD, gflze/CS2-ZE-Configs bosshud/template.jsonc): it appears once the boss
// takes damage, i.e. once its HP has gone down, so a boss the map keeps unhittable (a damage filter, an entrance
// animation before its breakable or counter accepts hits) stays off the HUD until the map lets it be hurt. The
// template's "timeout" (s without damage before it hides again; 0 = stays) is read from the stage's boss entry.
// UNSETTLED: the BossHUD plugin source is not public; this follows the config schema's documented keys.
export function bossShown(b, status) {
  const run = S.run;
  if (!run || !status) return false;
  const seen = (run.bossHud ||= new Map());
  let st = seen.get(b.target);
  if (!st) seen.set(b.target, (st = { hp: status.hp, hitAt: null }));
  if (status.hp < st.hp) st.hitAt = S.engine?.time ?? 0;
  st.hp = status.hp;
  if (st.hitAt == null) return false;
  const timeout = Number(b.timeout) || 0;
  return !(timeout > 0 && (S.engine?.time ?? 0) - st.hitAt > timeout);
}
