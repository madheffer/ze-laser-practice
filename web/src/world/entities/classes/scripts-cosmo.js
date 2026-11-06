// ---- ze_ffvii_cosmo_canyon_v5_p's scripts/ze_ffvii_cosmo_canyon_v5_p.vjs, the inputs its laser / boss endings use.
// A hand port (classes/scripts.js): the logic is the script's, the numbers that are the map's own (the spawn spots,
// the hurt immunity) come from the stage's `scripts` entry, copied from the script:
//
//   "[PR#]script_cosmo": { "port": "cosmo",
//     "spawnAt": { "SpawnFireball": [[8996, 9167, 223], ...], "SpawnIfritLaser": [[9136, 10184, 216], ...] },
//     "hurtImmunity": 0.4, "heal": 200 }
//
//   spawnAt              const fireball_origin / ifrit_laser_origin: the caller (a point_template) ForceSpawns at one
//                        of them, picked by getRandomInt (any of them, repeats allowed)
//   TriggerHurtImmunity  the activator takes no trigger_hurt damage for 0.4 s (OnModifyPlayerDamage aborts it): the
//                        fireballs' OnHurtPlayer hands it out
//   HumanHealth          the heal materia: SetMaxHealth(200) + SetHealth(200) (its 7 s zombie-hit immunity has no
//                        zombies here)
//   Alpha                the caller fades 255 -> 0 over 2 s (201 steps 0.01 s apart)
//   StageWon / Stage*    the level counter: only the next round's level, nothing in this round
// The rest of the script (Gi Nattak's item silence, the Shinra Genesis chase, minions, zombie items, score) isn't
// ported: no stage reaches it, and an input the port doesn't know is logged as unhandled.
import { poseMatrix, rotationOf } from '../math.js';
import { own } from '../../../lib/storage.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const LEVEL_INPUTS = new Set(['StageWon', 'StageWarmup', 'StageNormal', 'StageHard', 'StageExtreme', 'StageRage', 'StageZM']);

export const cosmo = {
  reset() {},
  run(e, cfg, name, act, caller) {
    const engine = e.engine;
    const spots = own(cfg.spawnAt, name);
    if (Array.isArray(spots)) {
      if (!caller || caller.cls !== 'point_template' || !spots.length) return true;
      const o = spots[Math.floor(engine.random() * spots.length)];
      if (!Array.isArray(o) || o.length !== 3) return true;
      engine.spawnTemplate(caller, poseMatrix(o.map((v) => num(v)), rotationOf(caller.getWorld())), act);
      return true;
    }
    if (LEVEL_INPUTS.has(name)) return true;
    const me = engine.playerEnt;
    switch (name) {
      case 'TriggerHurtImmunity':
        if (act === me) me.triggerHurtImmuneUntil = engine.time + num(cfg.hurtImmunity, 0.4);
        return true;
      case 'HumanHealth': {
        const hp = num(cfg.heal, 200);
        if (act === me && engine.player) { engine.player.setMaxHealth(hp); engine.player.setHealth(hp); }
        return true;
      }
      case 'Alpha':
        if (!caller) return true;
        for (let i = 0; i <= 200; i++) engine.fire(caller, 'Alpha', String(Math.floor((1 - i / 200) * 255)), i / 100, act, e);
        return true;
    }
    return false;
  },
};
