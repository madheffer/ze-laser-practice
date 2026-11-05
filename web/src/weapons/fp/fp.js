// Ported from vpkstuff frontend/previewer/fp.js (the CS2 viewmodel engine). Changes for lasers: the ag2
// evaluator and library stubs are bundled imports; everything else is verbatim.
import * as THREE from 'three';
import { loadGltf, indexByName, dedupeMeshes, prepareSkinnedMesh, upgradeCs2Materials, releaseCs2,
  assetUrl } from './util.js';
import { matTexBaseFor, matTexUrl, disposeObject, resourcesOf, METRES_PER_INCH as IN, SOURCE_FOV_ASPECT,
  vfovFromHfov, hfovFromVfov } from './three-kit.js';
import * as AG2Clip from './ag2/clip.js';
import * as AG2Eval from './ag2/eval.js';
// lasers: vpkstuff's library.js talks to its site catalogue; there is no library here.
const libraryWeapons = async () => [];
const firstPersonArmsUrl = () => null;
import { WEAPONS, GLOVES, GLOVE_LABEL, vdataNameFor, holdRepeats } from './chassis.js';

// The weapon / glove tables live in chassis.js so a page can ask what is
// viewable without pulling Three.js in. Re-exported here because the engine has
// always been where callers looked for them.
export { WEAPONS, GLOVES, GLOVE_LABEL };

// First-person source: the CS2 viewmodel driven by the REAL compiled AnimGraph2 (graph JSON dumped from the
// game's .vnmgraph_c, clips VRF-baked from .vnmclip_c), so inspect gating, reload refusal and retriggers emerge.
// A hidden DRIVER RIG carries the pose and the visible meshes copy its world transforms by bone name.

// The only `weapon_type` values any dumped graph compares against. Setting the
// parameter for anything else would be noise; these seven animate differently
// from the rest of their class and the graph branches on them by name.
const WEAPON_TYPE_IDS = new Set(['aug', 'm249', 'm4a1_silencer', 'negev', 'sg556', 'usp_silencer', 'xm1014']);

// A knife's light and heavy swing, as the knife graphs name them. `miss` is the
// honest one for a preview: nothing is being hit.
const KNIFE_LIGHT = 'attack_knife_lightmiss';
// Updates a restarted draw ignores the completion event for, measured: the previous draw's event outlives the
// twin flip by two updates (see tick); at 50ms it cannot swallow a real completion (0.1s before a ~1s clip ends).
const DEPLOY_GUARD = 3;

const KNIFE_HEAVY = 'attack_knife_heavymiss';
// viewmodel_grenade's Attack machine walks attack_type charge (pull_pin) -> ready (held, posed by
// attack_throw_strength) -> throw, which plays underhand at strength <= 0.33 and overhand above.
const NADE = { charge: 'attack_grenade_charge', ready: 'attack_grenade_ready', throw: 'attack_grenade_throw' };
// The thrown grenade has left the hand by this fraction of the throw clip; the stage hides it there.
const NADE_RELEASE = 0.4;

// CS2 viewmodel_offset_* convars: shipped defaults and the ranges the game
// clamps them to. Verified against the published convar reference after our own
// client.dll audit turned out to have recorded the bounds as the defaults.
const VM_OFFSET_DEFAULT = { x: 1, y: 1, z: -1 };
const VM_OFFSET_RANGE = { x: 2.5, y: 2, z: 2 };   // symmetric: clamped to +/- these

export const BGS = [
  { id: 'studio',   name: 'Studio',        kind: 'color', color: 0x14161c },
  { id: 'warehouse',name: 'Warehouse',     kind: 'exr',   url: 'bg/warehouse_vanity_256.exr' },
  { id: 'overcast', name: 'Overcast Sky',  kind: 'exr',   url: 'bg/overcast_soil_puresky_512.exr', showBg: true },
  { id: 'dust2',    name: 'Dust II',       kind: 'tex',   url: 'bg/dust2.jpg' },
  { id: 'chroma',   name: 'Chroma Green',  kind: 'color', color: 0x00b140 },
];

// The weapon controller: drives the graph's `action` parameter the way
// client.dll does. Everything else - whether the action is even allowed, how it
// blends, when it ends - is the graph's business.
class WeaponController {
  constructor() {
    this.action = 'idle'; this.elapsed = 0; this.ammo = 30; this.ammoMax = 30;
    this.inspectHeld = false; this.resetPulse = 0; this.graph = null;
    // Duration BACKSTOPS for a missing WPN_ACTION_COMPLETE, not the schedule: a 0.35s `attack` once cut a knife's
    // 1.13s slash at 31%. 1.6s clears the longest attack clip in the library and fires only if the graph goes quiet.
    this.cap = { reload: 2.8, deploy: 1.5, inspect: 6, attack: 1.6 };
    // The weapon's authored refire delay (fire-rates.json), set per chassis by
    // the source. sinceFire starts big so the first shot is never refused.
    this.cycle = { primary: 0.15, secondary: 0.3 };
    // Does a HELD trigger keep firing? Off the weapon's own m_bIsFullAuto (see
    // chassis.js). A semi-automatic weapon fires once per press in CS2 and does
    // nothing more until the button is released, so a held pull is refused.
    this.holdRepeats = true;
    this.sinceFire = 99;
    // Set for the one frame between a pull being accepted and that swing's first
    // tick, so a stale completion cannot end it before it starts (see tick()).
    this.freshAttack = false;
    // Frames of grace for a restarted draw. See tick().
    this.deployGuard = 0;
    // The graph picks a light attack's clip by floor(abs(attack_variation)) % count, so this must be an integer
    // that counts per trigger pull for every authored swing to play.
    this.variation = 0;
    // A grenade's throw cycle: null, or { phase: 'charge' | 'ready' | 'throw', release, strength }.
    this.nade = null;
    this.grenade = false;
    this.durs = {};
    // False from a throw's release until the next draw: the grenade is in the air, not in the hand.
    this.nadeInHand = true;
  }
  bind(graph) { this.graph = graph; this.action = 'idle'; this.elapsed = 0; this.ammo = this.ammoMax; this.sinceFire = 99; this.freshAttack = false; this.deployGuard = 0; this.triggerHeld = false; this.nade = null; this.nadeInHand = true; }
  // Press: pull the pin (CS2 throws only once it is out). `strength` 1 is LMB's overhand, 0 RMB's underhand.
  nadeHold(strength = 1) {
    if (!this.graph || !this.nadeInHand) return;
    // A second button while charging changes the throw (both buttons lob), as in CS2.
    if (this.nade) {
      if (this.nade.phase !== 'throw') { this.nade.strength = strength; this.graph.setParam('attack_throw_strength', strength); }
      return;
    }
    if (this.inspectHeld || this.action === 'inspect') { this.inspectHeld = false; this.graph.setParam('inspect_extra_info', ''); }
    this.nade = { phase: 'charge', release: false, strength };
    this.graph.setParam('attack_throw_strength', strength);
    this.graph.setParam('attack_type', NADE.charge);
    this.action = 'attack'; this.elapsed = 0;
    this.graph.setParam('action', 'action_attack');
  }
  // Release: throws now if the pin is out, else as soon as it is.
  nadeRelease() {
    if (!this.nade) return;
    this.nade.release = true;
    if (this.nade.phase === 'ready') this._nadeThrow();
  }
  _nadeThrow() {
    this.nade.phase = 'throw';
    this.elapsed = 0;
    this.graph.setParam('attack_type', NADE.throw);
  }
  _nadeTick() {
    const n = this.nade;
    if (n.phase === 'charge' && this.elapsed >= (this.durs.pullpin_hegrenade || 0.97)) {
      n.phase = 'ready'; this.elapsed = 0;
      this.graph.setParam('attack_type', NADE.ready);
      if (n.release) this._nadeThrow();
    } else if (n.phase === 'throw') {
      const len = (n.strength <= 0.33 ? this.durs.throw_underhand_hegrenade : this.durs.throw_overhand_hegrenade) || 0.8;
      if (this.nadeInHand && this.elapsed >= len * NADE_RELEASE) this.nadeInHand = false;
      // Another grenade comes out, as when you carry a second one.
      if (this.elapsed >= len + 0.25) { this.nade = null; this.nadeInHand = true; this.redeploy(); }
    }
  }
  set(a) {
    if (this.action === a) return;
    this.action = a; this.elapsed = 0;
    this.graph?.setParam('action', 'action_' + a);
  }
  // Fire = action_attack plus a ONE-FRAME action_reset pulse: the shoot machine is a twin-state flip-flop gated on
  // And(action_reset, attack), so each pulse restarts the clip. `attackType` is REQUIRED for a knife: its Attack
  // machine compares `attack_type`, and without it nothing plays. `held` marks a pull from a held button.
  fire(attackType, held = false, heldFor = Infinity) {
    if (!this.graph) return;
    // The trigger gate: the graph has no refire lockout; CS2's client refuses the shot until m_flCycleTime
    // (weapons.vdata) elapses, the secondary time for a knife's stab. A semi refuses the held pump outright, so the
    // next shot needs a fresh press (the previewer once emptied a USP-S on a held button).
    if (held && !this.holdRepeats) return;
    const need = attackType === KNIFE_HEAVY ? this.cycle.secondary : this.cycle.primary;
    // Is this really a hold? The pump starts at button-down, so every click also delivered a held pull. A click
    // ends before the refire interval; a real hold passes it just as the next pull is due, keeping full-auto cadence.
    if (held && heldFor < need) return;
    // DELIBERATELY no "let the swing finish" rule: in CS2 the refire time is the only gate and every pull restarts
    // the swing; one refused clicks for ~0.93s and silently blocked a slash from cancelling an inspect. The epsilon
    // matters: 1/60 steps sum six frames to 0.09999, holding an AK at 513rpm instead of its authored 600.
    if (this.sinceFire < need - 1e-4) return;
    // An attack cancels an inspect, but the inspects sub-graph still loops on inspect_extra_info and a held key
    // would drag the weapon back into a lookat after the swing; releasing the loop makes the cancel stick.
    if (this.inspectHeld || this.action === 'inspect') {
      this.inspectHeld = false;
      this.graph.setParam('inspect_extra_info', '');
    }
    this.sinceFire = 0;
    if (this.ammo > 0) this.ammo--;
    this.graph.setParam('weapon_ammo', this.ammo);
    // Advance the variation BEFORE re-entering the attack so this swing differs from the last: a knife's light
    // attacks have two authored swings (alternates), its heavy one (the modulo ignores it).
    this.graph.setParam('attack_variation', ++this.variation);
    if (attackType) this.graph.setParam('attack_type', attackType);
    this.action = 'attack'; this.elapsed = 0;
    // This swing has not had a frame yet, so the completion event still in the
    // air belongs to the LAST one. See tick().
    this.freshAttack = true;
    this.graph.setParam('action', 'action_attack');
    this.graph.setParam('action_reset', true);
    // ONE graph update: the frame loop updates the graph and THEN ticks this controller, so a count of 1 is seen
    // exactly once. Two flips the machine back and restarts the swing a frame after it began.
    this.resetPulse = 1;
  }
  // The game refuses a reload at full ammo; a preview with a dead R key reads as broken, so a
  // full magazine drops one round first and the reload always plays.
  reload() {
    if (this.graph && this.ammo >= this.ammoMax) { this.ammo = this.ammoMax - 1; this.graph.setParam('weapon_ammo', this.ammo); }
    this.set('reload');
  }
  // Backstops follow the clips actually loaded: an animation set's 19 s inspect or 3.1 s reload
  // ran past the fixed caps, which cut it mid-motion and snapped the weapon back to idle.
  fitCaps(durations) {
    this.durs = durations;
    const base = { reload: 2.8, deploy: 1.5, inspect: 6, attack: 1.6 };
    const longest = (re) => Math.max(0, ...Object.entries(durations).filter(([n]) => re.test(n)).map(([, d]) => d));
    this.cap = {
      ...base,
      reload: Math.max(base.reload, longest(/^reload/) + 0.5),
      deploy: Math.max(base.deploy, longest(/^draw/) + 0.3),
      inspect: Math.max(base.inspect, longest(/^lookat/) + 0.5),
    };
  }
  deploy() { if (this.action !== 'deploy') { this.nade = null; this.nadeInHand = true; this.rollDeployVariation(); this.deployGuard = DEPLOY_GUARD; this.set('deploy'); } }
  // Deploying picks its draw by a ParameterizedClipSelector over deploy_variation, which nothing set (0 forever):
  // 9 of 57 gun graphs have a second reachable draw, and with weights like [1,8,1] the rare draw was the only one.
  // 64 clears the longest weight-expanded option list. Same defect as inspect_variation.
  rollDeployVariation() {
    this.graph?.setParam('deploy_variation', Math.floor(Math.random() * 64));
  }
  // Draw again from the start. `set` and the graph both refuse a repeated action id, but CS2's Deploying is a
  // twin-state flip-flop (Deploy0/Deploy2) like Attack, gated on And(action_reset, action Matches action_deploy),
  // so a restart is fire()'s one-frame reset pulse and the hard cut is the game's own.
  redeploy() {
    if (!this.graph) return;
    // A draw abandons a throw in progress, or tick() would keep running the throw against the draw.
    this.nade = null; this.nadeInHand = true;
    // A still-held inspect would drag the weapon straight back into a lookat the
    // moment the draw ended, the same way it does after a swing.
    if (this.inspectHeld || this.action === 'inspect') {
      this.inspectHeld = false;
      this.graph.setParam('inspect_extra_info', '');
    }
    this.rollDeployVariation();
    this.action = 'deploy'; this.elapsed = 0;
    // This draw has not had a frame yet, so a completion event in the air
    // belongs to the one before it. See tick().
    this.deployGuard = DEPLOY_GUARD;
    this.graph.setParam('action', 'action_deploy');
    this.graph.setParam('action_reset', true);
    this.resetPulse = 1;
  }
  // CS2's hold-to-inspect: the inspects graph loops while inspect_extra_info matches "inspect_should_loop", so
  // holding sets it and releasing clears it. Weapons with several inspects (Deagle lookat02) pick by a weighted
  // selector over inspect_variation, which was never set (0 forever), so the second one could never play.
  rollInspectVariation() {
    // Integer, because that is what the selector floors it to anyway. The range
    // only has to exceed the longest virtual option list for every option to be
    // reachable; 64 clears them all with room to spare.
    this.graph?.setParam('inspect_variation', Math.floor(Math.random() * 64));
  }
  inspectStart() {
    if (this.nade) return;
    this.inspectHeld = true;
    this.rollInspectVariation();
    this.graph?.setParam('inspect_extra_info', 'inspect_should_loop');
    this.set('inspect');
  }
  inspectEnd() {
    this.inspectHeld = false;
    // Reset elapsed for the outro only if an inspect is playing: after a slash cancelled the inspect, releasing
    // the key handed the ATTACK a fresh 1.6s backstop and left the weapon stuck mid-slash.
    if (this.action === 'inspect') this.elapsed = 0;
    this.graph?.setParam('inspect_extra_info', '');
  }
  inspectTap() {
    if (this.nade) return;
    this.inspectHeld = false;
    this.rollInspectVariation();
    this.graph?.setParam('inspect_extra_info', '');   // a tap never loops
    this.set('inspect');
  }
  // The refire cooldown runs on WALL CLOCK: weapon mode steps a parked graph at 0, and a sinceFire inside tick()
  // froze with it, so every click after the first was silently refused (the dead knife LMB).
  tickCooldown(dt) { this.sinceFire += dt; }
  tick(dt) {
    if (!this.graph) return;
    this.elapsed += dt;
    if (this.resetPulse > 0 && --this.resetPulse === 0) this.graph.setParam('action_reset', false);
    if (this.nade) { this._nadeTick(); return; }
    const done = this.graph._events.has('WPN_ACTION_COMPLETE'), a = this.action;
    if (a === 'idle') return;
    const capped = this.elapsed >= (this.cap[a] || 3);
    // An attack ends when the graph's completion event lands (0.2s left, matching the authored 0.2s attack->idle
    // cross-fade); the cap is only a backstop for a graph that never raises it.
    if (a === 'attack') {
      // A finished clip keeps raising WPN_ACTION_COMPLETE every frame at its end, so a swing starting then was
      // cancelled on frame one. A knife's held stab (0.92s clip, 1.0s refire) always hit it and stabbed every 2.0s.
      if (this.freshAttack) this.freshAttack = false;
      else if (done || capped) this.set('idle');
    }
    else if (a === 'reload') {
      if (done || capped) { this.ammo = this.ammoMax; this.graph.setParam('weapon_ammo', this.ammo); this.set('idle'); }
    } else if (a === 'deploy') {
      // Same trap for deploy's twin flip-flop: the outgoing twin's parked clip still raises the event, and
      // probed per frame it outlives the flip by TWO updates (an AK alternated 52-frame and 1-frame draws), so a
      // one-frame flag like freshAttack is a frame short; DEPLOY_GUARD covers it.
      if (this.deployGuard > 0) this.deployGuard--;
      else if (done || capped) this.set('idle');
    }
    else if (a === 'inspect') { if (!this.inspectHeld && (done || capped)) this.set('idle'); }
  }
}

// Distinguishes one source's assets from another's while three of them load at
// the same time. They pull the SAME arms file, so a url is not an identity.
let SOURCE_SEQ = 0;

export class FpSource {
  constructor(cfg, log) {
    this.id = 'fp';
    this.label = 'First person';
    this.cfg = cfg;
    this.log = log;
    this.base = cfg.fpBase;
    this.scrubbable = false;      // a graph has no timeline to drag
    this.unitsPerMetre = 1;       // glTF space: metres, y-up

    this.group = new THREE.Group();
    this.weaponId = cfg.weapon;
    this.selectedId = cfg.weapon; // what the picker shows; a library id maps to a base chassis
    this.libWeapons = new Map();  // id -> {base, model, label} from libweapons.json
    this._libEntry = null;        // active library weapon, or null for stock
    this.gloveId = cfg.glove;
    // Default to the character's own hands when a model is loaded; with no cfg.model, 'model' loaded the weapon
    // glb as arms (a second gun), so stock is the default. 'agent:<id>' is a default agent's baked arms.
    this.armsSource = cfg.armsSource || (cfg.model ? 'model' : 'stock');
    // An agent's SLEEVE over an econ glove, CS2's arrangement: the agent's `firstperson_hide_default_gloves`
    // group holds only its sleeves, and the glove model is the complete arm (twist solve, paint, bone editing).
    this.sleeves = null;
    this.agents = [];             // agents/manifest.json - the baked default agents
    this._agentTwists = new Map();// id -> its own constraint table (or null)
    this.mirrored = false;

    this.rig = null;
    this.arm = null;
    this.weapon = null;
    this.graph = null;
    this.wc = new WeaponController();

    this.joints = new Map();
    this._armBind = new Map();    // arm bone -> its bind local, for rig swaps
    // CS2 drives the arm's twist helpers with CTiltTwistConstraints, not
    // animation - see _bindTwists. The table is authored data shipped beside
    // the baked assets; the solve map is rebuilt per glove.
    this._twistTable = null;
    this._twistSolve = null;
    this._tq = new THREE.Quaternion();
    this._tAxisX = new THREE.Vector3(1, 0, 0);
    this.skinned = [];
    this.origInverses = new Map();
    this.meshBoneIndex = new Map();
    this.hiUniforms = [];
    this._cs2 = new Map();        // loaded root -> its CS2 material controller, released with the root

    // A fresh rig GLB still holds its bind local scale of 39.37 (the inch->metre node), and retargeting from it
    // balloons the arms ~26x, so nothing retargets until the graph has posed the rig.
    this._rigReady = false;
    // The animation editor's clip mode: one clip sampled at editTime instead of the graph, with
    // editDeltas (bone -> {o: Vector3 in game units along the bone's axes, q: Quaternion after
    // its own}) layered on top - the same layer the server applies (AnimKeys.cs).
    this.editClip = null;
    this.editTime = 0;
    this.editDeltas = new Map();
    this._editPose = null;
    this._eo = new THREE.Vector3();
    this.uid = ++SOURCE_SEQ;
    this._assetSeq = 0;
    this._ag2 = null;             // lazily imported {ClipSource, Graph}
    this._clipCache = new Map();
    this._focus = new THREE.Vector3();
    this._focusDirty = true;
    this._bt = new THREE.Vector3();
    this._be = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._inv = new THREE.Matrix4();
    this._attach = new THREE.Matrix4();
    this._skelInv = new THREE.Matrix4();
    this._sv = new THREE.Vector3();
    this._camShift = new THREE.Vector3();   // scratch for eyeCamShift; _sv is the scale helper's

    this.camView = 'eye';         // 'eye' = authentic in-game | 'showcase' = 3/4
    this.fovH = 68;               // CS2 viewmodel_fov
    // CS2 viewmodel_offset_x/y/z in inches (x right, y forward, z up), moving the viewmodel relative to the eye.
    // Shipped defaults are 1 / 1 / -1; 2.5 / 2 / -2 are the clamp extremes, which an earlier audit misread.
    this.vmOffset = { ...VM_OFFSET_DEFAULT };
    // Raw manual nudge in METRES, on top of the convars. Showcase-only knob kept
    // for A/B; the eye view honours it too so a probe can push the camera around
    // without disturbing the convar values.
    this.camOffset = new THREE.Vector3(0, 0, 0);
  }

  weaponDef(id = this.weaponId) { return WEAPONS.find(w => w.id === id) || WEAPONS[0]; }

  weaponList() {
    const group = { rifle: 'Rifles, SMGs, shotguns & snipers', pistol: 'Pistols', knife: 'Knives', grenade: 'Grenades' };
    const list = WEAPONS.map(w => ({ id: w.id, label: w.label, group: group[w.cls] || w.cls }));
    for (const [id, e] of this.libWeapons)
      list.push({ id, label: e.label, group: 'Library weapons' });
    return list;
  }

  // In first person a library id means its stock chassis's rig, graph and clips with only the model swapped:
  // CS2 uses one weapon model for both views, so the same GLB retargets onto the viewmodel rig by bone name.
  async _loadLibWeapons() {
    let skipped = 0;
    for (const e of await libraryWeapons(this.cfg, this.log)) {
      if (WEAPONS.some(w => w.id === e.base)) this.libWeapons.set(e.id, e);
      else skipped++;   // a chassis with no viewmodel bake (the default knives)
    }
    if (skipped) this.log(`libweapons: ${skipped} skipped in FP - chassis has no viewmodel bake`);
  }

  // One weapon named by the caller, not the catalogue: a bundle's glb has no catalogue id, and chassis + url is
  // all a swap needs. `paint` ({ recipe, seed, wear }) makes the url the kit's own glb and builds materials
  // from the recipe (see _applyPaint).
  registerWeapon({ id, base, model, label, paint }) {
    if (!WEAPONS.some(w => w.id === base)) return false;
    const entry = { id, base, model, label: label || id, paint: paint || null };
    this.libWeapons.set(id, entry);
    // Re-registering the selected id must move the live reference: kits for one gun share a model url and so this
    // id, and a stale _libEntry repainted the weapon with the skin just navigated away from.
    if (this.selectedId === id) this._libEntry = entry;
    return true;
  }
  // Byte progress for one asset. `kind` tells an aggregator when its denominator is trustworthy (arms 5.5 MB and
  // model 2.6-6.5 MB vs 130 KB a clip); ids are unique because concurrent sources pull the same arms file.
  _onAsset(kind) {
    const cb = this.cfg.onAsset;
    if (!cb) return undefined;
    const id = `${this.uid}:${kind}:${++this._assetSeq}`;
    return (_frac, loaded, total) => cb(id, kind, loaded, total);
  }

  assetBase() { return `${this.base}classes/${this.weaponId}/`; }
  // An animation set replaces stock clips by NAME (draw_m4a4, reload_m4a4...), so the rig,
  // the graph and the clip table all pick the set's version up through this one lookup.
  clipUrl(name) { return this.cfg.clipOverrides?.[name] || `${this.assetBase()}clips/${name}.glb`; }

  async load() {
    // The evaluator is imported from the asset root (one copy, no drift) and CACHE-BUSTED: mounted assets ship with
    // the resource sync, not a web deploy, so a pushed fix once ran stale from cache. `ag2v` versions both modules.
    // lasers: the evaluator is bundled (src/fp/ag2), not imported from the asset root.
    this._ag2 = { clip: AG2Clip, eval: AG2Eval };
    // Only when a picker needs the whole catalogue. A panel that registers its
    // one weapon does not, and skipping the fetch keeps the first frame off the
    // back of a 140 KB list it will never show.
    if (this.cfg.libraryPicker !== false) await this._loadLibWeapons();
    // ?weapon= may name a LIBRARY weapon (the model-swap reload carries the
    // loadout in the URL): resolve it to its chassis before the rig loads.
    const bootLib = this.libWeapons.get(this.weaponId);
    if (bootLib) {
      this.selectedId = this.weaponId;
      this._libEntry = bootLib;
      this.weaponId = bootLib.base;
    }
    // The arm rig's constraint wiring, before any arm loads: setGlove builds
    // its solve map from this. Missing is survivable - the arms render, the
    // twist helpers just sit at bind the way they always did.
    try {
      const r = await fetch(`${this.base}arm-constraints.json`);
      if (r.ok) this._twistTable = (await r.json()).twists;
    } catch { /* absent table = no twist solve */ }
    // The default-agent arm bakes (tools/bake-agent-arms.sh): per-faction stock
    // agents whose own first-person hands can stand in for the gloves. Missing
    // is survivable - the Hands panel then simply offers no agent chips.
    try {
      const r = await fetch(`${this.base}agents/manifest.json`);
      if (r.ok) this.agents = (await r.json()).agents || [];
    } catch { /* no agent bakes */ }
    // Bone-mask tables (tools/fp-bone-masks.mjs): a LayerBlend naming a mask blends only its bones (dualies'
    // right arm, R8 cylinder, pistol slide-lock). Missing is survivable: masked layers apply everywhere.
    try {
      const r = await fetch(`${this.base}graph/bone-masks.json`);
      if (r.ok) this._boneMasks = (await r.json()).masks;
    } catch { /* absent table = unmasked layers */ }
    // Per-weapon m_flCycleTime out of weapons.vdata (--fp-fire-rates): the
    // refire gate. Missing is survivable - the controller's default delay
    // still stops machine-gun clicking, just not with the authored numbers.
    try {
      const r = await fetch(`${this.base}fire-rates.json`);
      if (r.ok) this._fireRates = (await r.json()).rates;
    } catch { /* absent table = default fire gate */ }
    // Per-clip CNmIDEvent windows (--fp-clip-events): what the graphs'
    // IDEventCondition nodes test and sync transitions seek to. Without it
    // hold-to-inspect degrades to the old play-once behaviour.
    try {
      const r = await fetch(`${this.base}clip-events.json`);
      if (r.ok) this._clipEvents = (await r.json()).clips;
    } catch { /* absent table = no clip-event conditions */ }
    // Below is the heavy half (driver rig, clips, arms, weapon), which a third-person opener does not need: loading
    // it anyway cost a character preview 24 requests and 14 MiB never drawn.
    if (this.cfg.deferRig) return this;
    return this.loadRig();
  }

  /**
  * The heavy half of load(), on demand. Idempotent, and safe never to call: update() waits for `_rigReady`
  * and `arm` / `weapon` read null, so a deferred source is valid and simply draws nothing.
  */
  async loadRig() {
    if (this._rigReady) return this;
    await this._loadRig();
    // The orbit view never draws the arms (5.3 MB for the default glove), so a source booting there defers them to
    // loadArms(); the weapon is posed from the driver rig either way.
    if (this.cfg.deferArms) this._armsDeferred = true;
    else await this._reloadArm(); // whatever cfg.armsSource asked for, not just gloves
    await this._buildEvaluator();
    this._rigReady = true;
    await this._loadWeaponModel();
    this.wc.deploy();             // draw, then the graph settles into idle
    return this;
  }

  // Every clip of a weapon carries the same skeleton, and draw always exists, so
  // the draw clip doubles as the driver rig.
  async _loadRig() {
    const w = this.weaponDef();
    const gltf = await loadGltf(this.clipUrl(`draw_${w.gun}`), this._onAsset('rig'));
    const root = gltf.scene;
    // Hide everything the rig can DRAW, not just meshes: the clip GLBs carry POINTS primitives (isMesh false),
    // which rendered as white "skeleton dots" moving with the weapon.
    root.traverse(o => {
      if (o.isMesh || o.isPoints || o.isLine || o.isLineSegments || o.isSprite) o.visible = false;
    });
    // The rig's bind top carries a 39.37 scale cancelling the inch->metre node; the graph resets scale only on bones
    // it poses (varies per weapon), so an unposed ancestor ballooned the arms 39x. Normalise for every weapon.
    root.traverse(o => { if (o.isBone || o.type === 'Bone') o.scale.set(1, 1, 1); });
    // The skeleton's reference pose from the clip GLB's node TRS: VRF exports additive clips as absolute poses,
    // so "sample minus THIS" recovers the delta the graph's additive layers mean.
    const rigBind = new Map();
    root.traverse(o => {
      if (o.isBone || o.type === 'Bone')
        rigBind.set(o.name, { p: o.position.clone(), q: o.quaternion.clone() });
    });
    this._rigBind = rigBind;
    this.group.add(root);
    root.updateMatrixWorld(true);
    const byName = indexByName(root);
    let weaponSkelRoot = null;
    root.traverse(o => {
      if (!weaponSkelRoot && /weapons.*vnmskel$/i.test(o.name) && !o.name.includes('empty_mesh'))
        weaponSkelRoot = o;
    });
    this.rig = { root, byName, weaponSkelRoot,
      // The weapon skeleton's own root BONE is the attachment frame, as in third person; the vnmskel container's
      // transform varies per bake and oriented 41 of 45 weapons wrongly.
      weaponBone: byName.get('weapon') ?? byName.get('weapon_offset') ?? null,
      attach: byName.get('wpn') ?? null };
    this.log(`driver rig → ${w.label} (${byName.size} nodes)`);
  }

  async _buildEvaluator() {
    const { ClipSource } = this._ag2.clip;
    const { Graph } = this._ag2.eval;
    const w = this.weaponDef();
    const gunRes = await fetch(`${this.base}graph/gun_${w.graph}.graph.json`);
    if (!gunRes.ok) throw new Error(`no graph dump for ${w.graph}`);
    const gunJson = await gunRes.json();
    let inspJson = null;
    try {
      // Knives have no inspects sub-graph at all; the evaluator copes without it.
      const r = await fetch(`${this.base}graph/inspects_${w.graph}.graph.json`);
      if (r.ok) inspJson = await r.json();
    } catch { /* absent is normal */ }

    // Request only clips this weapon BAKED (the class manifest): Valve's gun graph is one shared table, so urls
    // derived from it alone 404 on every load (idle_from_activity_m249 is in all 32 and baked only for the M249).
    // If the manifest cannot be read, try everything rather than silently lose animations.
    let baked = null;
    try {
      const mr = await fetch(`${this.assetBase()}manifest.json`);
      if (mr.ok) {
        const mf = await mr.json();
        if (Array.isArray(mf?.clips) && mf.clips.length)
          baked = new Set(mf.clips.map(c => c.name).filter(Boolean));
      }
    } catch { /* no manifest - fall through to trying every referenced clip */ }

    const res = [...gunJson.m_resources, ...(inspJson?.m_resources ?? [])];
    const sources = new Map();
    const durations = {};
    for (const p of new Set(res.filter(r => r.endsWith('.vnmclip')))) {
      const bn = p.split('/').pop().replace('.vnmclip', '');
      if (baked && !baked.has(bn) && !this.cfg.clipOverrides?.[bn]) continue;   // another weapon's clip
      try {
        const g = await loadGltf(this.clipUrl(bn), this._onAsset('clip'));
        sources.set(p, new ClipSource(g.animations[0], this._clipEvents?.[p]));
        durations[bn] = g.animations[0]?.duration || 0;
      } catch { /* a few weapons reference a clip that was never baked */ }
    }
    if (inspJson) {
      const subKey = gunJson.m_resources.find(r => r.endsWith('.vnmgraph'));
      this.graph = new Graph(gunJson, sources,
        new Map([[subKey, new Graph(inspJson, sources, new Map(), this._rigBind, this._boneMasks)]]),
        this._rigBind, this._boneMasks);
    } else {
      this.graph = new Graph(gunJson, sources, new Map(), this._rigBind, this._boneMasks);
    }
    this.wc.fitCaps(durations);
    this.graph.setParam('weapon_ammo', 30);
    this.graph.setParam('weapon_ammo_max', 30);
    this.graph.setParam('weapon_ammo_reserve', 90);
    // Dumped from the graphs: only knife graphs compare weapon_category (against `weapon_category_knife`; without
    // it a knife never left its boot state), and gun graphs compare weapon_type against seven specific weapons.
    if (w.cls === 'knife') this.graph.setParam('weapon_category', 'weapon_category_knife');
    if (w.cls === 'grenade') this.graph.setParam('weapon_category', 'weapon_category_grenade');
    this.wc.grenade = w.cls === 'grenade';
    // `type` overrides `gun`: M4A1-S and USP-S animate on shared default clip sets (`gun` = rifle / pistol) while
    // the graph branches on weapon_m4a1_silencer / weapon_usp_silencer.
    const typeId = w.type || w.gun;
    if (WEAPON_TYPE_IDS.has(typeId)) this.graph.setParam('weapon_type', `weapon_${typeId}`);
    // Whether THIS weapon can be asked to inspect. Guns and most knives carry a
    // referenced inspects sub-graph; the butterfly bakes its lookat states into
    // its own standalone graph instead, so the clips are the honest signal.
    this._hasInspects = !!inspJson || gunJson.m_resources.some(r => /lookat/i.test(r));
    this.wc.bind(this.graph);
    // Knives floor their vdata refire ([0.15, 0.3]): the client enforces 0.4s between swings and 1.0s after a stab
    // in weapon code (CS:GO constants, still how CS2 feels), so data alone swings 2.5x too fast.
    const rate = this._fireRates?.[vdataNameFor(this.weaponId)];
    this.wc.cycle = w.cls === 'knife'
      ? { primary: Math.max(0.4, rate?.[0] ?? 0), secondary: Math.max(1.0, rate?.[1] ?? 0) }
      : { primary: rate?.[0] ?? 0.15, secondary: rate?.[1] ?? 0.3 };
    this.wc.holdRepeats = holdRepeats(this.weaponId);
    this.log(`AG2 graph → ${this.graph.nodes.length} nodes, ${w.label}${inspJson ? '' : ' (no inspects sub-graph)'}`);
  }

  async _loadModel(url, { skinEditable = false, kind = 'model' } = {}) {
    const gltf = await loadGltf(url, this._onAsset(kind));
    const root = gltf.scene;
    dedupeMeshes(root);
    this.group.add(root);
    // Exporters park the unit conversion differently (a wrapper node, or 0.0254 on the root bone), and bone scale is
    // bind convention, so retarget restores each bone's own scale or the model collapses by the factor.
    const bindScale = new Map();
    root.traverse(o => { if (o.isBone || o.type === 'Bone') bindScale.set(o, o.scale.clone()); });
    root.updateMatrixWorld(true);     // bind world matrices must be real before capture
    // Bind locals plus the parent's bind world scale for EVERY model, for _reseatUndriven: an undriven weapon bone
    // (charm, strap, extra mag) kept an inch local read as metres, flinging specks far off and dragging framing.
    const bind = new Map();
    root.traverse(o => {
      if (o.isBone || o.type === 'Bone') {
        bind.set(o, {
          p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(),
          pws: o.parent ? new THREE.Vector3().setFromMatrixScale(o.parent.matrixWorld).x : 1,
        });
        if (skinEditable) {
          this.joints.set(o.name, o);
          this._armBind.set(o, bind.get(o));
        }
      }
      if (o.isSkinnedMesh && skinEditable) {
        this.skinned.push(o);
        prepareSkinnedMesh(o, this.hiUniforms, this.meshBoneIndex, { flatten: false });
        this.origInverses.set(o, o.skeleton.boneInverses.map(m => m.clone()));
      }
    });
    return { root, byName: indexByName(root), bindScale, bind };
  }

  // Whose hands: 'stock' = the CS2 glove model, which IS the whole arm (adding weapon_arms z-fights); 'model' = the
  // character's own v_arms group; 'agent:<id>' = a default agent's baked arms. All retarget into `this.arm`.
  async setArmsSource(kind) {
    if (kind?.startsWith('agent:') && !this.agents.some(a => `agent:${a.id}` === kind))
      throw new Error(`no baked arms for ${kind}`);
    this.armsSource = kind;
    return this._reloadArm();
  }

  // Candidate arm models, best first. `<glove>_armrig.glb` is the glove mesh on weapon_arms' full 82-bone skeleton
  // the clips drive; the standalone 52-bone glove rig lacks the parent chain, so its twist constraints shear the
  // wrist. fullfinger, hardknuckle and fingerless ship one glove material, have no armrig, and fall back.
  _armUrls() {
    const src = this.armsSource || 'stock';
    // An agent GLB is already exactly the first-person arm (firstperson_default only, full skeleton). Follow the
    // manifest's glb, not the id: agents with byte-identical arms share one file.
    if (src.startsWith('agent:')) {
      const id = src.slice(6);
      const a = this.agents.find(x => x.id === id);
      return [`${this.base}agents/${a?.glb || `${id}.glb`}`];
    }
    // The armrig is NOT YET the default: it poses correctly, but SpliceGloveMesh REPLACES weapon_arms' single mesh
    // instead of merging, losing the forearms. Until the splice keeps both, the standalone glove renders right.
    if (src !== 'model') {
      return [`${this.base}gloves/${this.gloveId}.glb`];
    }
    // A library model's hands come from its own first-person export; anything
    // else (a scratchpad glb) carries its arms in the one file.
    return [firstPersonArmsUrl(this.cfg.model) || assetUrl(this.cfg.tpBase, this.cfg.model)];
  }

  // Picking a glove is choosing STOCK hands - unless the caller explicitly
  // keeps the model's own (the lab's arms toggle passes true).
  async setGlove(type, useModel = this.armsSource === 'model') {
    this.gloveId = type;
    this.armsSource = useModel ? 'model' : 'stock';
    return this._reloadArm();
  }

  // The glove model's arm wears the agent's skin: its bare_arm is generic, the agent's carries tone and tattoos on
  // the same geometry. The source material is on the agent model even though only its sleeve draws.
  _wearAgentSkin() {
    if (!this.sleeves || !this.arm) return;
    let skin = null;
    this.sleeves.root.traverse(o => {
      if (skin || !o.isSkinnedMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material]))
        if (m && /^bare_arm/i.test(m.name || '')) { skin = m; break; }
    });
    if (!skin?.map) return;
    this.arm.root.traverse(o => {
      if (!o.isSkinnedMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m || !/^bare_arm/i.test(m.name || '')) continue;
        m.map = skin.map;
        if (skin.normalMap) m.normalMap = skin.normalMap;
        m.needsUpdate = true;
      }
    });
  }

  // Show a sleeve over the current arms (null clears). `spec` is a baked agent id or a library character
  // { url, label }; only sleeve meshes are kept (the glove is the whole arm). 5 of 22 sampled library models
  // ship a mesh named `sleeve` beside `firstperson_arms`, so this is the corpus convention.
  async setSleeveOverlay(spec) {
    if (this.sleeves) {
      this._dropRoot(this.sleeves.root);
      this.sleeves = null;
    }
    if (!spec) return null;
    const model = typeof spec === 'object' ? spec : null;
    const agentId = model ? null : spec;
    const a = agentId ? this.agents.find(x => x.id === agentId) : null;
    if (!model && !a) return null;
    const url = model ? model.url : `${this.base}agents/${a.glb}`;
    const label = model ? (model.label || 'model') : a.label;
    try { this.sleeves = await this._loadModel(url, { kind: 'arms' }); }
    catch (e) { this.log(`sleeves for ${label} failed to load (${e.message ?? e})`); return null; }
    this._upgradeMaterials(this.sleeves.root, url);
    let kept = 0;
    this.sleeves.root.traverse(o => {
      if (!o.isSkinnedMesh) return;
      o.visible = /sleeve/i.test(o.name || '');
      if (o.visible) kept++;
    });
    // The sleeve needs its twist constraints (CTiltTwistConstraints glTF cannot carry) more than the arm: ~79% of
    // its weight is on arm_lower_R_TWIST1, which no driver rig has, so unbound the cuff and watch floated off the
    // wrist. A model with no sleeve mesh is dropped rather than kept invisible holding memory.
    if (kept === 0) {
      this._dropRoot(this.sleeves.root);
      this.sleeves = null;
      this.log(`sleeves → ${label}: none shipped (the glove supplies the whole arm)`);
      return null;
    }
    this.sleeves.twistSolve =
      this._twistSolveFor(this.sleeves.byName, this.sleeves.bind, await this._twistTableFor(agentId));
    this._wearAgentSkin();
    this.log(`sleeves → ${label} (${kept} mesh${kept === 1 ? '' : 'es'})`);
    return this.sleeves;
  }

  // The arms a deferred source skipped, on the first entry to first person.
  async loadArms() {
    if (!this._armsDeferred) return this.arm;
    return this._reloadArm();
  }

  async _reloadArm() {
    this._armsDeferred = false;
    // The outgoing arm stays drawn (no longer posed) until the new one lands, so a glove change reads as a change,
    // not a dropout. `_prevArmRoot` is on the instance because a fallback re-enters this method.
    if (this.arm) {
      if (!this._prevArmRoot) {
        this._prevArmRoot = this.arm.root;
        // Whatever the outgoing arm's visibility was IS the policy - hidden in
        // an orbit view, shown in first person. The replacement inherits it, so
        // a reveal can never light up hands the current view does not want.
        this._prevArmVisible = this.arm.root.visible;
      }
      for (const m of this.skinned) { this.origInverses.delete(m); this.meshBoneIndex.delete(m); }
      this.skinned.length = 0;
      this.joints.clear();
      this._armBind.clear();
      this.hiUniforms.length = 0;
      this.arm = null;
      this._twistSolve = null;
    }
    // First candidate that loads wins; a glove with no spliced arm-rig simply
    // falls back to its standalone model.
    const candidates = this._armUrls();
    let armUrl = null;
    for (const u of candidates) {
      try {
        const loaded = await this._loadModel(u, { skinEditable: true, kind: 'arms' });
        // _loadModel adds to the scene as it loads, so a reload that overlapped this one would leave an untracked
        // second pair of hands: drop whatever `this.arm` is now, then take ownership.
        if (this.arm && this.arm.root !== loaded.root) this._dropRoot(this.arm.root);
        // Already drawing, but unpainted and unposed (upgrade, twist bind and composite still to run): keep it dark
        // until the caller says ready, or a black glove flashes before the paint lands.
        loaded.root.visible = false;
        this.arm = loaded;
        armUrl = u;
        break;
      } catch { /* try the next candidate */ }
    }
    if (!armUrl) {
      // Nothing loaded - the old arm is still on screen and no longer tracked,
      // which is a frozen pair of hands. Take it down rather than leave a pose
      // that will never update again.
      this._retireArm();
      throw new Error(`no arm model loaded (tried ${candidates.join(', ')})`);
    }
    // Upgrade after _loadModel's prepareSkinnedMesh: it CLONES each material and installs the bone-highlight
    // patch, so the upgrade lands on the clones and chains onto it (chainBeforeCompile) instead of being lost.
    this._upgradeMaterials(this.arm.root, armUrl);
    if (this.armsSource === 'model' && firstPersonArmsUrl(this.cfg.model)) {
      // The `?meshes=fparms` export already holds only the viewmodel meshes (picked from mesh-group masks, else
      // 404), so do not filter: the `v_`/`sleeve` name test would hide arms named otherwise.
      this.log(`arms → ${this.cfg.model} first-person export (${this.joints.size} bones)`);
    } else if (this.armsSource === 'model') {
      // No library URL for a dedicated export, so pick the first-person groups here. Convention (GFL agents):
      // v_-prefixed groups plus FP-only `sleeves` (body-mask 0xC); v_arms alone hid vector, whose group is v_gloves.
      const groupOf = (o) => {
        for (const n of [o.name || '', o.parent?.name || '']) {
          const i = n.lastIndexOf('vmdl_c');
          if (i >= 0) return n.slice(i + 6).toLowerCase();
        }
        return (o.name || '').toLowerCase();
      };
      const isFp = (g) => /^v_/.test(g) || /^sleeve/.test(g);
      let kept = 0;
      this.arm.root.traverse(o => {
        if (!o.isSkinnedMesh) return;
        o.visible = isFp(groupOf(o));
        if (o.visible) kept++;
      });
      this.log(`arms → ${this.cfg.model} first-person groups (${kept} meshes, ${this.joints.size} bones)`);
      if (!kept) {
        // No FP groups at all: fall back to the stock glove rather than empty
        // hands, and say so.
        this.log('that model ships no first-person mesh groups - using stock gloves instead');
        this.armsSource = 'stock';
        return this._reloadArm();
      }
    } else if (this.armsSource?.startsWith('agent:')) {
      const id = this.armsSource.slice(6);
      const label = this.agents.find(a => a.id === id)?.label || id;
      this.log(`arms → default agent ${label} (${this.joints.size} bones)`);
    } else {
      this.log(`arms → stock glove ${this.gloveId} (${this.joints.size} bones)`);
    }
    this._bindTwists(await this._twistTableFor());
    this._wearAgentSkin();
    this.auditArms();
    // Showable now unless a caller holds the swap open to paint it first. Reveal by default: a caller that forgot
    // to release would otherwise leave no hands at all.
    if (!this._armHold) this.revealArm();
    return this.arm;
  }

  // Put the incoming arm on screen and take the outgoing one down, in that
  // order, so there is never a frame with neither.
  revealArm() {
    const prev = this._prevArmRoot;
    this._prevArmRoot = null;
    if (this.arm) this.arm.root.visible = this._prevArmVisible !== false;
    if (prev && prev !== this.arm?.root) this._dropRoot(prev);
  }

  // Drop the outgoing arm without a replacement - only for a load that failed,
  // where the alternative is a frozen pose that will never update again.
  _retireArm() {
    const prev = this._prevArmRoot;
    this._prevArmRoot = null;
    this._dropRoot(prev);
  }

  // Take a loaded root out of the scene for good: its CS2 controller (or the frame loop keeps ticking it) and
  // its GPU resources, sparing what a root still drawn borrowed from it (the agent's arm skin on the glove).
  _dropRoot(root) {
    if (!root) return;
    this.group.remove(root);
    releaseCs2(this._cs2.get(root));
    this._cs2.delete(root);
    const live = [this.rig?.root, this.arm?.root, this._prevArmRoot, this.sleeves?.root, this.weapon?.root];
    disposeObject(root, { keep: resourcesOf(...live.filter(r => r && r !== root)) });
  }

  // Everything this source loaded, for a viewer that is done with it.
  dispose() {
    for (const ctl of this._cs2.values()) releaseCs2(ctl);
    this._cs2.clear();
    this._disposePaint();
    this._paintPlaceholder?.dispose();
    this._paintPlaceholder = null;
    disposeObject(this.group);
  }

  // Hold the swap open across a multi-step hand change so the arms change over once. Always release in a
  // `finally`: releaseArmSwap reveals whatever loaded, so a failure still ends with hands on screen.
  holdArmSwap() { this._armHold = (this._armHold || 0) + 1; }
  releaseArmSwap() {
    if (this._armHold) this._armHold--;
    if (!this._armHold) this.revealArm();
  }

  // Which twist table drives this arm: stock gloves share one; agents ship their own per model (today's agent
  // entries match the glove table, a measured fact, not a contract). `agentId` names the sleeve's agent directly.
  async _twistTableFor(agentId = null) {
    const src = this.armsSource || '';
    if (!agentId && !src.startsWith('agent:')) return this._twistTable;
    const id = agentId || src.slice(6);
    if (!this._agentTwists.has(id)) {
      let t = null;
      try {
        const file = this.agents.find(a => a.id === id)?.constraints;
        if (file) {
          const r = await fetch(`${this.base}agents/${file}`);
          if (r.ok) t = (await r.json()).twists;
        }
      } catch { /* absent table = the twist helpers sit at bind */ }
      this._agentTwists.set(id, t);
    }
    return this._agentTwists.get(id);
  }

  // CS2 drives the arm twist helpers with CTiltTwistConstraints (glTF cannot carry them); they hold ~35% of the
  // arm's weight, so at bind the wrist candy-wraps. Wiring from tools/fp-arm-constraints.py. The solve uses the
  // delta from the arm's own bind (basis-invariant): five attempts with qOffset sheared the cuffs.
  _bindTwists(table = this._twistTable) {
    this._twistSolve = null;
    if (!table || !this.arm) return;
    this._twistSolve = this._twistSolveFor(this.joints, this._armBind, table);
    if (this.cfg.log && this._twistSolve)
      this.log(`arm twist constraints → ${this._twistSolve.size} of ${table.length} bound`);
  }

  // The solve itself, for ANY model's bones and bind - the arm, or an agent's
  // sleeve. Pure: it reads the two maps and returns a solve, so the caller
  // decides where to hang it.
  _twistSolveFor(byName, bind, table) {
    if (!table || !byName || !bind) return null;
    const solve = new Map();
    for (const c of table) {
      const slave = byName.get(c.slave);
      const target = byName.get(c.target);
      const sb = slave && bind.get(slave);
      const tb = target && bind.get(target);
      if (!slave || !target || !sb || !tb) continue;
      solve.set(slave, {
        target,
        weight: c.weight,
        // Forearm twists are siblings of their target, so the delta applies in the shared parent frame; upper-arm
        // twists are children, so it is taken in the target's own rest frame.
        sibling: slave.parent === target.parent,
        bindQ: sb.q,
        tBindInv: tb.q.clone().invert(),
      });
    }
    return solve.size ? solve : null;
  }

  // A retargeted skinned mesh collapsing to its bone origins means the bake's inverse-bind does not match the
  // driver skeleton (an unrecognisable speck); detect it rather than show empty hands.
  _weaponHealth(model) {
    let mesh = null;
    model.root.traverse(o => { if (!mesh && o.isSkinnedMesh) mesh = o; });
    if (!mesh) return { ok: true, ratio: null };     // static mesh, nothing to check
    const pos = mesh.geometry.attributes.position;
    const v = new THREE.Vector3(), box = new THREE.Box3();
    const stride = Math.max(1, (pos.count / 200) | 0);
    for (let i = 0; i < pos.count; i += stride) { mesh.getVertexPosition(i, v); box.expandByPoint(v); }
    const raw = new THREE.Box3().setFromBufferAttribute(pos);
    const rawLen = raw.getSize(new THREE.Vector3()).length();
    const skinLen = box.getSize(new THREE.Vector3()).length();
    // Per-class bakes store metres, root-level bakes inches with the conversion in the bind. Test each separately
    // within 2x: "close to either" would accept a mesh collapsed by exactly the 39.37 they differ by.
    const asMetres = skinLen / Math.max(rawLen, 1e-6);
    const asInches = skinLen / Math.max(rawLen * IN, 1e-6);
    const near1 = r => r > 0.5 && r < 2;
    return {
      ok: near1(asMetres) || near1(asInches),
      metres: +asMetres.toFixed(3), inches: +asInches.toFixed(3),
    };
  }

  // Only the AK has a usable root-level bake; falling back to it would silently show an AK for a knife, so it is
  // opt-in per weapon. A library weapon has no stock fallback, which would misreport the library model.
  _modelCandidates() {
    if (this._libEntry) return [assetUrl(this.cfg.tpBase, this._libEntry.model)];
    const perClass = `${this.assetBase()}weapon_stock.glb`;
    return this.weaponId === 'rifle_ak'
      ? [perClass, `${this.base}weapon_stock.glb`]
      : [perClass];
  }

  // Run Source 2 material semantics (packed roughness/metalness, metalness falloff, self-illum) on the weapon and
  // arms; safe on arms because the bone-highlight patch and this chain onto the same onBeforeCompile.
  _upgradeMaterials(root, url) {
    const ctl = upgradeCs2Materials(THREE, root, {
      // These resolve with `$ent_ammo` and friends, so they need the `ent_` prefix the expressions spell; without
      // it the seed was inert and left-handed art flips never fired.
      ent: { ent_ammo: 30, ent_ironsight: 0, ent_viewmodel_lefthanded: this.mirrored ? 1 : 0 },
      texUrl: matTexUrl(matTexBaseFor(url)),
    });
    if (!ctl) return;
    this._cs2.set(root, ctl);
    this.log(`cs2 materials → ${url.split('/').pop()}: ${ctl.materialCount} upgraded`
      + (ctl.animated ? ' (animated)' : ''));
  }

  // Paint a stock CS2 kit via window.__skinComposite, skin-viewer.jsx's game-verified 1:1 port of CS2's composite
  // shader: this owns the rig and the compositor the paint (a second copy would drift). The handles are live:
  // recompose(seed, wear) repaints the same render targets for the sliders.
  async _applyPaint(root) {
    const paint = this._libEntry?.paint;
    const SC = globalThis.__skinComposite;
    if (!paint?.recipe) return;
    if (!SC?.applyRecipeMaterials || !this.cfg.renderer) {
      this.log('paint kit: no compositor (skin-viewer.js not loaded) - showing base textures');
      return;
    }
    this._disposePaint();
    this._paintPlaceholder = this._paintPlaceholder || SC.makePlaceholderTex(THREE);
    try {
      const { composites, textures } = await SC.applyRecipeMaterials(
        THREE, this.cfg.renderer, this._paintPlaceholder, root,
        paint.recipe, paint.seed, paint.wear,
        // This renders far larger than the panel the compositor was written
        // for, so its textures get the device's full anisotropy rather than
        // the none they needed at 460px.
        { anisotropy: this.cfg.renderer.capabilities.getMaxAnisotropy() });
      this._paintComposites = composites;
      this._paintTextures = textures || [];
      this.log(`paint kit -> ${paint.recipe.model?.id}: ${composites.length} composite passes`);
    } catch (e) {
      this.log(`paint kit failed (${e.message ?? e}) - showing base textures`);
    }
  }

  // Repaint at a new float/seed without touching geometry, materials or the rig.
  setPaint(seed, wear) {
    const paint = this._libEntry?.paint;
    if (!paint || !this._paintComposites?.length) return false;
    paint.seed = seed; paint.wear = wear;
    for (const c of this._paintComposites) c.recompose?.(seed, wear);
    return true;
  }

  _disposePaint() {
    for (const c of this._paintComposites || []) { try { c.dispose?.(); } catch { /* already gone */ } }
    for (const t of this._paintTextures || []) t.dispose();
    this._paintComposites = null;
    this._paintTextures = null;
  }

  async _loadWeaponModel(candidateIndex = 0) {
    if (this.weapon) { this._dropRoot(this.weapon.root); this.weapon = null; }
    this._disposePaint();
    const candidates = this._modelCandidates();
    for (let i = candidateIndex; i < candidates.length; i++) {
      try {
        this.weapon = await this._loadModel(candidates[i]);
        // Every byte this source will fetch is now in. What can still follow is
        // the paint composite, which is GPU work with no bytes to count - so a
        // byte bar has to stop here and say so rather than sit at 100%.
        this.cfg.onPhase?.(this.uid, 'downloaded');
        // Stock models only: hide meshes skinned entirely to undriven bones. The dualies' chest holster rides the
        // outfit attachment system in game and renders as a giant ribbon over the camera at bind. Community models
        // are exempt: charms and straps legitimately hang off undriven bones and must render.
        if (!this._libEntry) this._hideAttachmentMeshes(this.weapon);
        this._hideLooseRounds(this.weapon);
        // A paint kit brings its own material definitions, so the recipe builds
        // them; the glb's vmat extras describe the UNPAINTED weapon and running
        // both would just have the second overwrite the first.
        if (this._libEntry?.paint) await this._applyPaint(this.weapon.root);
        else this._upgradeMaterials(this.weapon.root, candidates[i]);
        this._candidateIndex = i;
        // The bind pose hides the fault - a mismatched bind only collapses once
        // the graph actually poses the rig - so the check waits for live frames.
        this._healthPending = 12;
        this._focusDirty = true;
        return;
      } catch (e) {
        this.log(`weapon ${candidates[i]} failed to load (${e.message ?? e})`);
      }
    }
    this.weaponBroken = candidates[candidates.length - 1] ?? null;
    this._focusDirty = true;
  }

  // Hide a LOOSE ROUND: the Nova's `nova_bullet` shell rides a reload-driven `shell` bone (so the undriven-bone
  // rule misses it) and floats over the buttstock at idle. Matched on material name: across all 63 stock
  // weapons exactly one material (`nova_bullet`) matches.
  _hideLooseRounds(model) {
    if (!model?.root) return;
    model.root.traverse(o => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      if (!o.visible) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (!mats.some(m => /bullet|shell|casing|cartridge/i.test(m?.name || ''))) return;
      o.visible = false;
      this.log(`loose round hidden: ${(mats.map(m => m?.name).join(',') || '?')}`);
    });
  }

  _hideAttachmentMeshes(model) {
    model.root.traverse(o => {
      if (!o.isSkinnedMesh || !o.visible) return;
      const g = o.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      if (!si || !sw) return;
      const stride = Math.max(1, (si.count / 400) | 0);
      for (let i = 0; i < si.count; i += stride) {
        for (const c of ['X', 'Y', 'Z', 'W']) {
          if (sw[`get${c}`](i) <= 0.01) continue;
          const nm = o.skeleton.bones[si[`get${c}`](i)]?.name;
          if (nm && this.rig?.byName.get(nm)) return;   // any driven weight -> keep
        }
      }
      o.visible = false;
      this.log(`stock mesh ${o.name.slice(-30)} hidden - skinned only to bones no clip skeleton drives`);
    });
  }

  // Which bones this arm mesh hangs off and whether the rig drives them. Reported, not judged: stock arms put ~35%
  // of their weight on twist helpers the rig lacks and render fine; check it first when arms deform oddly.
  auditArms() {
    const weight = new Map();
    for (const mesh of this.skinned) {
      // A character GLB carries its whole body; only the visible meshes are the
      // arms being rendered, and the rest would swamp the tally with spine and
      // head weight that is irrelevant here.
      if (!mesh.visible) continue;
      const g = mesh.geometry, idx = g.index;
      const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      if (!si || !sw) continue;
      const n = idx ? idx.count : si.count;
      const step = Math.max(1, (n / 6000) | 0);
      for (let i = 0; i < n; i += step) {
        const vi = idx ? idx.getX(i) : i;
        for (const c of ['X', 'Y', 'Z', 'W']) {
          const wt = sw[`get${c}`](vi);
          if (wt <= 0.01) continue;
          const nm = mesh.skeleton.bones[si[`get${c}`](vi)]?.name;
          if (nm) weight.set(nm, (weight.get(nm) || 0) + wt);
        }
      }
    }
    const total = [...weight.values()].reduce((a, b) => a + b, 0) || 1;
    let undriven = 0;
    const worst = [];
    for (const [nm, w] of weight) {
      if (this.rig?.byName.get(nm)) continue;
      undriven += w;
      worst.push([nm, w / total]);
    }
    const pct = 100 * undriven / total;
    worst.sort((a, b) => b[1] - a[1]);
    const report = { undrivenPct: +pct.toFixed(1), worst: worst.slice(0, 4).map(([n, w]) => `${n} ${(100 * w).toFixed(1)}%`) };
    if (this.cfg.log) {
      this.log(`arms rig: ${report.undrivenPct}% of the weight is on bones the viewmodel rig `
        + `does not drive (${report.worst.join(', ') || 'none'}); the stock arms sit near 35%.`);
    }
    return report;
  }

  // Runs a few frames after a weapon loads, once the graph has posed the rig.
  _checkWeaponHealth() {
    const h = this._weaponHealth(this.weapon);
    if (h.ok) return;
    const candidates = this._modelCandidates();
    const bad = candidates[this._candidateIndex];
    this.log(`weapon bake BROKEN: ${bad} collapses once the graph poses the rig `
      + `(skinned/raw ${h.metres} as metres, ${h.inches} as inches) - needs a re-bake`);
    this._dropRoot(this.weapon.root);
    this.weapon = null;
    this._disposePaint();
    if (this._candidateIndex + 1 < candidates.length) {
      this._loadWeaponModel(this._candidateIndex + 1)
        .then(() => this.log(`weapon → ${candidates[this._candidateIndex]} (fallback)`));
    } else {
      this.weaponBroken = bad;
    }
  }

  // Not every weapon in the registry has a complete bake. A half-applied switch
  // would leave a rig with no graph, so the previous weapon is restored on
  // failure and the caller is told which one is missing.
  async setWeapon(id) {
    if (id === this.selectedId) return;
    const prevSel = this.selectedId, prevLib = this._libEntry;
    const lib = this.libWeapons.get(id) ?? null;
    const chassis = lib ? lib.base : id;
    this.selectedId = id;
    this._libEntry = lib;
    try {
      if (chassis === this.weaponId) {  // same chassis, different skin: swap only the model
        await this._loadWeaponModel();
        // Same graph, possibly mid-anything: a plain deploy is refused during a running draw, so the next skin
        // appeared halfway through the last one's draw; redeploy restarts it.
        this.wc.redeploy();
      } else {
        await this._setChassis(chassis);
      }
    } catch (e) {
      this.selectedId = prevSel;
      this._libEntry = prevLib;
      throw e;
    }
  }

  async _setChassis(id) {
    const prev = this.weaponId;
    const prevRig = this.rig;
    const prevGraph = this.graph;
    this.weaponId = id;
    this._rigReady = false;       // freeze retargeting across the swap
    try {
      this.rig = null;
      await this._loadRig();
      await this._buildEvaluator();
    } catch (e) {
      if (this.rig) this._dropRoot(this.rig.root);
      this.weaponId = prev;
      this.rig = prevRig;
      this.graph = prevGraph;
      this.wc.bind(prevGraph);
      this._rigReady = true;
      throw new Error(`${id} has no complete bake (${e.message ?? e})`);
    }
    if (prevRig) this._dropRoot(prevRig.root);
    this._restoreArmBind();
    this._rigReady = true;
    await this._loadWeaponModel();
    this.wc.deploy();
  }

  // Retarget only overwrites bones the driver has, so a bone the new rig skips kept the old weapon's pose and
  // stretched the flesh; resetting to bind first leaves it at bind.
  _restoreArmBind() {
    for (const [bone, b] of this._armBind) {
      bone.position.copy(b.p); bone.quaternion.copy(b.q); bone.scale.copy(b.s);
    }
    this.arm?.root.updateMatrixWorld(true);
  }

  // per-frame
  update(dt, playing) {
    // Left-handed is a MIRROR, not an animation: CS2 ships no hand-switch clip and cl_righthand flips the viewmodel
    // transform. Only on change: assigning every frame forced a full updateMatrixWorld down the hierarchy.
    const sx = this.mirrored ? -1 : 1;
    if (this.group.scale.x !== sx) this.group.scale.x = sx;
    if (!this._rigReady || !this.rig || !this.graph) return;
    if (this.editClip) {
      this._applyPoseToRig(this.editClip.sample(this.editTime, this._editPose.clear()));
      this._applyEditDeltas();
      this.retarget(this.arm);
      this.retarget(this.sleeves);
      this.retarget(this.weapon, true);
      return;
    }
    const step = playing ? dt : 0;
    this._applyPoseToRig(this.graph.update(step));
    this.wc.tick(step);
    this.retarget(this.arm);
    this.retarget(this.sleeves);
    this.retarget(this.weapon, true);
    if (this._healthPending > 0 && this.weapon && --this._healthPending === 0) this._checkWeaponHealth();
  }

  // Offset first, along the bone's own axes as the clip posed them, then the rotation after its
  // own: AnimKeys applies them in that order, in game units, to the same local transforms.
  _applyEditDeltas() {
    for (const [name, d] of this.editDeltas) {
      const b = this.rig.byName.get(name);
      if (!b || !b.isBone) continue;
      if (d.o) b.position.add(this._eo.copy(d.o).multiplyScalar(this._localPerUnit(b)).applyQuaternion(b.quaternion));
      if (d.q) b.quaternion.multiply(d.q);
    }
  }

  // Local units per game unit (inch) for a bone. The bakes disagree: the AK's clips carry inches
  // under a 0.0254 node, the M4A4's metres (measured 2026-09-28), but a game unit is always 0.0254 m
  // in this scene, so the parent's world scale says which a bone is in.
  _localPerUnit(b) {
    b.parent.getWorldScale(this._eo);
    return IN / (Math.abs(this._eo.x) || 1);
  }

  // Enter the clip mode on `name` (a stock or overridden clip of this weapon), or leave it with null.
  async setEditClip(name) {
    if (!name) { this.editClip = null; this.editDeltas = new Map(); this.wc.deploy?.(); return; }
    const g = await loadGltf(this.clipUrl(name), this._onAsset('clip'));
    this.editClip = new this._ag2.clip.ClipSource(g.animations[0]);
    this._editPose = new this._ag2.clip.Pose();
    this.editTime = Math.min(this.editTime, this.editClip.duration);
  }

  // The driver rig's bones for an outliner: name, parent and which skeleton (arms or weapon).
  editBones() {
    if (!this.rig) return [];
    const weaponRoot = this.rig.weaponSkelRoot;
    const out = [];
    this.rig.root.traverse(o => {
      if (!(o.isBone || o.type === 'Bone')) return;
      let p = o.parent, onWeapon = false;
      for (let a = o; a; a = a.parent) if (a === weaponRoot) { onWeapon = true; break; }
      while (p && !(p.isBone || p.type === 'Bone')) p = p.parent;
      out.push({ name: o.name, parent: p?.name ?? null, skeleton: onWeapon ? 'weapon' : 'arms' });
    });
    return out;
  }

  // Where a bone is drawn: the VISIBLE model's bone (the weapon is rebased through the rig's `wpn`
  // attachment, so the driver's weapon bones sit somewhere else), falling back to the driver.
  editBoneObject(name) {
    for (const m of [this.weapon, this.arm]) {
      const o = m?.root?.getObjectByName(name);
      if (o && (o.isBone || o.type === 'Bone')) return o;
    }
    return this.rig?.byName.get(name) ?? null;
  }

  // World units per game unit: one inch, since the scene is in metres (see _localPerUnit). The
  // visible models are rebased rigidly, so a move there is the same size as on the driver.
  editUnitScale() { return IN; }

  _applyPoseToRig(pose) {
    for (const [name, p] of pose.bones) {
      const b = this.rig.byName.get(name);
      if (b && b.isBone) { b.position.copy(p.pos); b.quaternion.copy(p.quat); b.scale.copy(p.scale); }
    }
  }

  // Copy driver-rig world transforms onto same-named model bones. The weapon's
  // skeleton is authored in its own space, so it is rebased through the rig's
  // `wpn` attachment point instead of being copied outright.
  retarget(model, asWeapon = false) {
    if (!this.rig || !model) return;
    // The model's own bind, so an undriven bone is reseated rather than holding a stale local. The arm uses the
    // shared _armBind because the bone editor writes into it.
    const bind = model === this.arm ? this._armBind : model.bind;
    // Each model solves its OWN twists. _twistSolve is keyed by bone OBJECT, so
    // the arm's solve says nothing about a sleeve's identically-named bones.
    const twist = model === this.arm ? this._twistSolve : model.twistSolve;
    const ref = this.rig.weaponBone ?? this.rig.weaponSkelRoot;
    const rebase = asWeapon && this.rig.attach && ref;
    if (rebase) {
      this._skelInv.copy(ref.matrixWorld).invert();
      this._attach.copy(this.rig.attach.matrixWorld).multiply(this._skelInv);
    }
    const walk = (node) => {
      const driver = node.isBone ? this._driverFor(node.name) : null;
      if (driver) {
        this._m.copy(driver.matrixWorld);
        if (rebase) this._m.premultiply(this._attach);
        this._inv.copy(node.parent.matrixWorld).invert();
        this._m.premultiply(this._inv);
        this._m.decompose(node.position, node.quaternion, node.scale);
        // Scale is bind convention, not animation (inch locals under an inch->metre node; 0.0254 on a weapon root
        // bone). The driver's scale makes matrixWorld * boneInverse non-rigid: flesh collapses or inflates.
        const bs = model.bindScale?.get(node) ?? (bind?.has(node) ? bind.get(node).s : null);
        if (bs) node.scale.copy(bs);
      } else if (node.isBone && bind?.has(node)) {
        this._reseatUndriven(node, bind.get(node), twist);
      }
      node.updateWorldMatrix(false, false);
      for (const c of node.children) walk(c);
    };
    model.root.updateWorldMatrix(true, false);
    for (const c of model.root.children) walk(c);
  }

  // The driver bone for a model bone, including a TWIN RIG's `_pt` chain (aemeath's sleeve ribbons hang under
  // arm_upper_l_pt). Unmatched, the whole chain reseated ~1.5m up and stretched triangles across the view. A twin
  // takes its counterpart's driver (case-insensitive: arm_upper_l_pt vs arm_upper_L), else it reseats as before.
  _driverFor(name) {
    const direct = this.rig.byName.get(name);
    if (direct || !/_pt$/i.test(name)) return direct || null;
    if (this._rigLowerFor !== this.rig) {          // rebuilt whenever the rig changes
      this._rigLower = new Map();
      for (const [n, b] of this.rig.byName) this._rigLower.set(n.toLowerCase(), b);
      this._rigLowerFor = this.rig;
    }
    return this._rigLower.get(name.slice(0, -3).toLowerCase()) || null;
  }

  // Undriven bones (the twist helpers most rigs lack) keep inch bind locals now read as metres after retarget
  // (a 7.4-inch bone lands 7.4 m away), so re-express the bind offset in the parent's current space.
  _reseatUndriven(node, b, twist = this._twistSolve) {
    const sp = this._sv.setFromMatrixScale(node.parent.matrixWorld).x || 1;
    node.position.copy(b.p).multiplyScalar(b.pws / sp);
    node.quaternion.copy(b.q);
    node.scale.copy(b.s);
    // A twist helper does not stay at bind: CS2 constrains it to a weighted share of its target's roll. Scene
    // order poses parents and hand_* before twist siblings, so the target's local is already this frame's.
    const c = twist?.get(node);
    if (!c) return;
    const d = this._tq;
    if (c.sibling) d.copy(c.target.quaternion).multiply(c.tBindInv);   // shared-parent frame
    else d.copy(c.tBindInv).multiply(c.target.quaternion);             // target's rest frame
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);                        // shortest arc
    // Twist component about the bone axis (X for every authored entry), scaled
    // by the authored weight; negative weights counter-rotate (upper arm).
    const ang = 2 * Math.atan2(d.x, d.w) * c.weight;
    node.quaternion.multiplyQuaternions(
      d.setFromAxisAngle(this._tAxisX, ang), c.bindQ);
  }

  // camera
  vfov() { return vfovFromHfov(this.fovH, SOURCE_FOV_ASPECT); }

  _barrelCentre(out) {
    const tip = this.rig?.byName.get('wpnTip'), end = this.rig?.byName.get('wpnEnd');
    if (!tip || !end) return false;
    tip.getWorldPosition(this._bt); end.getWorldPosition(this._be);
    out.copy(this._bt).add(this._be).multiplyScalar(0.5);
    return true;
  }

  // viewmodel_offset_* moves the viewmodel relative to the eye; the pose driver rewrites every bone, so the camera
  // takes the opposite shift. Measured signs (screen-right is world -X): +x -> camera +X, +z -> -Y, +y -> -Z.
  // Left-handed play mirrors the viewmodel and negates offset_x (client.dll).
  eyeCamShift(out) {
    const sx = this.mirrored ? -1 : 1;
    const c = (v, lim) => Math.max(-lim, Math.min(lim, Number(v) || 0));
    const x = c(this.vmOffset.x, VM_OFFSET_RANGE.x);
    const y = c(this.vmOffset.y, VM_OFFSET_RANGE.y);
    const z = c(this.vmOffset.z, VM_OFFSET_RANGE.z);
    return out.set(
      x * sx * IN + this.camOffset.x,
      -z * IN + this.camOffset.y,
      -y * IN + this.camOffset.z,
    );
  }

  // Called every frame while the FP camera is active: the view is anchored to
  // the weapon, not to the world.
  updateCamera(camera) {
    // Framing comes off the driver rig's wpn/wpnTip bones, so a missing or
    // rejected weapon model still gives a correct view of the arms.
    if (!this.rig) return;
    camera.up.set(0, 1, 0);
    camera.fov = this.vfov();
    if (this.camView === 'eye') {
      // Authentic in-game view: the eye is at root_motion looking straight down
      // +Z. It never moves, so there is no snap when an animation shifts the gun.
      this.rig.root.updateWorldMatrix(true, true);
      const rm = this.rig.byName.get('root_motion');
      const p = this._focus;
      rm ? rm.getWorldPosition(p) : p.set(0, 0, 0);
      const o = this.eyeCamShift(this._camShift);
      const cx = p.x + o.x, cy = p.y + o.y, cz = p.z + o.z;
      camera.position.set(cx, cy, cz);
      // The look target carries the same shift so an offset is a pure translation; aiming at the un-shifted point
      // toed the camera in and cross-coupled the axes.
      camera.lookAt(cx, cy, cz + 100 * IN);
      camera.updateProjectionMatrix();
      return;
    }
    // Showcase 3/4. The focus is LATCHED while idle and frozen during an action,
    // so the camera holds still and the gun animates within the frame - a
    // per-frame follow would cancel the very motion being judged.
    if (this._focusDirty || this.wc.action === 'idle') {
      this.rig.root.updateWorldMatrix(true, true);
      if (this._barrelCentre(this._focus)) this._focusDirty = false; else return;
    }
    const b = this._focus;
    camera.position.set(b.x - 3.5 * IN + this.camOffset.x, b.y + 1 * IN + this.camOffset.y, b.z - 30 * IN + this.camOffset.z);
    camera.lookAt(b.x + 10 * IN, b.y + 1 * IN, b.z);
    camera.updateProjectionMatrix();
  }

  setCamView(v) { this.camView = v; this._focusDirty = true; }

  cameraUp() { return new THREE.Vector3(0, 1, 0); }

  // Metres, with the viewmodel 0.3-1m from the eye: 0.01 near keeps closeups
  // unclipped and the near/z ratio stays small enough that depth is solid.
  cameraClip() { return { near: 0.01, far: 200 }; }

  cameraPresets() {
    return [
      { id: 'eye',      label: 'in-game', apply: () => this.setCamView('eye') },
      { id: 'showcase', label: 'showcase', apply: () => this.setCamView('showcase') },
      // Internal: weapon mode's orbit view rides this preset by id, but FP does not list it (the weapon-alone orbit
      // IS the free camera); cameraList filters it.
      { id: 'free',     label: 'free orbit', internal: true, apply: (cam, ctl) => {
        // Frame from the rig's posed wpnTip/wpnEnd bones: Box3.setFromObject ignores skinning and on an inch bake
        // reports a ~39-unit weapon, parking the camera 30 m away.
        this.camView = 'free';
        if (!this.rig) return;
        this.rig.root.updateWorldMatrix(true, true);
        const tip = this.rig.byName.get('wpnTip'), end = this.rig.byName.get('wpnEnd');
        if (!tip || !end) return;
        tip.getWorldPosition(this._bt); end.getWorldPosition(this._be);
        const c = this._bt.clone().add(this._be).multiplyScalar(0.5);
        const span = Math.max(this._bt.distanceTo(this._be), 0.15);
        cam.fov = 45;
        const hfov = THREE.MathUtils.degToRad(hfovFromVfov(45, cam.aspect));
        const dist = (span * 0.85) / Math.tan(hfov / 2);
        cam.position.set(c.x + dist, c.y + span * 0.15, c.z);
        ctl.target.copy(c);
        cam.updateProjectionMatrix();
      } },
      { id: 'hands',    label: 'hands', apply: (cam, ctl) => {
        // Close on the glove so fingers can actually be judged while editing.
        this.camView = 'free';
        const h = this.joints.get('hand_R') || this.joints.get('hand_L');
        if (!h) return;
        const p = new THREE.Vector3().setFromMatrixPosition(h.matrixWorld);
        cam.fov = 35; cam.up.set(0, 1, 0);
        cam.position.set(p.x + 0.12, p.y + 0.08, p.z - 0.28);
        ctl.target.copy(p);
        cam.updateProjectionMatrix();
      } },
    ];
  }

  orbitEnabled() { return this.camView === 'free'; }

  setGlow(name) {
    for (const { mesh, u } of this.hiUniforms)
      u.uHiBone.value = name == null ? -1 : (this.meshBoneIndex.get(mesh)?.get(name) ?? -1);
  }

  editTarget() {
    return {
      joints: this.joints,
      skinned: this.skinned,
      origInverses: this.origInverses,
      meshBoneIndex: this.meshBoneIndex,
      setGlow: n => this.setGlow(n),
    };
  }

  clipList() { return []; }             // the graph chooses clips, not the user
  duration() { return 1; }
  seek() {}
  setVisible(on) { this.group.visible = on; }

  // What this weapon can be asked to do: an action the graph cannot answer looks broken. Knives have no reload
  // state; inspect is offered whenever the graph has it. `run(held)`: held marks a held button (see fire()).
  actions() {
    const cls = this.weaponDef().cls;
    if (cls === 'grenade') {
      const tap = (strength) => { this.wc.nadeHold(strength); this.wc.nadeRelease(); };
      return [
        { id: 'fire',    label: 'Throw',     key: 'LMB', hold: 1, run: () => tap(1) },
        { id: 'stab',    label: 'Underhand', key: 'RMB', hold: 0, run: () => tap(0) },
        { id: 'inspect', label: 'Inspect',   key: 'F',   run: () => this.wc.inspectTap() },
        { id: 'deploy',  label: 'Deploy',    key: '1',   run: () => this.wc.redeploy() },
      ];
    }
    const knife = cls === 'knife';
    if (knife) {
      const acts = [
        { id: 'fire',   label: 'Slash',  key: this.cfg.editor ? '' : 'LMB', run: (held, heldFor) => this.wc.fire(KNIFE_LIGHT, held, heldFor) },
        { id: 'stab',   label: 'Stab',   key: 'RMB', run: (held, heldFor) => this.wc.fire(KNIFE_HEAVY, held, heldFor) },
      ];
      if (this._hasInspects)
        acts.push({ id: 'inspect', label: 'Inspect', key: 'F', run: () => this.wc.inspectTap() });
      acts.push({ id: 'deploy', label: 'Deploy', key: '1', run: () => this.wc.redeploy() });
      return acts;
    }
    return [
      // The LMB hint would be a lie while the editor owns the click.
      { id: 'fire', label: 'Fire', key: this.cfg.editor ? '' : 'LMB', run: (held, heldFor) => this.wc.fire(undefined, held, heldFor) },
      { id: 'reload',  label: 'Reload',  key: 'R',   run: () => this.wc.reload() },
      { id: 'inspect', label: 'Inspect', key: 'F',   run: () => this.wc.inspectTap() },
      // redeploy, not deploy: a button called Deploy that does nothing while the
      // draw it just started is still playing reads as a dead control.
      { id: 'deploy',  label: 'Deploy',  key: '1',   run: () => this.wc.redeploy() },
    ];
  }
}
