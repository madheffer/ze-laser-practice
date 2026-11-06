// Triggers touched by physboxes, as CS2 does it (rubikon/CS2_RUNTIME.md "Trigger touches"). vphysics2 reports a touch
// for a trigger shape and a body whose pair filter keeps the touch bit (rubikon/src/Game/TriggerPhysics.cs: the
// trigger's InitTrigger layers from its spawnflags against the body's record), and the server's OnSimulate dispatches
// it (18057ad70) right after the step: CBaseTrigger::StartTouch / EndTouch, which run the flag test (1803df180) and
// the filter, then the outputs. The player's touches stay in triggers.js; a trigger's "all" outputs count both.
// The overlap is the trigger's hulls against the physbox's (hullsOverlap); NOT PORTED: a hurt / push / teleport
// trigger's effect on a physbox (its outputs fire).
import { hullsOverlap } from '../../collision.js';
import { num } from '../math.js';
import { filterPasses, multipleWait, TOUCH_CLASSES } from './triggers.js';

const EPS = 1e-6;

// CBaseTrigger's flag test (1803df180) for a physbox: 64 anything; 8 move type VPHYSICS (m_nActualMoveType 5: not
// parented); 0x400 collision group 5 or 6 (debris). Its client / NPC / vehicle bits never pass a physbox
function flagsPass(sf, box) {
  if (sf & 64) return true;
  if ((sf & 8) && !box.parent) return true;
  if ((sf & 0x400) && (num(box.kv.spawnflags) & 0x4000) && !box.kv.collisiongroup) return true;
  return false;
}

function overlaps(trigger, box) {
  const th = trigger.hulls(), bh = box.hulls();
  if (!th || !bh) return false;
  for (const a of th) for (const b of bh) if (hullsOverlap(a, b)) return true;
  return false;
}

function endTouch(engine, e, box) {
  const set = e.state.physTouch;
  set.delete(box);
  e.fireOutput('OnEndTouch', box);
  if (!set.size && !engine.touching.has(e)) e.fireOutput('OnEndTouchAll', box);
}

// after the physics step (physics-rubikon.js physicsStep)
export function physicsTouches(engine) {
  const w = engine.physics;
  const boxes = [];
  for (const x of engine.ents) if (x.alive && /^func_physbox/.test(x.cls) && x.state.body != null) boxes.push(x);
  for (const cls of TOUCH_CLASSES) {
    const set = engine.byClass.get(cls);
    if (!set) continue;
    for (const e of set) {
      const touching = (e.state.physTouch ||= new Set());
      if (!e.alive || e.sky || e.state.removeAt != null) { for (const b of [...touching]) touching.delete(b); continue; }
      const sf = num(e.kv.spawnflags);
      for (const box of boxes) {
        const reported = w.triggerTouches(box.state.body, sf, !!e.enabled) && overlaps(e, box);
        const was = touching.has(box);
        if (reported && !was) {
          // StartTouch: the flag test and the filter decide whether it counts
          if (!flagsPass(sf, box) || !filterPasses(engine, e.kv.filtername, 0, box)) continue;
          const first = !touching.size && !engine.touching.has(e);
          touching.add(box);
          e.fireOutput('OnStartTouch', box);
          if (first) e.fireOutput('OnStartTouchAll', box);
          if (cls === 'trigger_multiple' || cls === 'trigger_once') {
            e.fireOutput('OnTrigger', box);
            if (cls === 'trigger_once') e.state.removeAt = engine.time + 0.1;
            else e.state.nextTrigger = engine.time + multipleWait(e);
          }
        } else if (!reported && was) {
          endTouch(engine, e, box);
        } else if (reported && was && cls === 'trigger_multiple' && engine.time + EPS >= (e.state.nextTrigger ?? 0)) {
          e.fireOutput('OnTrigger', box);
          e.state.nextTrigger = engine.time + multipleWait(e);
        }
      }
      for (const b of [...touching]) if (!b.alive || b.state.body == null) endTouch(engine, e, b);
    }
  }
}
