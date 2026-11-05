// trigger_* entities: their inputs, and the per-tick evaluation against the player's hull (touch outputs,
// hurt, push, teleport). The engine calls updateTriggers / untouch / passesFilter from here.
import * as THREE from 'three';
import { boxTouchesHull } from '../../collision.js';
import { register } from '../registry.js';
import { DEG, num, bool, parseVec, angleForward } from '../math.js';

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

const TOUCH_CLASSES = ['trigger_hurt', 'trigger_multiple', 'trigger_once', 'trigger_push', 'trigger_teleport'];
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

// HurtEntity: one hurt (or heal) to the player. Always counts as a hurt, like the binary's return value.
function hurtPlayer(engine, e, dmg, events) {
  const s = e.state;
  const first = !s.hurtOnce;
  s.hurtOnce = true;
  s.hurtThisCycle = true;
  if (dmg < 0) events.push({ type: 'heal', ent: e, amount: -dmg });
  else if (dmg > 0) events.push({ type: 'hurt', ent: e, damage: dmg, first });
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

export function untouch(engine, e, events = pending(engine)) {
  if (engine.touching.has(e)) {
    engine.touching.delete(e);
    // EndTouch: not hurt this cycle -> half the current damage on the way out (before BaseClass's OnEndTouch)
    if (e.cls === 'trigger_hurt' && !e.state.hurtThisCycle && passesFilter(engine, e)) {
      hurtPlayer(engine, e, currentDamage(e) * 0.5, events);
    }
    e.fireOutput('OnEndTouch', engine.playerEnt);
  }
}

// ------------------------------------------------------------------ filters

export function passesFilter(engine, e) {
  const fname = e.kv.filtername;
  if (!fname) return true;
  const f = engine.findOne(fname);
  if (!f) return true;
  const neg = bool(f.kv.negated);
  let pass = true;
  if (f.cls === 'filter_activator_team') pass = num(f.kv.filterteam) === engine.playerEnt.team;
  else if (f.cls === 'filter_activator_class') pass = String(f.kv.filterclass).toLowerCase() === 'player';
  else if (f.cls === 'filter_activator_context') {
    const want = String(f.kv.responsecontext || '').split(':')[0].toLowerCase();
    pass = !!engine.playerEnt.contexts?.has(want);
  }
  else return true; // name filters: a training run treats you as the human those lasers are for
  return neg ? !pass : pass;
}

// ------------------------------------------------------------------ per tick

// Called every tick with the player's hull. Fires touch outputs; returns hurt/heal/push/teleport events.
export function updateTriggers(engine, player) {
  const c = player.centre();
  const h = player.half();
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
        }
        if (cls === 'trigger_hurt') e.state.hurtOnce = false; // a new touch counts as a new hit
        if (cls === 'trigger_teleport') {
          const dest = engine.findOne(e.kv.target);
          if (dest) events.push({ type: 'teleport', origin: dest.worldOrigin(), yaw: new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(dest.getWorld()), 'ZYX').z / DEG });
        }
      } else if (!inside && was) {
        untouch(engine, e, events);
      }
      if (cls === 'trigger_hurt') {
        const s = e.state;
        // Touch: start HurtThink now unless it is already running
        if (inside && s.thinkAt == null) s.thinkAt = engine.time;
        if (s.thinkAt != null && engine.time + EPS >= s.thinkAt) hurtThink(engine, e, inside, events);
      }
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
