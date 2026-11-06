// The player's water sounds and splashes.
//
// waterSound(name): what world/water-move.js names (Water.PlayerEnter / Exit, Player.Wade, Player.Swim,
// Land_WaterVol.StepLeft) plays at you; 'underwater.start' / 'underwater.stop' is client.dll's loop while your eyes
// are under (FUN_18090fce0: m_flWaterLevel becomes 1 -> Player.AmbientUnderWater, emitted with volume 1 over the
// event's own 0; leaving 1 stops it).
//
// waterSplash(eye, dir, reach, kind): a shot meeting water. cs2_server: a bullet (FUN_180a70890) whose start isn't in
// water traces for it (mask 0x18000); the knife (FUN_180a28f90) casts eye -> eye + (its end - eye) x 1.2 with mask
// 0x1d9003 (solid, water, slime ...), and where that meets water (or slime) dispatches "gunshotsplash", which
// client.dll plays as Physics.WaterSplash there (FUN_180ba6a90; slime too, FUN_180ba6940). The water_splash_0x /
// slime_splash_0x particles aren't drawn (stock effects the map bake doesn't export). A splash behind a wall isn't
// one: the solid world stops the ray first.
import { S, G } from './state.js';
import { BULLET_MASK } from '../world/bullets.js';

const UNDERWATER = { id: 'player:underwater' }; // the loop's owner, for its stop

export function waterSound(name) {
  if (name === 'underwater.start') {
    G.audio.onSound({ type: 'start', ent: UNDERWATER, name: 'Player.AmbientUnderWater', local: true, paramVolume: 1 });
  } else if (name === 'underwater.stop') {
    G.audio.onSound({ type: 'stop', ent: UNDERWATER });
  } else if (S.player) G.audio.play(name, { pos: S.player.origin });
}

const KNIFE_WATER_REACH = 1.2; // DAT_1817aa34c

// world: the shot's CollisionWorld (app/bosses.js shotWorld)
export function waterSplash(world, eye, dir, range, kind) {
  const water = S.player?.water;
  if (!water || water.in(eye)) return;
  const reach = kind === 'bullet' ? range : range * KNIFE_WATER_REACH;
  const end = [eye[0] + dir[0] * reach, eye[1] + dir[1] * reach, eye[2] + dir[2] * reach];
  const w = water.trace(eye, end);
  if (!(w.fraction < 1)) return;
  const wall = world.traceRay(eye, end, undefined, true, BULLET_MASK);
  if (wall.fraction < w.fraction) return;
  const at = [eye[0] + dir[0] * reach * w.fraction, eye[1] + dir[1] * reach * w.fraction, eye[2] + dir[2] * reach * w.fraction];
  G.audio.play('Physics.WaterSplash', { pos: at });
}
