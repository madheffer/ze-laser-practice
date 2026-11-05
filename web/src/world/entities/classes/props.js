// prop_dynamic's sequence playback, as CS2's CDynamicProp runs it. The engine keeps the animation STATE (which
// sequence, when its cycle was where, rate, loop mode) and times the outputs from the model's sequence lengths
// (animations.json, lasers-bake ModelBake.cs); world/anim.js draws it. No wall clock: the co-op server's headless
// copy (world/run-engine.js) fires the same OnAnimationDone at the same tick.
//
// Truth source: CS2 server.dll build 2026-09-23 (Ghidra project cs2_server_20260923.dll; addresses are that build's).
//   PropSetAnim             FUN_180bb9b40(ent, name, loopMode)
//   SetAnimation            -> PropSetAnim(name, USE_SEQUENCE_SETTINGS)        thunk FUN_180b76890
//   SetAnimation(Not)Looping -> PropSetAnim(name, 1 / 0)                       (current server.dll: r8d = 1 at 0x180b802ab)
//   SetAnimationNoReset*    -> PropSetAnim only if the current sequence differs  FUN_180baed00 / baee80 / baf000 (2 / 1 / 0)
//   SetIdleAnimation(Not)Looping -> m_iszIdleAnim = name, m_nIdleAnimLoopMode = 1 / 0, think if none pending  FUN_180baf180 / baf2f0
//   SetDefaultAnimation     -> the same with mode 2                             thunk FUN_180b76a20
//   anim think (every 0.1 s) FUN_180b906b0; outputs registered in FUN_180bbaf10; Spawn FUN_180bbf0e0,
//   HandleSpawnBackCompat FUN_180bac650 (DefaultAnim -> IdleAnim, HoldAnimation -> loop mode).
// AnimLoopMode_t (the enum table in server.dll): -1 INVALID, 0 NOT_LOOPING, 1 LOOPING, 2 USE_SEQUENCE_SETTINGS.
import { register } from '../registry.js';
import { num, bool } from '../math.js';
import { breakable } from './brushes.js';
import { startsNoDraw } from '../render-mode.js';

const THINK = 0.1; // DAT_181790f84: every anim think schedules the next one 0.1 s on
const END = 0.999; // DAT_18193edac: a forward sequence has "reached its end" at cycle >= 0.999
const NOT_LOOPING = 0, LOOPING = 1, USE_SEQUENCE = 2;
const MODES = { anim_loop_mode_not_looping: 0, anim_loop_mode_looping: 1, anim_loop_mode_use_sequence_settings: 2 };
const MAX_NAME = 128;

// animations.json for this engine's map, validated once: model -> [{ name, key, duration, loop, fadeIn }] (the file
// is map data: no prototype, names capped, numbers checked)
const tables = new WeakMap();
function sequencesOf(engine, model) {
  let t = tables.get(engine);
  if (!t) {
    t = Object.create(null);
    const raw = engine.assets?.animations;
    if (raw && typeof raw === 'object') {
      for (const [m, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        t[String(m).replace(/\\+/g, '/').toLowerCase()] = list.filter((s) => s && typeof s.name === 'string' && s.name.length <= MAX_NAME).map((s) => ({
          name: s.name, key: s.name.toLowerCase(),
          duration: Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 0,
          loop: s.loop === true, fadeIn: Number.isFinite(s.fadeIn) && s.fadeIn >= 0 ? Math.min(s.fadeIn, 5) : 0.2,
        }));
      }
    }
    tables.set(engine, t);
  }
  return t[model] || null;
}

const loopMode = (v, d) => {
  if (v == null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s in MODES) return MODES[s];
  const n = parseInt(s, 10);
  return n === 0 || n === 1 || n === 2 ? n : d;
};

// the cycle at engine time t (unwrapped: 2.3 = 0.3 into the third loop)
export function rawCycle(a, t) {
  return a.duration > 0 ? a.cycle0 + ((t - a.t0) * a.rate) / a.duration : a.cycle0;
}
// whether the current sequence loops (FUN_180b6d330: the controller's mode, 2 = the sequence's own flag)
const loops = (a) => a.mode === LOOPING || (a.mode === USE_SEQUENCE && a.seqLoop);

function rebase(a, t) { a.cycle0 = rawCycle(a, t); a.t0 = t; }

// "no think pending -> one 0.1 s from now" (FUN_18017e970 / FUN_1803e7ab0 in every caller)
function wake(e) {
  const a = e.state.anim;
  if (a.next == null || a.next <= e.engine.time) a.next = e.engine.time + THINK;
}

// FUN_180bb9b40. A known sequence restarts at cycle 0 (even the one already playing: SetSequence(.., reset 1)), the
// playback rate goes back to 1, OnAnimationBegun fires, and the anim think is woken. An unknown name warns ("no
// sequence named") and drops to sequence 0 without OnAnimationBegun or a think.
function propSetAnim(e, name, mode) {
  const a = e.state.anim, E = e.engine, t = E.time;
  a.reached = false; // +0xc6e: "reached start / end" fires once per PropSetAnim
  const seqs = a.seqs;
  const want = String(name ?? '').toLowerCase();
  const i = want && seqs ? seqs.findIndex((s) => s.key === want) : -1;
  if (want && !seqs) {
    // an older bake without animations.json: keep the name for the renderer, time nothing
    E.warnOnce(`anim:nodata:${e.model}`, `prop ${e.name || e.model}: no sequence data (rebake with lasers-bake --models)`);
    Object.assign(a, { name: String(name), index: -1, mode, cycle0: 0, t0: t, rate: 1, duration: 0, seqLoop: false, serial: a.serial + 1 });
    return;
  }
  if (i < 0) {
    if (want) E.warnOnce(`anim:${e.model}:${want}`, `Dynamic prop ${e.name} (model ${e.model}): no sequence named:${String(name).slice(0, MAX_NAME)}`);
    // FUN_180b71190(ent, 0, mode, reset 0): sequence 0, cycle kept. UNSETTLED: what the controller does with the
    // cycle of the old sequence on a no-reset switch (kept here)
    const s0 = seqs?.[0];
    rebase(a, t);
    a.cycle0 -= Math.floor(a.cycle0); // the controller's cycle is 0..1, not the loops it has done
    Object.assign(a, { name: s0?.name ?? '', index: s0 ? 0 : -1, mode, duration: s0?.duration ?? 0, seqLoop: !!s0?.loop, prev: a.cycle0, serial: a.serial + 1 });
    return;
  }
  const s = seqs[i];
  // randomizecycle (+0xc6c): the first sequence starts at a random cycle, then the flag clears
  const c0 = a.randomize ? E.random() : 0;
  a.randomize = false;
  // the controller's +0x100 with 1.0: it writes +0x6c, the float +0x128 returns (the playback rate)
  Object.assign(a, { name: s.name, index: i, mode, cycle0: c0, t0: t, rate: 1, duration: s.duration, seqLoop: s.loop, fadeIn: s.fadeIn, prev: c0, serial: a.serial + 1 });
  e.fireOutput('OnAnimationBegun', e);
  wake(e);
}

// FUN_180b906b0, run when a.next comes due. Its gate is the controller's loop mode (CBaseAnimGraphController vtable
// slot +0xa0 = `mov eax,[rcx+0x68]`, the field FUN_180b6d330 reads): LOOPING keeps going, NOT_LOOPING and
// USE_SEQUENCE_SETTINGS are "done" at the end (or, for a sequence that loops by itself, at its first wrap).
function animThink(e) {
  const a = e.state.anim, t = e.engine.time;
  a.next = null;
  const c = rawCycle(a, t), prev = a.prev;
  a.prev = c;
  if (!loops(a)) {
    const reached = a.rate > 0 ? c >= END : a.rate < 0 ? c <= 0 : false;
    if (!reached) { wake(e); return; }
    if (!a.reached) { e.fireOutput(a.rate > 0 ? 'OnAnimationReachedEnd' : 'OnAnimationReachedStart', e); a.reached = true; }
  } else {
    // a wrap since the last think. UNSETTLED: FUN_180b4e930's "previous cycle" taken as the cycle at the last think
    const wrapped = a.rate > 0 ? Math.floor(c) > Math.floor(prev) : a.rate < 0 ? Math.ceil(c) < Math.ceil(prev) : false;
    if (!wrapped) { wake(e); return; }
    e.fireOutput('OnAnimationLoopCycleDone', e);
  }
  if (!e.alive) return;
  if (a.mode !== LOOPING) {
    e.fireOutput('OnAnimationDone', e);
    // back to the idle animation unless it is the one playing (V_stricmp_fast: case-insensitive)
    if (a.idle && a.idle.toLowerCase() !== a.name.toLowerCase()) propSetAnim(e, a.idle, a.idleMode);
    return; // no new think unless propSetAnim woke one
  }
  if (!loops(a)) { rebase(a, t); a.cycle0 = a.rate < 0 ? 1 : 0; }
  wake(e);
}

function setIdle(e, name, mode) {
  const a = e.state.anim;
  a.idle = name ? String(name).slice(0, MAX_NAME) : null;
  a.idleMode = mode;
  if (a.idle) wake(e);
}

function noReset(e, name, mode) {
  const a = e.state.anim;
  const want = String(name ?? '').toLowerCase();
  const i = a.seqs ? a.seqs.findIndex((s) => s.key === want) : -1;
  if (a.seqs ? a.index !== i : a.name.toLowerCase() !== want) propSetAnim(e, name, mode);
}

// A prop_dynamic blocks players as its "solid" keyvalue says (CS2 SolidType_t: 0 not solid, 2 bounding box, 6 VPhysics,
// the default), with its model's physics hulls, until DisableCollision. ze_minecraft_sakura's bridge to its boss is
// one (road_ending, solid 6), and GFL's stripper blocks off sakura's pond with invisible solid ones.
const propSolid = (e) => num(e.kv.solid, 6) !== 0 && !e.state.noCollide;

export const dynamicProp = {
  solid: propSolid,
  // Spawn (FUN_180bbf0e0): IdleAnim, else DefaultAnim (back-compat), loops as IdleAnimationLoopMode says, else
  // AnimationLoopMode, else HoldAnimation ? USE_SEQUENCE_SETTINGS : LOOPING. StartingAnim (StartingAnimationLoopMode,
  // default NOT_LOOPING) plays first if set, else the idle animation.
  spawn(e) {
    const kv = e.kv;
    if (startsNoDraw(e.cls, kv)) e.visible = false; // Spawn: StartDisabled -> EF_NODRAW (entities/render-mode.js)
    const idle = kv.idleanim || kv.defaultanim || '';
    const mode = loopMode(kv.idleanimationloopmode, loopMode(kv.animationloopmode, bool(kv.holdanimation) ? USE_SEQUENCE : LOOPING));
    e.state.anim = {
      seqs: sequencesOf(e.engine, e.model), name: '', index: -1, mode: USE_SEQUENCE, cycle0: 0, t0: e.engine.time, rate: 1,
      duration: 0, seqLoop: false, fadeIn: 0.2, prev: 0, next: null, reached: false, serial: 0,
      idle: idle ? String(idle).slice(0, MAX_NAME) : null, idleMode: mode, randomize: bool(kv.randomizecycle),
    };
    if (kv.startinganim) propSetAnim(e, kv.startinganim, loopMode(kv.startinganimationloopmode, NOT_LOOPING));
    else if (e.state.anim.idle) propSetAnim(e, e.state.anim.idle, mode);
  },
  input(e, inp, p) {
    // EF_NODRAW off / on: what a StartDisabled prop waits for (westersand Enables its 11, alien shooter TurnOns its
    // antlion at the laser fight). Inputs are hashed in server.dll, so this follows the maps' own use of them.
    if (inp === 'enable' || inp === 'turnon') { e.enabled = true; e.visible = true; return true; }
    if (inp === 'disable' || inp === 'turnoff') { e.enabled = false; e.visible = false; return true; }
    if (!e.state.anim) return false;
    switch (inp) {
      case 'setanimation': propSetAnim(e, p, USE_SEQUENCE); return true;
      case 'setanimationlooping': propSetAnim(e, p, LOOPING); return true;
      case 'setanimationnotlooping': propSetAnim(e, p, NOT_LOOPING); return true;
      case 'setanimationnoreset': noReset(e, p, USE_SEQUENCE); return true;
      case 'setanimationnoresetlooping': noReset(e, p, LOOPING); return true;
      case 'setanimationnoresetnotlooping': noReset(e, p, NOT_LOOPING); return true;
      case 'setidleanimationlooping': setIdle(e, p, LOOPING); return true;
      case 'setidleanimationnotlooping': setIdle(e, p, NOT_LOOPING); return true;
      case 'setdefaultanimation': setIdle(e, p, USE_SEQUENCE); return true;
      // current server.dll: SetDefaultAnimationLooping's setter writes m_nIdleAnimLoopMode = 1 (FUN_180bb5de0)
      case 'setdefaultanimationlooping': setIdle(e, p, LOOPING); return true;
      case 'setdefaultanimationnotlooping': setIdle(e, p, NOT_LOOPING); return true;
      // the thunk hands the float to the controller's SetPlaybackRate (vtable +0x100); the cycle carries on from where it is
      case 'setplaybackrate': { const a = e.state.anim; rebase(a, e.engine.time); a.rate = num(p, 1); wake(e); return true; }
      case 'startglowing': case 'stopglowing': case 'setglowoverride': case 'setglowrange': return true;
      case 'disablecollision': e.state.noCollide = true; e.engine.moved(e); return true;
      case 'enablecollision': e.state.noCollide = false; e.engine.moved(e); return true;
    }
    return false;
  },
  think(e) {
    const a = e.state.anim;
    if (a && a.next != null && e.engine.time >= a.next - 1e-9) animThink(e);
  },
};

register('prop_dynamic', dynamicProp);
register('dynamic_prop', dynamicProp); // CDynamicPropAlias_dynamic_prop
// prop_dynamic_override: a CDynamicProp with health (Spawn reads "health" only for it), so breakable + animation
register('prop_dynamic_override', {
  solid: propSolid,
  spawn(e) { breakable.spawn(e); dynamicProp.spawn(e); },
  input(e, inp, p, act) { return dynamicProp.input(e, inp, p, act) || breakable.input(e, inp, p, act); },
  think: dynamicProp.think,
});
