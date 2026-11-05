// Burning, as CS2Fixes does it for a player (customio.cpp IgnitePawn; the IgniteLifetime input on a pawn is always
// theirs: detours.cpp Detour_CEntityIdentity_AcceptInput). ze_ffxii_westersand_v8's dragon fire (Fly_Fire 10 s,
// Drag_Hurt 3 s) and its zombie fire knife set humans alight this way; ze_mist_p's flame item burns zombies.
//
// cs2f_burn_damage 1, cs2f_burn_interval 0.3 s, cs2f_burn_slowdown 0.6 (the shipped cfg's values = the defaults):
// a timer from the first tick deals 1 burn damage every 0.3 s and sets m_flVelocityModifier to 0.6 each time, until
// the end time; igniting a burning player REPLACES the end time (now + seconds), so "IgniteLifetime 0" puts it out.
// CS2 lets m_flVelocityModifier recover by itself between the ticks (not modelled): the slow holds at 0.6 while you
// burn and lifts when the fire ends.
import { queueEvent, playerTakesDamage } from './classes/triggers.js';

const BURN_DAMAGE = 1;
const BURN_INTERVAL = 0.3;
const BURN_SLOWDOWN = 0.6;

// ent: the entity that lit you (the hazard named on the death screen)
export function ignitePlayer(engine, seconds, ent) {
  const end = engine.time + Math.max(0, Number(seconds) || 0);
  if (engine.burn) { engine.burn.end = end; return; }
  engine.burn = { end, next: engine.time, ent, first: true };
}

// each engine tick (engine.js)
export function tickBurn(engine) {
  const b = engine.burn;
  if (!b || engine.time + 1e-9 < b.next) return;
  if (b.end <= engine.time + 1e-9) {
    engine.burn = null;
    engine.player?.setRunSpeed?.(1);
    return;
  }
  // DMG_BURN (8): your damage filter may turn it away (westersand's burn immunity); the slow still lands
  if (playerTakesDamage(engine, 8)) { queueEvent(engine, { type: 'hurt', ent: b.ent, damage: BURN_DAMAGE, first: b.first }); b.first = false; }
  engine.player?.setRunSpeed?.(BURN_SLOWDOWN);
  b.next += BURN_INTERVAL;
}
