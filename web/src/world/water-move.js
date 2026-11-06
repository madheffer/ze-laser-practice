// CS2's player in water, ported from cs2_server (2026-09-23 build, Ghidra; CCSPlayer_MovementServices / WaterServices):
//
//   CheckWater (FUN_180ab78d0): a ray from the eyes (origin + view offset z: 64 standing, 46 ducked) down to the feet,
//     interaction mask 0x18000 (water | slime, world/water-volumes.js). m_flWaterLevel = clamp(1 - hit fraction, 0, 1),
//     0 for a miss: how much of the feet-to-eyes line is under water (eyes under = 1)
//   the water level (FUN_1803d3210): 0 when m_flWaterLevel is 0, else int(m_flWaterLevel x 4 + 1): 1..5
//   PlayerMove (FUN_180ad5750): with no water jump running, level > 2 (m_flWaterLevel >= 0.5) and MOVETYPE_WALK, the
//     water mode (FUN_180ad67b0): CheckWaterJump at level 3, the jump button, the duck, WaterMove, then
//     CategorizePosition and, on the ground, vertical speed 0. No gravity in it. Below that you walk / fall as on land
//   the jump in water (FUN_180ab5a30, level > 2): no jump; vertical speed 100 (slime 80), off the ground, and
//     Player.Swim when m_flSwimSoundTime is spent (then 1000, counting down 1000 a second: one stroke sound a second)
//   WaterMove (FUN_180ae4c40), Source 2013's: wish = forward x fmove + right x smove (forward pitched with the view);
//     jump held: wish z += max speed; no input at all: wish z = -60 (you sink); else wish z += min(max(fmove x
//     forward z x 2, 0), max speed) (looking up while swimming forward rises faster). Wish speed capped at the max
//     speed, then x 0.8. Friction: speed - frametime x speed x sv_friction x surface friction (under 0.1: 0).
//     Accelerate: frametime x wish speed x sv_accelerate x surface friction, up to (wish speed - speed). Base velocity
//     (trigger_push) added for the move. The move: a clear path goes to dest (and steps onto a ledge up to
//     sv_stepsize + 1 above it); blocked, it slides (TryPlayerMove), or steps on the ground (StepMove)
//   the max speed (CheckParameters FUN_180ab6550): the weapon's, x 0.52 walking (shift), x (1 - stamina / 100)^2;
//     no duck factor (ducked speed is the ground Accelerate's 0.34). fmove / smove = input x that max speed
//   wading on the ground (Accelerate FUN_180ab0310): at level >= 2, standing and not walking, the acceleration is
//     x sv_water_slow_amount (0.9). Crouched it is the plain duck acceleration (x 0.34), not slowed again
//   CheckWaterJump (FUN_180ab7b70, level 3): moving up or barely down (vz >= -180) toward where you face, a hull trace
//     24 forward from the hull's middle; on a wall, a second from forward z + 8 above the feet (the binary's start
//     height: Source has the view height here) 24 forward, then 1024 down; landing on a floor (normal z >=
//     sv_standable_normal 0.7): vertical speed 256, the water jump for 2000 (ms, 1000 a second) pushing -50 x the
//     wall's normal. UNSETTLED: the second trace's height reads as forward z + 8 in the decompile
//   the water jump (FUN_180ad5750): its time counts down; at 0 or out of the water it ends; meanwhile your horizontal
//     speed is the jump's and you slide (TryPlayerMove)
//
// Sounds (player events: app/water-sounds.js plays them): entering / leaving any water (level 0 <-> > 0) Water.PlayerEnter
// / Water.PlayerExit (FUN_180ad67b0 / FUN_180ad5e40) and Player.Wade (CCSPlayer_WaterServices on the level change,
// FUN_180b154b0: entering water, not slime; leaving, alive), Player.Swim (the stroke above); client.dll: eyes under
// (m_flWaterLevel 1) Player.AmbientUnderWater loops, stopped when they come up (FUN_18090fce0).
export const WATER = {
  slowAmount: 0.9, // sv_water_slow_amount (cs2_server cvar registration: 0x3f666666)
  swimFactor: 0.8, // WaterMove's wish speed scale (DAT_181790fa0)
  sink: -60, // wish z with no input (DAT_1817b91e4)
  swimUp: 100, // the jump in water, CONTENTS_WATER (0x42c80000)
  swimUpSlime: 80, // CONTENTS_SLIME (0x42a00000)
  swimSoundMs: 1000, // m_flSwimSoundTime after a stroke sound (0x447a0000), counted down 1000 a second
  waterJumpMs: 2000, // m_flWaterJumpTime (DAT_18179ef18)
  waterJumpUp: 256, // (DAT_1817af9e8)
  waterJumpPush: -50, // x the wall's normal (DAT_18191f360)
  waterJumpMinVz: -180, // (DAT_18179ef24)
  waterJumpReach: 24, // (DAT_1817bcc40)
  waterJumpHeight: 8, // (DAT_18177e588)
  standable: 0.7, // sv_standable_normal
};

// m_flWaterLevel -> the level (FUN_1803d3210)
export const waterLevelOf = (frac) => (frac > 0 ? Math.trunc(frac * 4 + 1) : 0);


// CheckWater: sets p.waterFrac / waterLevel / waterSlime from where the player stands now
export function checkWater(p, eyeZ) {
  const q = p.water;
  if (!q) { p.waterFrac = 0; p.waterLevel = 0; p.waterSlime = false; return 0; }
  const o = p.origin;
  const r = q.trace([o[0], o[1], o[2] + eyeZ], o);
  p.waterFrac = r.fraction < 1 ? Math.min(1, Math.max(0, 1 - r.fraction)) : 0;
  p.waterLevel = waterLevelOf(p.waterFrac);
  p.waterSlime = p.waterFrac > 0 && r.slime;
  return p.waterLevel;
}

// AngleVectors with roll 0 (Source): forward pitched, right flat
function viewVectors(p) {
  const y = (p.yaw * Math.PI) / 180, x = (p.pitch * Math.PI) / 180;
  const cp = Math.cos(x);
  return {
    forward: [cp * Math.cos(y), cp * Math.sin(y), -Math.sin(x)],
    right: [Math.sin(y), -Math.cos(y), 0],
  };
}

// The jump button in water (level > 2): swim up, and the stroke sound once a second
export function swimJump(p) {
  p.velocity[2] = p.waterSlime ? WATER.swimUpSlime : WATER.swimUp;
  p.onGround = false;
  p.groundEntity = null;
  if (p.swimSoundMs <= 0) { p.swimSoundMs = WATER.swimSoundMs; p.onWaterSound?.('Player.Swim'); }
}

// WaterMove. maxSpeed: CheckParameters' (weapon x walk x stamina); input as Player.tick's
export function waterMove(p, input, maxSpeed, dt, accel, friction) {
  const { forward, right } = viewVectors(p);
  const fmove = input.forward * maxSpeed, smove = input.side * maxSpeed;
  const wish = [forward[0] * fmove + right[0] * smove, forward[1] * fmove + right[1] * smove, forward[2] * fmove + right[2] * smove];
  if (input.jump) wish[2] += maxSpeed;
  else if (!fmove && !smove) wish[2] = WATER.sink;
  else wish[2] += Math.min(Math.max(fmove * forward[2] * 2, 0), maxSpeed); // upmove is 0 in CS2
  let wishSpeed = Math.hypot(wish[0], wish[1], wish[2]);
  const wishDir = wishSpeed > 1e-6 ? [wish[0] / wishSpeed, wish[1] / wishSpeed, wish[2] / wishSpeed] : [0, 0, 0];
  if (wishSpeed > maxSpeed) wishSpeed = maxSpeed;
  wishSpeed *= WATER.swimFactor;

  // water friction (sv_friction, surface friction 1)
  const v = p.velocity;
  const speed = Math.hypot(v[0], v[1], v[2]);
  let newSpeed = 0;
  if (speed) {
    newSpeed = speed - dt * speed * friction;
    if (newSpeed < 0.1) newSpeed = 0;
    const s = newSpeed / speed;
    v[0] *= s; v[1] *= s; v[2] *= s;
  }
  // water acceleration (sv_accelerate)
  if (wishSpeed >= 0.1) {
    const add = wishSpeed - newSpeed;
    if (add > 0) {
      const a = Math.min(dt * wishSpeed * accel, add);
      for (let i = 0; i < 3; i++) v[i] += a * wishDir[i];
    }
  }

  const bv = p.baseVelocity;
  for (let i = 0; i < 3; i++) v[i] += bv[i];
  const dest = [p.origin[0] + v[0] * dt, p.origin[1] + v[1] * dt, p.origin[2] + v[2] * dt];
  let tr = p.trace(p.origin, dest);
  if (tr.fraction === 1) {
    // a clear path: from (step size + 1) above dest back down to it, which lifts you onto a ledge in the way
    const start = [dest[0], dest[1], dest[2] + p.stepSize() + 1];
    tr = p.trace(start, dest);
    if (!tr.startSolid) p.origin = [tr.endPos[0], tr.endPos[1], tr.endPos[2] - p.height / 2];
    else p.flyMove(dt);
  } else if (p.onGround) p.walkMove(dt);
  else p.flyMove(dt);
  for (let i = 0; i < 3; i++) p.velocity[i] -= bv[i];
}

// CheckWaterJump (level 3)
export function checkWaterJump(p) {
  if (p.waterJumpMs !== 0 || p.velocity[2] < WATER.waterJumpMinVz) return;
  const { forward } = viewVectors(p);
  const fl = Math.hypot(forward[0], forward[1]);
  if (fl < 1e-6) return;
  const flat = [forward[0] / fl, forward[1] / fl, 0];
  const vl = Math.hypot(p.velocity[0], p.velocity[1]);
  if (vl && (p.velocity[0] * flat[0] + p.velocity[1] * flat[1]) / vl < 0) return;
  const o = p.origin;
  const r = WATER.waterJumpReach;
  // the hull's middle, 24 ahead
  let tr = p.trace(o, [o[0] + flat[0] * r, o[1] + flat[1] * r, o[2]]);
  if (!(tr.fraction < 1)) return;
  const n = [...tr.normal];
  const start = [o[0], o[1], o[2] + forward[2] + WATER.waterJumpHeight];
  const end = [start[0] + flat[0] * r, start[1] + flat[1] * r, start[2]];
  tr = p.trace(start, end);
  if (tr.fraction !== 1) return;
  tr = p.trace(end, [end[0], end[1], end[2] - 1024]);
  if (tr.fraction < 1 && tr.normal[2] >= WATER.standable) {
    p.velocity[2] = WATER.waterJumpUp;
    p.waterJumpVel = [n[0] * WATER.waterJumpPush, n[1] * WATER.waterJumpPush];
    p.waterJumpMs = WATER.waterJumpMs;
    p.onGround = false;
    p.groundEntity = null;
  }
}

// One tick of the water jump (PlayerMove's branch): true while it runs
export function waterJumpTick(p, dt) {
  if (!(p.waterJumpMs > 0)) return false;
  p.waterJumpMs = Math.min(p.waterJumpMs, 10000) - dt * 1000;
  if (p.waterJumpMs <= 0 || p.waterLevel === 0) p.waterJumpMs = 0;
  else { p.velocity[0] = p.waterJumpVel[0]; p.velocity[1] = p.waterJumpVel[1]; }
  return true;
}

// the sounds of a level change (old -> new), after the tick's move
export function waterLevelSounds(p, oldLevel, oldFrac) {
  const s = p.onWaterSound;
  if (!s) return;
  if ((oldLevel > 0) !== (p.waterLevel > 0)) {
    s(p.waterLevel > 0 ? 'Water.PlayerEnter' : 'Water.PlayerExit');
    if (p.waterLevel > 0 ? !p.waterSlime : true) s('Player.Wade');
  }
  if ((oldFrac === 1) !== (p.waterFrac === 1)) s(p.waterFrac === 1 ? 'underwater.start' : 'underwater.stop');
}

