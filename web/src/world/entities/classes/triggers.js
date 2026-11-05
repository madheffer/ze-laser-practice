// trigger_* entities: their inputs, and the per-tick evaluation against the player's hull (touch outputs,
// hurt, push, teleport). The engine calls updateTriggers / untouch / passesFilter from here.
import * as THREE from 'three';
import { boxTouchesHull } from '../../collision.js';
import { register } from '../registry.js';
import { DEG, num, bool, parseVec, angleForward } from '../math.js';
import { nameMatches } from '../../../lib/names.js';
import { explosionSound } from '../sound.js';

const triggerBase = {
  input(e, inp, p, act) {
    switch (inp) {
      case 'enable': if (!e.enabled) { e.enabled = true; } return true;
      case 'disable': e.enabled = false; e.engine.untouch(e); return true;
      case 'toggle': return triggerBase.input(e, e.enabled ? 'disable' : 'enable', p, act);
      // a new damage also becomes damage model 1's base (m_flOriginalDamage)
      case 'sethurtdamage': case 'setdamage': e.kv.damage = p; e.state.curDamage = undefined; return true;
      case 'setpushspeed': e.kv.speed = p; return true;
    }
  },
};
for (const k of ['trigger_multiple', 'trigger_once', 'trigger_hurt', 'trigger_push', 'trigger_teleport', 'trigger_gravity', 'trigger_look']) {
  register(k, { trigger: true, input: triggerBase.input });
}

const TOUCH_CLASSES = ['trigger_hurt', 'trigger_multiple', 'trigger_once', 'trigger_push', 'trigger_teleport', 'trigger_gravity'];
const EPS = 1e-6;

// ------------------------------------------------------------------ trigger_hurt
//
// CS2's CTriggerHurt, from its server binary (cs2map porter research, 07_RUNTIME_SEMANTICS.md 5.1):
//  - Touch starts HurtThink right away if it isn't running (so you are hurt on the touching tick).
//  - HurtThink = HurtAllTouchers(dt = 0.5); nobody hurt -> the think stops; else the next think is in 0.5 s,
//    or the next tick with `thinkalways` (dt stays 0.5, so that is 0.5 x damage EVERY tick).
//  - damagemodel 0: each hurt = damage * dt (damage is per second: damage/2 every 0.5 s).
//    damagemodel 1 ("double forgiveness"): the FULL current damage per hurt, doubled after each hurting
//    pass up to `damagecap`, back to `damage` once `forgivedelay` s (default 3) pass without hurting.
//  - EndTouch: a toucher not hurt in the current cycle takes 0.5 x current damage on leaving.
//  - HurtEntity: negative damage heals (TakeHealth); OnHurtPlayer / OnHurt fire for every hurt.
// One player here, so "the touchers" is you or nobody, and "hurt this cycle" is one flag.

function baseDamage(e) { return num(e.kv.damage, 10); }
function currentDamage(e) {
  const s = e.state;
  if (num(e.kv.damagemodel) !== 1) return baseDamage(e);
  if (s.curDamage == null) s.curDamage = baseDamage(e);
  return s.curDamage;
}

// Your damage filter (SetDamageFilter on you): a filter_damage_type lets through damage whose type shares a bit with
// its damagetype, the other way round when negated (Source FilterDamageType). ze_ffxii_westersand_v8 hands out
// burn / club / shock immunity this way (Filter_Damage_*_Ignore: 8 / 128 / 256, negated). Other filter classes pass.
export function playerTakesDamage(engine, damageType) {
  const name = engine.playerEnt.damageFilter;
  const f = name ? engine.findOne(name) : null;
  if (!f || f.cls !== 'filter_damage_type') return true;
  const hit = (num(damageType) & num(f.kv.damagetype)) !== 0;
  return String(f.kv.negated) === '1' || String(f.kv.negated).toLowerCase() === 'true' ? !hit : hit;
}

// HurtEntity: one hurt (or heal) to the player. Always counts as a hurt, like the binary's return value; damage your
// damage filter turns away does nothing (healing is never filtered).
function hurtPlayer(engine, e, dmg, events) {
  const s = e.state;
  const first = !s.hurtOnce;
  s.hurtOnce = true;
  s.hurtThisCycle = true;
  if (dmg < 0) events.push({ type: 'heal', ent: e, amount: -dmg });
  else if (dmg > 0 && playerTakesDamage(engine, e.kv.damagetype)) events.push({ type: 'hurt', ent: e, damage: dmg, first });
  e.fireOutput('OnHurtPlayer', engine.playerEnt);
  e.fireOutput('OnHurt', engine.playerEnt);
}

// HurtAllTouchers(0.5): returns how many were hurt (0 or 1).
function hurtAllTouchers(engine, e, inside, events) {
  const s = e.state;
  const model1 = num(e.kv.damagemodel) === 1;
  s.hurtThisCycle = false; // m_hurtEntities.RemoveAll()
  if (model1 && s.curDamage != null && engine.time > (s.resetAt ?? -Infinity) + EPS) s.curDamage = baseDamage(e); // forgiven
  const dmg = model1 ? currentDamage(e) : baseDamage(e) * 0.5;
  let hurt = 0;
  if (inside) { hurtPlayer(engine, e, dmg, events); hurt = 1; }
  if (model1 && hurt) {
    const cap = num(e.kv.damagecap, 20);
    s.curDamage = Math.min(s.curDamage * 2, cap);
    s.resetAt = engine.time + num(e.kv.forgivedelay, 3);
  }
  return hurt;
}

function hurtThink(engine, e, inside, events) {
  const s = e.state;
  if (hurtAllTouchers(engine, e, inside, events) < 1) { s.thinkAt = null; return; }
  s.thinkAt = engine.time + (bool(e.kv.thinkalways) ? 0 : 0.5);
}

// Hurt events raised outside updateTriggers (a trigger killed or disabled under you ends its touch during the
// I/O queue); they go out with the next updateTriggers.
function pending(engine) { return (engine._triggerEvents ||= []); }
// an event for the player from outside a trigger (beams.js: env_laser / point_hurt), delivered with the next updateTriggers
export function queueEvent(engine, ev) { pending(engine).push(ev); }

export function untouch(engine, e, events = pending(engine)) {
  if (engine.touching.has(e)) {
    engine.touching.delete(e);
    // EndTouch: not hurt this cycle -> half the current damage on the way out (before BaseClass's OnEndTouch)
    if (e.cls === 'trigger_hurt' && !e.state.hurtThisCycle && passesFilter(engine, e)) {
      hurtPlayer(engine, e, currentDamage(e) * 0.5, events);
    }
    // CS2Fixes' trigger_gravity (entities.cpp, always on): leaving any one sets your gravity back to 1
    if (e.cls === 'trigger_gravity') engine.player?.setGravity(1);
    e.fireOutput('OnEndTouch', engine.playerEnt);
  }
}

// ------------------------------------------------------------------ filters

export function passesFilter(engine, e) {
  return filterPasses(engine, e.kv.filtername);
}

// Does the named filter let the player (a human, team 3) through? No filter / an unknown one passes. Used for trigger
// filternames and for breakables' damagefilter (the shots are always a human's: yours or the simulated team's).
// Name filters test the player's current targetname, which the map sets (westersand's spawn room names every
// human "None", deadcore's meteors tag their target): a scenario starting past those sets it with player.name.
export function filterPasses(engine, fname, depth = 0) {
  if (!fname) return true;
  const f = engine.findOne(fname);
  if (!f || depth > 8) return true; // a filter_multi loop is the map's bug, not a reason to hang
  const neg = bool(f.kv.negated);
  let pass = true;
  if (f.cls === 'filter_activator_team') pass = num(f.kv.filterteam) === engine.playerEnt.team;
  else if (f.cls === 'filter_activator_class') pass = String(f.kv.filterclass).toLowerCase() === 'player';
  else if (f.cls === 'filter_activator_context') {
    const want = String(f.kv.responsecontext || '').split(':')[0].toLowerCase();
    pass = !!engine.playerEnt.contexts?.has(want);
  } else if (f.cls === 'filter_activator_name') {
    pass = nameMatches(f.kv.filtername, engine.playerEnt.name);
  } else if (f.cls === 'filter_multi') {
    // filtertype 0: all of filter01..05 must pass (AND), 1: any (OR); unset slots don't count
    const subs = [1, 2, 3, 4, 5].map((i) => f.kv[`filter0${i}`]).filter(Boolean);
    const results = subs.map((s) => filterPasses(engine, s, depth + 1));
    pass = num(f.kv.filtertype) === 1 ? results.some(Boolean) : results.every(Boolean);
  } else return true;
  return neg ? !pass : pass;
}

// ------------------------------------------------------------------ zombie cages

// Where the map keeps zombies: a teleport destination counts as a zombie cage when the map's own wiring and its naming
// agree, i.e. a zombie-only trigger_teleport (filter_activator_team 2) aims there, statically or through a runtime
// "KeyValue target X", AND its name says so (zombie / cage / zm). Both, because zombies are also sent to where the
// humans are (westersand's TD_Tomb, TD_Ship_Middle: zombie-filtered AND unfiltered teleports, ordinary names).
// A human the map sends into a cage (mist's tp_hellarea, westersand's Teleport_Vulcano sweeping stragglers) is
// infected there on a server: the session counts it as a death. Falls split by team (mist's tp_dragonfall_ct /
// _t, deadcore's des2 that the map keeps moving onto the boss platform) never come here for a human.
const CAGE_NAME = /zombie|cage|(^|[^a-z])zm([^a-z]|$)/i;
export function zombieCages(engine) {
  if (engine._cages) return engine._cages;
  const all = Object.values(engine.lumps).flat();
  const key = (n) => String(n || '').replace(/^\[PR#\]/i, '').toLowerCase();
  const filters = new Map(all.filter((d) => /^filter_/.test(d.kv.classname)).map((d) => [key(d.kv.targetname), d.kv]));
  const zombieOnly = (fname) => {
    const f = filters.get(key(fname));
    return !!f && f.classname === 'filter_activator_team' && num(f.filterteam) === 2 && !bool(f.negated);
  };
  const zTriggers = new Set();
  const targets = new Set();
  for (const d of all) {
    if (d.kv.classname !== 'trigger_teleport' || !zombieOnly(d.kv.filtername)) continue;
    zTriggers.add(key(d.kv.targetname));
    if (d.kv.target) targets.add(key(d.kv.target));
  }
  for (const d of all) for (const c of d.io || []) {
    const m = /^\s*target\s+(\S+)/i.exec(c.param || '');
    if (m && /^(keyvalue|addoutput)$/i.test(c.input) && zTriggers.has(key(c.target))) targets.add(key(m[1]));
  }
  engine._cages = new Set([...targets].filter((t) => CAGE_NAME.test(t)));
  return engine._cages;
}

// game_zone_player: CountPlayersInZone fires OnPlayerInZone / OnPlayerOutZone once per player (you), activator =
// that player, then PlayersInCount / PlayersOutCount with the counts (ze_deadcore's Insane D tests who is outside)
register('game_zone_player', {
  input(e, inp) {
    if (inp !== 'countplayersinzone') return false;
    const ph = e.engine.playerHull;
    const inside = !!ph && (e.hulls() || []).some((hull) => boxTouchesHull(ph.c, ph.h, hull));
    const P = e.engine.playerEnt;
    e.fireOutput(inside ? 'OnPlayerInZone' : 'OnPlayerOutZone', P);
    e.fireOutput('PlayersInCount', P, inside ? 1 : 0);
    e.fireOutput('PlayersOutCount', P, inside ? 0 : 1);
    return true;
  },
});

// env_explosion.Explode (Source CEnvExplosion): radius = iRadiusOverride or iMagnitude × 2.5, damage falls off
// linearly to 0 at the radius, only with a clear world line to you; spawnflags 1 = no damage, without 2
// (repeatable) it is removed after exploding. Blast damage: armor isn't applied, as for the map's other damage
// (README "What the map does to you").
register('env_explosion', {
  input(e, inp) {
    if (inp !== 'explode') return false;
    const engine = e.engine;
    const sf = num(e.kv.spawnflags);
    const mag = num(e.kv.imagnitude, 100);
    const radius = num(e.kv.iradiusoverride) > 0 ? num(e.kv.iradiusoverride) : mag * 2.5;
    explosionSound(e); // unless spawnflag 64 (sound.js)
    const ph = engine.playerHull;
    if (!(sf & 1) && ph && mag > 0 && radius > 0) {
      const o = e.worldOrigin();
      const d = Math.hypot(ph.c[0] - o[0], ph.c[1] - o[1], ph.c[2] - o[2]);
      const clear = !engine.traceBox || engine.traceBox(o, ph.c, [0, 0, 0]).fraction >= 0.999;
      const dmg = mag * (1 - d / radius);
      if (d < radius && clear && dmg > 0) pending(engine).push({ type: 'hurt', ent: e, damage: dmg, first: true });
    }
    if (!(sf & 2)) engine.kill(e);
    return true;
  },
});

// filter_*.TestActivator: OnPass / OnFail for the activator (always you: the only player here)
const filterTest = {
  input(e, inp, p, act) {
    if (inp !== 'testactivator') return false;
    e.fireOutput(filterPasses(e.engine, e.name) ? 'OnPass' : 'OnFail', act);
    return true;
  },
};
for (const k of ['filter_activator_team', 'filter_activator_class', 'filter_activator_context', 'filter_activator_name', 'filter_multi']) register(k, filterTest);

// trigger_multiple's re-fire interval: its `wait`, and 0 means 0.2 s (Source SDK CTriggerMultiple::Spawn)
function multipleWait(e) {
  const w = num(e.kv.wait, 0.2);
  return w > 0 ? w : w < 0 ? Infinity : 0.2; // negative: fires once per touch
}

// ------------------------------------------------------------------ per tick

// Called every tick with the player's hull. Fires touch outputs; returns hurt/heal/push/teleport events.
export function updateTriggers(engine, player) {
  const c = player.centre();
  const h = player.half();
  engine.playerHull = { c, h }; // for game_zone_player's CountPlayersInZone (an input, between ticks)
  const events = pending(engine).splice(0);
  for (const cls of TOUCH_CLASSES) {
    const set = engine.byClass.get(cls);
    if (!set) continue;
    for (const e of set) {
      if (!e.enabled) {
        untouch(engine, e, events);
        // a disabled hurt touches nobody, so its next think hurts nobody and stops
        if (e.state.thinkAt != null && engine.time + EPS >= e.state.thinkAt) { e.state.thinkAt = null; e.state.hurtThisCycle = false; }
        continue;
      }
      const sf = num(e.kv.spawnflags);
      if (!(sf & 1)) continue; // "clients" flag
      const hulls = e.hulls();
      if (!hulls) continue;
      let inside = false;
      for (const hull of hulls) if (boxTouchesHull(c, h, hull)) { inside = true; break; }
      const was = engine.touching.has(e);
      if (inside && !engine.passesFilter(e)) inside = false;
      if (inside && !was) {
        engine.touching.add(e);
        e.fireOutput('OnStartTouch', engine.playerEnt);
        if (cls === 'trigger_multiple' || cls === 'trigger_once') {
          e.fireOutput('OnTrigger', engine.playerEnt);
          if (cls === 'trigger_once') engine.kill(e);
          else e.state.nextTrigger = engine.time + multipleWait(e);
        }
        if (cls === 'trigger_hurt') e.state.hurtOnce = false; // a new touch counts as a new hit
        if (cls === 'trigger_teleport') {
          const dest = engine.findOne(e.kv.target);
          // CS2 takes the first destination with that name (porter research 07 §2.2); `cage`: a zombie cage, the
          // session makes that a death for a human
          if (dest) events.push({ type: 'teleport', origin: dest.worldOrigin(), yaw: new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(dest.getWorld()), 'ZYX').z / DEG, trigger: e, dest, cage: zombieCages(engine).has(dest.key) });
        }
      } else if (!inside && was) {
        untouch(engine, e, events);
      } else if (inside && cls === 'trigger_multiple' && engine.time + EPS >= (e.state.nextTrigger ?? 0)) {
        // Source's CTriggerMultiple touches every frame and re-fires OnTrigger each `wait` while you stay inside
        // (ze_deadcore's cube thrusters stay on this way, ze_mist_p's dragon keeps turning to its target)
        e.fireOutput('OnTrigger', engine.playerEnt);
        e.state.nextTrigger = engine.time + multipleWait(e);
      }
      if (cls === 'trigger_hurt') {
        const s = e.state;
        // Touch: start HurtThink now unless it is already running
        if (inside && s.thinkAt == null) s.thinkAt = engine.time;
        if (s.thinkAt != null && engine.time + EPS >= s.thinkAt) hurtThink(engine, e, inside, events);
      }
      // CS2Fixes' trigger_gravity (entities.cpp TriggerGravityHandler, always on): while you touch it your gravity scale
      // is its "gravity" key (vanilla CS2 applies a wrong scale, which is why CS2Fixes replaces the touch)
      if (inside && cls === 'trigger_gravity' && e.kv.gravity != null) engine.player?.setGravity(parseFloat(e.kv.gravity) || 0);
      if (inside && cls === 'trigger_push') {
        const dir = angleForward(parseVec(e.kv.pushdir));
        // pushdir is in the trigger's space unless it is world-aligned; rotate by the entity
        const q = new THREE.Quaternion().setFromRotationMatrix(e.getWorld());
        const v = new THREE.Vector3(...dir).applyQuaternion(q);
        events.push({ type: 'push', dir: [v.x, v.y, v.z], speed: num(e.kv.speed, 100) });
      }
    }
  }
  return events;
}
