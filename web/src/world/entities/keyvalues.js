// Keyvalue inputs: AddOutput / KeyValue(s) on an entity, and the inputs a map aims at you (!activator / !player).
// Split out of engine.js (EntityEngine.addOutput / keyValue / playerInput call these with the engine).
//
// What a GFL server (CS2 + CS2Fixes) does with them:
//   AddOutput   CS2's own input, which CS2Fixes leaves alone. server.dll takes only the output form and rejects the rest:
//               "AddOutput fired with bad string. Format: outputname>targetname>inputname>parameter>delay>max times to
//               fire (-1 == infinite)" (strings at 0x1a5b680 / 0x1a5b638 in the 2026-11-05 build; the parser itself
//               is not decompiled yet, so "at least output>target>input" is our reading). Source 1's "key value" and
//               "OnX target:input:..." forms do nothing in CS2.
//   KeyValue(s) CS2Fixes takes both over completely (detours.cpp Detour_CEntityIdentity_AcceptInput: any input whose
//               name starts with "KeyValue" goes to customio.cpp CustomIO_HandleInput and never reaches CS2). The text
//               is split on single spaces; the first token must be one of the keys below and the token count must be
//               exactly right, else nothing happens (so a KeyValues with several pairs does nothing). A key whose
//               entity class doesn't match is swallowed. Always on: no cvar.
import { stripName } from './entity.js';
import { setPlayerFog } from './classes/fog.js';
import { num, parseVec, angleQuat, poseMatrix, rotationOf } from './math.js';
import { ignitePlayer } from './burn.js';

export function addOutput(engine, e, param) {
  const s = String(param ?? '');
  const p = s.split('>');
  const output = p[0].trim();
  if (p.length < 3 || !output || /\s/.test(output) || !p[2].trim()) {
    engine.warnOnce(`addoutput:${s.slice(0, 40)}`, `AddOutput "${s.slice(0, 60)}" does nothing in CS2 (only output>target>input>param>delay>times)`);
    return;
  }
  const times = p[5] != null && p[5].trim() !== '' ? num(p[5], -1) : -1;
  e.io.push({ output, target: p[1], input: p[2], param: p[3] ?? '', delay: num(p[4]), times });
}

// Source 1 (a CS:GO / CS:S map, entities.json "engine": "source1"): CBaseEntity::InputAddOutput splits at the first
// space, turns every ':' in the rest into ',' and hands both to KeyValue. An output name's value is then an event
// ("target,input,param,delay,times": missing fields empty, delay 0, times -1); any other key is a keyvalue: origin /
// angles are the local ones (CBaseEntity::KeyValue), targetname renames, health / max_health set the numbers, the
// rest (message, renderamt, ...) is stored on the entity.
export function addOutputSource1(engine, e, param) {
  const s = String(param ?? '');
  const sp = s.indexOf(' ');
  if (sp <= 0) { engine.warnOnce(`addoutput1:${s.slice(0, 40)}`, `AddOutput "${s.slice(0, 60)}" has no value`); return; }
  const key = s.slice(0, sp), value = s.slice(sp + 1).replace(/:/g, ',');
  if (/^(on|out)/i.test(key)) {
    const p = value.split(',');
    e.io.push({ output: key, target: p[0] ?? '', input: p[1] ?? '', param: p[2] ?? '', delay: atof(p[3] ?? ''), times: p[4] != null && p[4].trim() !== '' ? atoi(p[4]) : -1 });
    return;
  }
  const k = key.toLowerCase();
  switch (k) {
    case 'origin': e.pos.set(...parseVec(value).map((v) => clampN(v, -16384, 16384))); engine.moved(e); return;
    case 'angles': angleQuat(parseVec(value), e.quat); engine.moved(e); return;
    case 'targetname': e.kv.targetname = value; engine.rename(e, value); return;
    case 'health': { const h = clampN(atoi(value), 0, INT_MAX); e.kv.health = String(h); if (e.state.health != null) e.state.health = h; return; }
    case 'max_health': { const h = clampN(atoi(value), 0, INT_MAX); e.kv.max_health = String(h); if (e.state.max != null) e.state.max = Math.max(1, h); return; }
    default: e.kv[k] = value;
  }
}

// C's atoi / atof as CS2Fixes uses them (Q_atoi / Q_atof): leading number, else 0
const atoi = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };
const atof = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const vec = (t, lim) => [atof(t[1]), atof(t[2]), atof(t[3])].map((v) => clampN(v, -lim, lim));
const INT_MAX = 2147483647;

// customio.cpp s_AddOutputHandlers: key -> token count (key included); `only` = the entity classes it acts on
const KEYS = {
  targetname: { n: 2 }, origin: { n: 4 }, angles: { n: 4 }, max_health: { n: 2 }, health: { n: 2 }, movetype: { n: 2 },
  entitytemplate: { n: 2, only: (e) => e.cls === 'env_entity_maker' },
  basevelocity: { n: 4 }, absvelocity: { n: 4 }, target: { n: 2 },
  filtername: { n: 2, only: (e) => e.cls.startsWith('trigger_') },
  force: { n: 2, only: (e) => e.cls === 'phys_thruster' },
  gravity: { n: 2 }, timescale: { n: 2 }, friction: { n: 2 },
  speed: { n: 2, only: () => false }, runspeed: { n: 2, only: () => false }, // players only (playerInput)
  damage: { n: 2, only: (e) => e.cls === 'point_hurt' }, damagetype: { n: 2, only: (e) => e.cls === 'point_hurt' },
  damageradius: { n: 2, only: (e) => e.cls === 'point_hurt' },
};
// "CaseNN" (6 characters, NN 1-32) on a logic_case (AddOutputCustom_Case)
const caseKey = (k) => /^case\d\d$/.test(k) && atoi(k.slice(4)) >= 1 && atoi(k.slice(4)) <= 32;

// -> { key, t } when CS2Fixes would run a handler for this text, else null
function parseKeyValue(engine, param, where) {
  const t = String(param ?? '').split(' ');
  const key = (t[0] || '').toLowerCase();
  const spec = KEYS[key] || (caseKey(key) ? { n: 2 } : null);
  if (!spec || t.length !== spec.n) {
    engine.warnOnce(`kv:${where}:${key}:${t.length}`, `KeyValue "${String(param).slice(0, 60)}" does nothing with CS2Fixes (${spec ? `needs ${spec.n - 1} value${spec.n > 2 ? 's' : ''}` : 'key not handled'})`);
    return null;
  }
  return { key, t, spec };
}

// KeyValue / KeyValues on a map entity
export function keyValue(engine, e, param) {
  const r = parseKeyValue(engine, param, e.cls);
  if (!r) return;
  const { key, t, spec } = r;
  if (spec.only && !spec.only(e)) return;
  const v = t[1];
  switch (key) {
    case 'targetname': e.kv.targetname = v; engine.rename(e, v); return;
    case 'origin': e.setWorldTransform(poseMatrix(vec(t, 16384), rotationOf(e.getWorld()))); return;
    case 'angles': e.setWorldTransform(poseMatrix(e.worldOrigin(), angleQuat(vec(t, 360)))); return;
    // the numbers only: no OnHealthChanged, no break (CS2Fixes writes m_iHealth / m_iMaxHealth)
    case 'health': { const h = clampN(atoi(v), 0, INT_MAX); e.kv.health = String(h); if (e.state.health != null) e.state.health = h; return; }
    case 'max_health': { const h = clampN(atoi(v), 0, INT_MAX); e.kv.max_health = String(h); if (e.state.max != null) e.state.max = Math.max(1, h); return; }
    // target: only a name some entity has (AddOutputCustom_Target looks it up first)
    case 'target': if (engine.findOne(v)) e.kv.target = v; return;
    // filtername: only an existing filter_* (AddOutputCustom_FilterName)
    case 'filtername': { const f = engine.findOne(v); if (f && f.cls.startsWith('filter_')) e.kv.filtername = v; return; }
    case 'basevelocity': case 'absvelocity': e.kv[key] = vec(t, 4096).join(' '); return;
    default: e.kv[key] = v; // movetype, entitytemplate, force, gravity, timescale, friction, damage*, caseNN
  }
}

// Inputs aimed at you. Maps change a human's gravity, speed and health this way: ze_mist_p's escape-boss
// trigger sets "gravity 0.1", its boss door sets 180 max health.
export function playerInput(engine, q) {
  const inp = q.input.toLowerCase();
  const P = engine.player; // { setHealth, setMaxHealth, setGravity, setSpeed, setRunSpeed, setVelocity, setDamageFilter }
  const me = engine.playerEnt;
  // a player has no outputs a map would add: CS2's AddOutput on a pawn changes nothing we model
  if (inp === 'addoutput') { engine.warnOnce('player.addoutput', 'AddOutput on the player ignored'); return; }
  if (inp.startsWith('keyvalue')) {
    const r = parseKeyValue(engine, q.param, 'player');
    if (!r) return;
    const { key, t } = r, v = t[1];
    switch (key) {
      case 'origin': engine.onTeleportPlayer?.(vec(t, 16384)); return;
      case 'gravity': P?.setGravity(atof(v)); return;
      // ZEPlayer::SetSpeedMod: every movement step's frametime scaled (all your movement, gravity too)
      case 'speed': P?.setSpeed(atof(v)); return;
      // AddOutputCustom_RunSpeed: the pawn's m_flVelocityModifier, a multiplier on your max run speed (GFL's stripper
      // uses it for deadcore's B ending instead of "speed")
      case 'runspeed': P?.setRunSpeed?.(atof(v)); return;
      case 'max_health': P?.setMaxHealth(clampN(atoi(v), 0, INT_MAX)); return;
      case 'health': P?.setHealth(clampN(atoi(v), 0, INT_MAX)); return;
      case 'absvelocity': case 'basevelocity': P?.setVelocity(vec(t, 4096)); return;
      case 'targetname': me.name = v; me.key = stripName(v); return;
    }
    engine.warnOnce('player.kv.' + key, `player keyvalue ${key} ignored`);
    return;
  }
  const context = () => String(q.param).split(':')[0].toLowerCase();
  switch (inp) {
    case 'sethealth': P?.setHealth(num(q.param, 100)); return;
    case 'setmaxhealth': P?.setMaxHealth(num(q.param, 100)); return;
    case 'sethealthtoall': return;
    case 'setdamagefilter': me.damageFilter = q.param ? String(q.param) : ''; P?.setDamageFilter(stripName(q.param)); return;
    case 'addcontext': (me.contexts ||= new Set()).add(context()); return;
    case 'removecontext': me.contexts?.delete(context()); return;
    case 'setfogcontroller': setPlayerFog(engine, q.param); return; // which fog you see (classes/fog.js)
    // CS2Fixes takes over IgniteLifetime on a pawn (any input starting "IgniteL"): burn.js. Plain Ignite is CS2's own.
    case 'ignitelifetime': ignitePlayer(engine, parseFloat(q.param) || 0, q.caller); return;
    case 'ignite': return;
  }
  engine.warnOnce('player.' + inp, `player input ${q.input} ignored`);
}
