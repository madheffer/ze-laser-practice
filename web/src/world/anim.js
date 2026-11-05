// prop_dynamic animation, the drawing half: a THREE.AnimationMixer per model instance, posed every frame from the
// state the entity engine keeps (entities/classes/props.js: sequence name, cycle at t0, rate, loop mode). The mixer
// never runs on its own clock, so what you see is the engine's cycle (the one the server times OnAnimationDone
// with), at the time the renderer draws (its simulated-ping delay included).
//
// A sequence change cross-fades over the new sequence's fade-in time (the vmdl's own, animations.json; 0.2 s for
// every westersand sequence). UNSETTLED: CS2's client-side sequence blend: the old pose is held where it was
// while the new one fades in (Source 1's transitioner keeps advancing it).
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { rawCycle } from './entities/classes/props.js';

// A model's glb scene for one entity: SkeletonUtils' clone when it is skinned (a plain clone would share one
// skeleton between every copy), the clips carried over.
export function cloneModel(scene) {
  let skinned = false;
  scene.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
  const inst = skinned ? cloneSkinned(scene) : scene.clone(true);
  inst.animations = scene.animations || [];
  if (skinned) inst.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; }); // bind-pose bounds lie once it moves
  return inst;
}

export class PropAnimator {
  constructor() {
    this.items = new Map(); // entity -> { mixer, clips: Map(lower name -> clip), actions: Map, cur, old, serial, since }
  }

  // root: the instance cloneModel() made. Nothing to do for a model without clips or an entity without anim state.
  attach(e, root) {
    if (!root.animations?.length || !e.state?.anim) return;
    const clips = new Map(root.animations.map((c) => [c.name.toLowerCase(), c]));
    this.items.set(e, { mixer: new THREE.AnimationMixer(root), clips, actions: new Map(), cur: null, old: null, serial: -1, since: 0, oldTime: 0 });
  }

  detach(e) {
    const it = this.items.get(e);
    if (!it) return;
    it.mixer.stopAllAction();
    it.mixer.uncacheRoot(it.mixer.getRoot());
    this.items.delete(e);
  }

  action(it, name) {
    const key = String(name || '').toLowerCase();
    if (it.actions.has(key)) return it.actions.get(key);
    const clip = it.clips.get(key);
    const act = clip ? it.mixer.clipAction(clip) : null;
    if (act) { act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.play(); act.setEffectiveWeight(0); }
    it.actions.set(key, act);
    return act;
  }

  // time: the engine time being drawn
  update(time) {
    for (const [e, it] of this.items) {
      const a = e.state.anim;
      if (!e.alive || !a) continue;
      const act = this.action(it, a.name);
      if (it.serial !== a.serial) {
        // a new PropSetAnim: the old pose fades out under the new one
        if (it.cur && it.cur !== act) { it.old = it.cur; it.oldTime = it.cur.time; } else if (it.cur === act && act) { it.old = null; }
        it.cur = act; it.serial = a.serial; it.since = a.t0;
      }
      if (!act) continue;
      // the clip's own length is a frame short of the cycle (VRF writes no wrap key): map the cycle onto the cycle
      // length, held on the last key past the clip's end
      const len = a.duration > 0 ? a.duration : act.getClip().duration;
      let c = rawCycle(a, Math.max(time, a.t0));
      const loop = a.mode === 1 || (a.mode === 2 && a.seqLoop);
      c = loop ? c - Math.floor(c) : Math.min(1, Math.max(0, c));
      act.time = Math.min(c * len, act.getClip().duration);
      const fade = a.fadeIn > 0 ? Math.min(1, Math.max(0, (time - it.since) / a.fadeIn)) : 1;
      act.setEffectiveWeight(it.old ? fade : 1);
      if (it.old) {
        it.old.time = it.oldTime;
        it.old.setEffectiveWeight(1 - fade);
        if (fade >= 1) { it.old.setEffectiveWeight(0); it.old = null; }
      }
      for (const other of it.actions.values()) if (other && other !== act && other !== it.old) other.setEffectiveWeight(0);
      it.mixer.update(0);
    }
  }
}
