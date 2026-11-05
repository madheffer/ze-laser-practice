// Keyvalue inputs: AddOutput / KeyValue on an entity, and the inputs a map aims at you (!activator / !player).
// Split out of engine.js (EntityEngine.addOutput / playerInput call these with the engine).
import { stripName } from './entity.js';
import { num, parseVec, angleQuat, poseMatrix, rotationOf } from './math.js';

// AddOutput "key value" or "OnX target:input:param:delay:times" (Source 1) or "OnX>target>input>param>delay>times" (CS2)
export function addOutput(engine, e, param) {
  const s = String(param).trim();
  let m = /^(\S+?)(?:\s+|>)(.+)$/.exec(s);
  if (m && /\s/.test(s) && !/^\S+>/.test(s)) m = /^(\S+)\s+(.+)$/.exec(s);
  if (!m) return;
  const [, key, rest] = m;
  const parts = rest.split(/[:>]/);
  if (/^on/i.test(key) || key.toLowerCase() === 'outvalue') {
    if (parts.length >= 2) {
      e.io.push({ output: key, target: parts[0], input: parts[1], param: parts[2] || '', delay: num(parts[3]), times: parts[4] != null ? num(parts[4], -1) : -1 });
      return;
    }
  }
  const k = key.toLowerCase();
  if (k === 'origin') { e.setWorldTransform(poseMatrix(parseVec(rest), rotationOf(e.getWorld()))); return; }
  if (k === 'angles') { e.setWorldTransform(poseMatrix(e.worldOrigin(), angleQuat(parseVec(rest)))); return; }
  e.kv[k] = rest;
  if (k === 'targetname') engine.rename(e, rest);
  if (k === 'speed' && e.state.speed != null) e.state.speed = num(rest);
}

// Inputs aimed at you. Maps change a human's gravity, speed and health this way: ze_mist_p's escape-boss
// trigger sets "gravity 0.1", its boss door sets 180 max health.
export function playerInput(engine, q) {
  const inp = q.input.toLowerCase();
  const P = engine.player; // { setHealth, setMaxHealth, setGravity, setSpeed, setVelocity, setDamageFilter }
  const me = engine.playerEnt;
  if (inp === 'addoutput' || inp === 'keyvalue') {
    const m = /^\s*(\S+)\s+(.+)$/.exec(q.param || '');
    if (!m) return;
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'origin') { engine.onTeleportPlayer?.(parseVec(v)); return; }
    if (k === 'gravity') { P?.setGravity(num(v, 1)); return; }
    if (k === 'speed') { P?.setSpeed(num(v, 1)); return; }
    if (k === 'max_health') { P?.setMaxHealth(num(v, 100)); return; }
    if (k === 'health') { P?.setHealth(num(v, 100)); return; }
    if (k === 'absvelocity' || k === 'basevelocity') { P?.setVelocity(parseVec(v)); return; }
    if (k === 'targetname') { me.name = v; me.key = stripName(v); return; }
    engine.warnOnce('player.kv.' + k, `player keyvalue ${k} ignored`);
    return;
  }
  const context = () => String(q.param).split(':')[0].toLowerCase();
  switch (inp) {
    case 'sethealth': P?.setHealth(num(q.param, 100)); return;
    case 'setmaxhealth': P?.setMaxHealth(num(q.param, 100)); return;
    case 'sethealthtoall': return;
    case 'setdamagefilter': P?.setDamageFilter(stripName(q.param)); return;
    case 'addcontext': (me.contexts ||= new Set()).add(context()); return;
    case 'removecontext': me.contexts?.delete(context()); return;
    case 'setfogcontroller': return; // fog is visual only
    case 'ignitelifetime': case 'ignite': return; // zombie items
  }
  engine.warnOnce('player.' + inp, `player input ${q.input} ignored`);
}
