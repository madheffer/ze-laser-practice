// First-person weapon (CS2 viewmodel arms + knife / gun). CONTRACT (main.js calls exactly these):
//
//   const vm = new Viewmodel(threeRenderer)   // THREE.WebGLRenderer shared with the world
//   await vm.load()
//   vm.setWeapon('knife' | 'gun')             // keys 3 / 1, plays the draw
//   vm.setGun(name)                           // a bought primary (lib/weapons.js GUNS name): replaces it, draws it
//   vm.gun                                    // the primary's numbers (GUNS entry); vm.gunName its vdata name
//   vm.update(dt, { speed, onGround, ducked, yawDelta, pitchDelta })   // every frame (sway/bob/landing)
//   vm.trigger(down)                          // Mouse 1 held/released
//   vm.trigger2(down)                         // Mouse 2 (knife stab)
//   vm.inspect()                              // F
//   vm.playShot(kind)                         // a replay's recorded shot: the animation only, no onShot
//   vm.onShot = (shot) => {}                  // set by main: called per bullet/slash that should be traced:
//                                             //   shot = { kind: 'bullet'|'slash'|'stab', damage, range, gun? }
//   vm.render(aspect)                         // after the world pass (own camera, viewmodel FOV 68, cleared depth)
//   vm.visible = bool
//
// The animation is CS2's own: vpkstuff's previewer engine (src/fp/, see fp.js) evaluates the game's compiled
// AnimGraph2 for each weapon, so draw, idle, slash/stab, shoot, inspect and their gating are the graph's.
// Assets: public/weapons/fp/ (the CT default agent's arms, the guns, the CT default knife, their clips and graphs).
// The knife and the primary load up front; a bought gun loads when bought (its numbers apply at once).
//
// The FIRE GATE lives here, not in the graph, and runs whether or not the visuals have loaded: shots go out on
// CS2's cadence from the first frame. When a shot is accepted the graph is told to play it.
import * as THREE from 'three';
import './fp/cs2-shade.js';             // window.CS2Shade, which cs2-material.js needs first
import './fp/cs2-material.js';            // defines window.CS2Mat (Source 2 material semantics), used by fp/util.js
import { FpSource } from './fp/fp.js';
import { tickCs2Materials } from './fp/util.js';
import { barnUniforms, patchBarns } from '../world/lighting.js';
import { METRES_PER_INCH as IN } from './fp/three-kit.js';
import { DEG } from '../world/entities/math.js';
import { GUNS, KNIFE, DEFAULT_GUN } from '../lib/weapons.js';
import { Recoil } from '../lib/recoil.js';

const FP_BASE = `${import.meta.env?.BASE_URL ?? '/'}weapons/fp/`;

// CS2's numbers for the guns and the knife: lib/weapons.js (the co-op server checks shots against them too)
// The knife graph's attack types (fp.js uses the same two): we never know at fire time whether the swing
// hit, so the miss swings play.
const KNIFE_LIGHT = 'attack_knife_lightmiss';
const KNIFE_HEAVY = 'attack_knife_heavymiss';

// The CT default agent's own first-person arms (sleeves + gloves) - what a CT holds in game.
const ARMS = 'agent:ctm_sas';

// Hand-made motion (CS2 has none of this in the graph: bob and lag are client code). Inches / degrees.
const BOB = { lat: 0.4, vert: 0.25, cycle: 0.98, refSpeed: 250 };    // CS:GO cl_bobamt_lat / _vert / cl_bobcycle
const LAG = { scale: 0.35, max: 2.5, decay: 9 };                      // degrees of trail per degree turned
const LAND_STEP = 1 / 120;                                            // the landing spring's integration step (s)

export class Viewmodel {
  constructor(renderer) {
    this.renderer = renderer;
    this.visible = true;
    this.onShot = null;
    this.weapon = 'gun';
    this.ready = false;
    this.loadError = null;

    this._t = 0;
    this._held = false; this._held2 = false;
    this._press = false; this._press2 = false;   // latched so a click shorter than a frame still fires
    this._next = 0; this._next2 = 0;              // next allowed primary / secondary time (s)
    this._deployed = false;
    this._sources = {};                          // 'gun' | 'knife' -> the FpSource on screen for that slot
    this._chassis = new Map();                   // chassis -> Promise<FpSource> (each loads once)
    this._loaded = new Set();                    // the FpSources in the scene
    this.gunName = DEFAULT_GUN;                  // the primary (lib/weapons.js GUNS)
    this.clip = this.gun.clip;                   // its magazine (the HUD reads clip / reserve / reloading)
    this.reserve = this.gun.reserve;
    this.reloading = false;
    this._reloadDone = 0;
    this.lastWeapon = 'gun';                     // what Q (lastinv) swaps back to
    this.recoil = new Recoil();                  // CS2's aim / view punch (lib/recoil.js): shots carry it, the camera shows it

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 200);
    // Lit like the world pass (render.js): a sky/ground hemisphere and a warm key, plus the same kind of
    // room environment so metal reads as metal. Key comes from above-front-left of the eye.
    this.hemi = new THREE.HemisphereLight(0xdde8ff, 0x3a3328, 1.1);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.8);
    this.sun.position.set(0.5, 1.0, -0.6);    // glTF space: +Y up, the eye looks down +Z, screen-right is -X
    this.scene.add(this.hemi, this.sun);
    this._envRT = null;

    this._resetMotion();
  }

  _resetMotion() {
    this._bobPhase = 0; this._bobAmt = 0;
    this._lagYaw = 0; this._lagPitch = 0;
    this._land = 0; this._landV = 0; this._airTime = 0; this._wasOnGround = true;
  }

  async load() {
    if (this.renderer && !this._envRT) {
      try {
        const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this._envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
        pmrem.dispose();
        this.scene.environment = this._envRT.texture;
        this.scene.environmentIntensity = 0.8;
      } catch { /* lights alone still work */ }
    }
    try {
      const gunName = this.gunName;
      const [gun, knife] = await Promise.all([this._load(this.gun.chassis), this._load(KNIFE.chassis)]);
      this._sources.knife = knife;
      if (this.gunName === gunName) this._sources.gun = gun; // else a buy during the load brings its own
      this.ready = true;
      this._show(this.weapon, true);
    } catch (e) {
      this.loadError = e;
      throw e;
    }
  }

  // A load that failed (a file missing on the host for a while, a dropped connection) is tried again rather than
  // leaving the hands gone for the rest of the page's life: app/session.js calls this at every stage start.
  retryLoad() {
    if (this.ready || !this.loadError || this._retrying) return;
    this.loadError = null;
    this._retrying = this.load().catch(() => {}).finally(() => { this._retrying = null; });
  }

  get gun() { return GUNS[this.gunName]; }

  // one chassis's viewmodel (CS2's arms + the weapon + its graph), loaded once and kept
  _load(chassis) {
    if (!this._chassis.has(chassis)) {
      const p = new FpSource({
        fpBase: FP_BASE, weapon: chassis, glove: 'fullfinger', armsSource: ARMS,
        libraryPicker: false, renderer: this.renderer, log: false,
      }, () => {}).load().then((s) => {
        s.camView = 'eye';
        s.group.visible = false;
        this.scene.add(s.group);
        this._loaded.add(s);
        return s;
      });
      p.catch(() => this._chassis.delete(chassis)); // a failed load can be tried again
      this._chassis.set(chassis, p);
    }
    return this._chassis.get(chassis);
  }

  // Put the primary's model up once it has loaded (unless another gun was picked meanwhile).
  _mountGun(name, draw) {
    delete this._sources.gun;                            // the old gun's model is off until the new one is in
    if (this.ready) this._show(this.weapon, false);
    this._load(GUNS[name].chassis).then((s) => {
      if (this.gunName !== name) return;
      this._sources.gun = s;
      if (this.ready && this.weapon === 'gun') this._show('gun', draw);
    }).catch((e) => console.error('[viewmodel] gun', name, e));
  }

  // A bought primary (CS2Fixes' buy: the old one is dropped, the new one given and switched to): a full magazine,
  // and its draw, so no shot before its m_flDeployDuration. Its numbers apply now; its model shows once loaded.
  setGun(name) {
    if (!Object.hasOwn(GUNS, name)) return false;
    this.gunName = name;
    this.clip = this.gun.clip;
    this.reserve = this.gun.reserve;
    this.reloading = false;
    if (this.weapon !== 'gun') this.lastWeapon = this.weapon;
    this.weapon = 'gun';
    this._held = this._held2 = this._press = this._press2 = false;
    this._next = this._next2 = this._t + (this._deployed ? this.gun.deploy : 0);
    this._deployed = true;
    this.recoil.index = 0;                               // m_flRecoilIndex is the weapon's: a new gun starts its pattern
    this._mountGun(name, true);
    return true;
  }

  setWeapon(w) {
    if (w !== 'gun' && w !== 'knife') return;
    if (w === this.weapon && this._deployed) return;      // CS2: re-selecting the held slot does nothing
    const first = !this._deployed;
    if (this._deployed && w !== this.weapon) this.lastWeapon = this.weapon;
    this.weapon = w;
    this._deployed = true;
    this.reloading = false;                               // switching away cancels a reload
    this.recoil.index = 0;
    this._held = this._held2 = this._press = this._press2 = false;
    // m_flDeployDuration: no attack until the draw is done (not on the very first equip at spawn).
    const lock = first ? 0 : (w === 'gun' ? this.gun : KNIFE).deploy;
    this._next = this._next2 = this._t + lock;
    if (this.ready) this._show(w, true);
  }

  _show(w, draw) {
    for (const s of this._loaded) s.group.visible = false;   // every loaded gun, not only the slots' (a bought-over one)
    const s = this._sources[w];
    if (!s) return;
    s.group.visible = true;
    if (draw) s.wc.redeploy();
  }

  // Q: CS2's lastinv, back to the previously held weapon
  swapLast() { this.setWeapon(this.lastWeapon === this.weapon ? (this.weapon === 'gun' ? 'knife' : 'gun') : this.lastWeapon); }

  // R / empty magazine: the gun's reload (no-op on the knife, at a full magazine, or mid-reload)
  reload() {
    if (this.weapon !== 'gun' || this.reloading || this.clip >= this.gun.clip) return false;
    this.reloading = true;
    this._reloadDone = this._t + this.gun.reload;
    const s = this.ready ? this._sources.gun : null;
    if (s?.wc) { s.wc.ammo = this.clip; s.wc.reload(); }
    this.onReload?.();
    return true;
  }

  // Fresh spawn: the stage's primary (the PP-Bizon; a replay's own), full magazine, knife out (ZE humans spawn
  // holding the knife) or the stage's weapon, no draw lock.
  reset(weapon = 'knife', gun = DEFAULT_GUN) {
    if (gun !== this.gunName && Object.hasOwn(GUNS, gun)) { this.gunName = gun; this._mountGun(gun, false); }
    this.reserve = this.gun.reserve;
    this.clip = this.gun.clip;
    this.reloading = false;
    this._deployed = false;
    this.recoil.reset();
    this._resetMotion();                                  // no bob, trail or landing dip carried over from the last stage
    this.lastWeapon = weapon === 'knife' ? 'gun' : 'knife';
    this.setWeapon(weapon);
  }

  trigger(down) { this._held = !!down; if (down) this._press = true; }
  trigger2(down) { this._held2 = !!down; if (down) this._press2 = true; }

  inspect() {
    const s = this._sources[this.weapon];
    if (s) s.wc.inspectTap();
  }

  update(dt, state = {}) {
    dt = Math.max(0, Math.min(dt || 0, 0.25));
    this._t += dt;
    this.recoil.tick(dt, this.gun.cycle);
    this._fireGate(dt);
    this._motion(dt, state);
    const s = this.ready ? this._sources[this.weapon] : null;
    if (s && dt > 0) {
      s.wc.tickCooldown(dt);
      s.update(dt, true);
      tickCs2Materials(this._t, { ent_ammo: s.wc.ammo, ent_viewmodel_lefthanded: 0 });
    }
  }

  // ---- shots -------------------------------------------------------------------------------------------

  _fireGate(dt) {
    const press1 = this._press;
    const want1 = this._held || this._press, want2 = this._held2 || this._press2;
    this._press = this._press2 = false;
    if (this.weapon === 'gun') {
      const g = this.gun;
      if (this.reloading) {
        if (this._t < this._reloadDone) return;
        this.reloading = false;
        this.clip = g.clip;                              // reserve stays full (infinite reserve)
        this._next = Math.max(this._next, this._t);
      }
      // Full auto (m_bIsFullAuto): keep the cadence on the cycle's grid while held (next += cycle), so frame jitter
      // cannot slow it down; a fresh pull after a pause starts a new grid. Semi-auto (AWP, SSG 08): a shot per click,
      // and a click inside the cycle is dropped, as CS2's.
      const want = g.fullAuto ? want1 : press1;
      for (let n = 0; want && this._t >= this._next && this.clip > 0 && n < (g.fullAuto ? 4 : 1); n++) {
        const late = this._t - this._next;
        this._next = late < Math.max(dt, 1 / 30) + 1e-4 ? this._next + g.cycle : this._t + g.cycle;
        this.clip--;
        this._shot({ kind: 'bullet', damage: g.damage, range: g.range, gun: g.name });
        this._play(undefined);
        this.recoil.kick(g.name);
      }
      // CS2 reloads by itself once the magazine runs dry
      if (this.clip === 0 && this._t >= this._next) this.reload();
      return;
    }
    const K = KNIFE;
    // Primary is checked first, as in CS2's ItemPostFrame; the stab goes when the slash is refused.
    if (want1 && this._t >= this._next) {
      const first = this._t > this._next + K.slash.cycle;   // CSKnife: bFirstSwing = next + 0.4 < curtime
      this._next = this._t + K.slash.cycle;
      this._next2 = this._t + K.slash.cycle2;
      this._shot({ kind: 'slash', damage: first ? K.slash.first : K.slash.follow, range: K.slash.range });
      this._play(KNIFE_LIGHT);
    } else if (want2 && this._t >= this._next2) {
      this._next = this._t + K.stab.cycle;
      this._next2 = this._t + K.stab.cycle2;
      this._shot({ kind: 'stab', damage: K.stab.damage, range: K.stab.range });
      this._play(KNIFE_HEAVY);
    }
  }

  // A replay's recorded shot (app/loop.js): the animation only; the replay traces the shot itself.
  playShot(kind) {
    if (kind === 'bullet') { if (this.weapon !== 'gun') return; this._play(undefined); this.recoil.kick(this.gunName); }
    else if (this.weapon === 'knife') this._play(kind === 'stab' ? KNIFE_HEAVY : KNIFE_LIGHT);
  }

  // every shot leaves along your view + the aim punch it was fired with (CS2: EyeAngles + the doubled punch)
  _shot(shot) {
    shot.punch = this.recoil.aimPunch(false);
    try { this.onShot?.(shot); } catch (e) { console.error('[viewmodel] onShot', e); }
  }

  // Tell the graph to play the shot. Our gate already decided, so the controller's own refire gate is opened
  // (sinceFire), and the magazine is kept topped up (infinite ammo; an empty mag would play dry fire).
  _play(attackType) {
    const s = this.ready ? this._sources[this.weapon] : null;
    if (!s?.graph) return;
    s.wc.sinceFire = 99;
    // the graph decrements its own count on fire, so hand it ours + 1 (the knife's stays topped up)
    s.wc.ammo = this.weapon === 'gun' ? this.clip + 1 : s.wc.ammoMax;
    s.wc.fire(attackType, false);
  }

  // ---- bob / lag / landing (hand-made; the shot's kick is CS2's punch, lib/recoil.js) ---------------------------------------------------------

  _motion(dt, st) {
    if (dt <= 0) return;
    const onGround = st.onGround !== false;
    const speed = Math.max(0, st.speed || 0);
    // Bob: a figure-eight whose size follows ground speed, cycling faster the faster you move.
    const target = onGround ? Math.min(speed / BOB.refSpeed, 1) : 0;
    this._bobAmt += (target - this._bobAmt) * Math.min(1, dt * 6);
    this._bobPhase += dt * (2 * Math.PI / BOB.cycle) * (0.35 + 0.65 * Math.min(speed / BOB.refSpeed, 1.2));
    // Lag: the weapon trails a turn, then settles back.
    const clampLag = (v) => Math.max(-LAG.max, Math.min(LAG.max, v));
    this._lagYaw = clampLag(this._lagYaw + (st.yawDelta || 0) * LAG.scale);
    this._lagPitch = clampLag(this._lagPitch + (st.pitchDelta || 0) * LAG.scale);
    const k = Math.exp(-LAG.decay * dt);
    this._lagYaw *= k; this._lagPitch *= k;
    // Landing: a dip that springs back, bigger the longer you were in the air.
    if (!onGround) this._airTime += dt;
    if (onGround && !this._wasOnGround) { this._landV -= Math.min(this._airTime, 1) * 30; }
    if (onGround) this._airTime = 0;
    this._wasOnGround = onGround;
    // The spring (stiffness 180, damping 18) in small steps: in one step of a long frame (a stage loading, a hitch:
    // dt up to 0.25 s) the damping term overshoots (1 - 18 dt < -1) and it grows without bound, which flung the
    // viewmodel camera to infinity and the knife and gun off screen until a reload.
    for (let left = dt; left > 0; left -= LAND_STEP) {
      const h = Math.min(left, LAND_STEP);
      this._landV += (-this._land * 180 - this._landV * 18) * h;
      this._land += this._landV * h;
    }
    if (!Number.isFinite(this._land) || !Number.isFinite(this._landV)) this._land = this._landV = 0;
  }

  // The motion is applied to the CAMERA, inverted: the graph rewrites every bone each frame, so the model
  // itself is left alone (the same trick fp.js uses for viewmodel_offset).
  _applyMotion(cam) {
    const D = DEG;
    const b = this._bobAmt;
    const lat = Math.sin(this._bobPhase) * BOB.lat * b;
    const vert = Math.sin(this._bobPhase * 2) * BOB.vert * b + this._land;
    cam.translateX(-lat * IN);
    cam.translateY(-vert * IN);
    cam.rotateY(-this._lagYaw * D);                       // turn right: the view leads, the gun trails left
    cam.rotateX(-(this._lagPitch * D));
  }

  render(aspect) {
    if (!this.visible || !this.ready || !this.renderer) return;
    const s = this._sources[this.weapon];
    if (!s?.rig) return;
    const cam = this.camera;
    cam.aspect = aspect || cam.aspect;
    s.fovH = 68;                                 // viewmodel_fov 68; offsets: viewmodel_offset 1 / 1 / -1 (fp.js)
    s.updateCamera(cam);                         // sets fov + projection, places the eye at root_motion
    this._applyMotion(cam);
    cam.updateMatrixWorld();
    this._placeParticleLights(cam);
    const r = this.renderer;
    const auto = r.autoClear;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, cam);
    r.autoClear = auto;
  }

  // Particle lights on the knife / gun and arms (CS2 lights the viewmodel with them too), with the world's own barn
  // gather (world/lighting.js patchBarns: colour x 1 / max(d^2, 1) x smoothstep(fade), 0 at the range) added to the
  // viewmodel's materials from outside (fp/ is vpkstuff's, kept verbatim). `barns`: the world's packed, ranked set
  // (Source space); `eye`: the world camera; `gain`: the world's pre-curve exposure (cs2Exposure x 2.8), since this
  // pass is tone-mapped on its own. Each light is moved to where it is relative to your eye in this scene (metres),
  // and the gather measures distances back in Source units (cs2BarnUnit), so range, fade and 1/d^2 are the world's.
  setParticleLights(barns, eye, gain = 1) { this._barns = barns; this._eye = eye; this._barnGain = gain; }

  _placeParticleLights(cam) {
    const src = this._barns;
    if (!src || !this._eye) return;
    const u = this._vmBarns || (this._vmBarns = barnUniforms());
    patchBarns(this.scene, u, this._barnDone || (this._barnDone = new WeakSet())); // new materials only
    const n = src.cs2BarnCount.value;
    const view = this._eye.matrixWorldInverse;
    for (let i = 0; i < n; i++) {
      // world (Source) -> the world camera's view space (inches) -> metres -> this camera's view -> this scene
      u.cs2BarnPos.value[i].copy(src.cs2BarnPos.value[i]).applyMatrix4(view).multiplyScalar(IN_M).applyMatrix4(cam.matrixWorld);
      u.cs2BarnAxis.value[i].copy(src.cs2BarnAxis.value[i]).transformDirection(view).transformDirection(cam.matrixWorld);
      u.cs2BarnColor.value[i].copy(src.cs2BarnColor.value[i]);
      u.cs2BarnShape.value[i].copy(src.cs2BarnShape.value[i]);
      u.cs2BarnFade.value[i].copy(src.cs2BarnFade.value[i]);
    }
    u.cs2BarnCount.value = n;
    u.cs2BarnUnit.value = 1 / IN_M;
    u.cs2BarnGain.value = this._barnGain;
  }
}

const IN_M = 0.0254;     // metres per Source unit (this scene is the glTF export's metres)
