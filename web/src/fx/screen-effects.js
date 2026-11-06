// Screen-space particle effects (a .vpcf with m_bScreenSpaceEffect): GFL's boss hitmarker. They run on the same particle
// runtime and renderers as a map's effects (fx/effects.js), from their own baked fx/ folder (lasers-bake --gfl:
// public/gfl/fx), and draw over everything after the world and the viewmodel, straight to the screen (CS2's
// GameOverlay layer, the vpcf's m_bOnlyRenderInEffecsGameOverlay).
//
//   const screen = new ScreenEffects('gfl/')     // folder under the site root; loads lazily, null-safe if not baked
//   screen.spawn('particles/gfl/hitmarker_boss.vpcf')   // false when not baked (yet)
//   screen.frame(renderer, dt)                   // each frame, after the viewmodel
//
// The screen space: control point 0 sits at the screen's centre, facing the viewer, and a sprite's radius is a fixed
// fraction of the screen per unit on each axis. CS2 does not aspect-correct these quads, so a square sprite covers the
// same fraction of the width as of the height (wider than tall on a 16:9 screen; GFL's U scale 0.5 squeezes the texture
// back): vpkstuff docs/research/HITMARKER_SIZING.md, confirmed in game. The scale is that research's calibration
// shot (a radius of 2.82 drew a 512 px canvas 160.5 px tall at 3840 x 2160): 0.02636 of the screen height per unit
// of radius for the quad's full height, so the view spans 2 / 0.02636 = 75.9 units edge to edge on both axes.
import * as THREE from 'three';
import { MapEffects, fxShared } from './effects.js';

const HEIGHT_PER_UNIT = 0.02636;
const HALF_SPAN = 1 / HEIGHT_PER_UNIT; // units from the centre to an edge of the screen, either axis
const MAX_LIVE = 8;
// the viewer looks along Source +x with +z up, from a few units back: what the sprites face (uOrient 0)
const EYE = new THREE.Vector3(-100, 0, 0);
const CP0 = { position: [0, 0, 0], forward: [1, 0, 0], left: [0, 1, 0], up: [0, 0, 1] };

export class ScreenEffects {
  constructor(folder) {
    const base = `${import.meta.env?.BASE_URL ?? '/'}${folder}`;
    const fetchJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${u}`))));
    this.effects = null;
    this.loading = MapEffects.load((rel) => base + rel, fetchJson).then((fx) => { this.effects = fx; }, () => {});
    this.live = [];
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-HALF_SPAN, HALF_SPAN, HALF_SPAN, -HALF_SPAN, 1, 1000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(EYE);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this._saved = { pos: new THREE.Vector3(), up: new THREE.Vector3(), fwd: new THREE.Vector3() };
  }

  // a new instance of the effect, playing from now (each call its own, as each hit is its own system in game)
  spawn(effect) {
    const fx = this.effects;
    if (!fx || !fx.has(effect)) return false;
    fx.spawn(effect).then((inst) => {
      if (!inst) return;
      while (this.live.length >= MAX_LIVE) this.drop(this.live[0]);
      this.live.push(inst);
      this.scene.add(inst.group);
    });
    return true;
  }

  drop(inst) {
    inst.dispose();
    this.live.splice(this.live.indexOf(inst), 1);
  }

  frame(renderer, dt) {
    if (!this.live.length) return;
    const u = fxShared, s = this._saved;
    // the sprites build their quads from the shared camera vectors (spritecard.js): this pass's, then the world's back.
    // No fog here (the map's would tint a sprite 100 units off): the overlay is drawn after the frame
    s.pos.copy(u.uCamPos.value); s.up.copy(u.uCamUp.value); s.fwd.copy(u.uCamFwd.value);
    const fog = u.cs2FogType.value;
    u.uCamPos.value.copy(EYE); u.uCamUp.value.set(0, 0, 1); u.uCamFwd.value.set(1, 0, 0);
    u.cs2FogType.value = 0;
    for (const inst of [...this.live]) {
      // on for its first step (its emitter fires then), off after: done once its particles are gone (inst.finished)
      inst.update(dt, { cps: [CP0], active: inst.time === 0, camPos: [EYE.x, EYE.y, EYE.z] });
      if (inst.finished) this.drop(inst);
    }
    if (this.live.length) {
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(null);
      renderer.render(this.scene, this.camera);
      renderer.autoClear = auto;
    }
    u.uCamPos.value.copy(s.pos); u.uCamUp.value.copy(s.up); u.uCamFwd.value.copy(s.fwd);
    u.cs2FogType.value = fog;
  }
}
