// Keyvalue inputs: AddOutput / KeyValue on an entity, and the inputs a map aims at you (!activator / !player).
// Split out of engine.js (EntityEngine.addOutput / playerInput call these with the engine).
import { stripName } from './entity.js';
import { setPlayerFog } from './classes/fog.js';
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

// CS2's KeyValues input: "key value key value ...", a vector key taking its three numbers (ze_gris_p: 379 of them,
// e.g. the stage 4 boss's under-platform hurt sends a falling human back up with KeyValues(origin x y z)).
const VECTOR_KEYS = new Set(['origin', 'angles', 'basevelocity', 'absvelocity', 'velocity', 'rendercolor', 'scales', 'movedir']);
export function splitKeyValues(param) {
  const t = String(param ?? '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < t.length;) {
    const k = t[i++];
    if (i >= t.length) break;
    if (VECTOR_KEYS.has(k.toLowerCase())) { out.push(`${k} ${t.slice(i, i + 3).join(' ')}`); i += 3; } else out.push(`${k} ${t[i++]}`);
  }
  return out;
}

// Inputs aimed at you. Maps change a human's gravity, speed and health this way: ze_mist_p's escape-boss
// trigger sets "gravity 0.1", its boss door sets 180 max health.
export function playerInput(engine, q) {
  const inp = q.input.toLowerCase();
  const P = engine.player; // { setHealth, setMaxHealth, setGravity, setSpeed, setVelocity, setDamageFilter }
  const me = engine.playerEnt;
  if (inp === 'keyvalues') { for (const kv of splitKeyValues(q.param)) playerInput(engine, { ...q, input: 'KeyValue', param: kv }); return; }
  if (inp === 'addoutput' || inp === 'keyvalue') {
    const m = /^\s*(\S+)\s+(.+)$/.exec(q.param || '');
    if (!m) return;
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'origin') { engine.onTeleportPlayer?.(parseVec(v)); return; }
    if (k === 'gravity') { P?.setGravity(num(v, 1)); return; }
    if (k === 'speed') { P?.setSpeed(num(v, 1)); return; }
    // CS2Fixes' custom keyvalue (customio.cpp AddOutputCustom_RunSpeed): the pawn's m_flVelocityModifier, a multiplier on
    // your max run speed (GFL's stripper uses it for deadcore's B ending instead of "speed", which scales all movement)
    if (k === 'runspeed') { P?.setRunSpeed?.(num(v, 1)); return; }
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
    case 'setfogcontroller': setPlayerFog(engine, q.param); return; // which fog you see (classes/fog.js)
    case 'ignitelifetime': case 'ignite': return; // zombie items
  }
  engine.warnOnce('player.' + inp, `player input ${q.input} ignored`);
}
