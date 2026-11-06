// CS2 player movement, ported from the Source game-movement shape (friction, ground/air accelerate,
// slide-move with step-up, categorise ground) with Counter-Strike's numbers. Fixed 64 Hz ticks.
//
// Units are Source units (inches), Z up. origin = the bottom centre of the player's hull.
import { makeTrace } from './collision.js';
import { WATER, checkWater, swimJump, waterMove, checkWaterJump, waterJumpTick, waterLevelSounds } from './water-move.js';

export const CS = {
  tick: 1 / 64,
  gravity: 800,
  // sv_jump_impulse's default (cs2_server registration: 0x4396ff27), "sqrt(2*gravity*height)"
  jumpImpulse: 301.993378,
  // sv_legacy_jump, "Whether or not to use the pre-2026 jump code": CS2's default is 0 (CCSPlayerModernJump: a
  // landing penalty on the next jump, no stamina), but GFL's ZE servers run 1: their console prints
  // "sv_legacy_jump = true" in game (2026-11-06). So the legacy jump: stamina scales jumps and slows you on landing
  legacyJump: true,
  maxSpeed: 250, // knife out
  accelerate: 5.5,
  airAccelerate: 12,
  airMaxWishSpeed: 30,
  friction: 5.2,
  stopSpeed: 80,
  stepSize: 18,
  walkFactor: 0.52,
  duckFactor: 0.34,
  maxVelocity: 3500,
  // the player's box and eyes, as CS2's server builds them: CCSGameRules::GetViewVectors (vtable slot 32; server.dll
  // 2026-11-05 0x18092b440 returns the table its static init 0x18009a0c0 fills): hull (-16,-16,0)-(16,16,72), duck
  // hull max (16,16,54), view (0,0,64), duck view (0,0,46)
  standHeight: 72,
  duckHeight: 54,
  halfWidth: 16,
  viewStand: 64,
  viewDuck: 46,
  // seconds to go fully ducked (view height + hull swap at the end) and back up. FIXED rates on purpose, with no
  // duck-spam slowdown: CS2Fixes `cs2f_allow_duck_spam` (upstream src/detours.cpp) pins m_flDuckSpeed at 8.0 every
  // movement tick on ZE servers, so repeated ducks never get slower. CS2's duck handler (cs2_server FUN_180abb500)
  // then ducks at m_flDuckSpeed x 0.8 per second (1 / 6.4 = 0.15625 s, 10 ticks) and unducks at
  // max(m_flDuckSpeed, 1.5) (1 / 8 = 0.125 s, 8 ticks)
  duckInTime: 0.15625,
  unduckTime: 0.125,
  // sv_timebetweenducks (cs2_server registration FUN_1800cae10: 0.4, "Minimum time before recognizing consecutive duck
  // key"): the duck key starts a new duck only this long after the last finished duck (FinishDuck's m_flLastDuckTime),
  // unless you are still FL_DUCKING (cleared once an unduck is down to duck amount 0.75). Duck handler FUN_180abb500
  timeBetweenDucks: 0.4,
  groundNormalZ: 0.7,
  // stamina (sv_staminamax / sv_staminajumpcost / sv_staminalandcost / sv_staminarecoveryrate): jumping
  // and landing build stamina, and while it's above 0 your ground speed is scaled down each tick by
  // ((max - stamina) / max) ^ (frametime / (1/70)) — the bhop/landing speed loss. CS2: "sv_legacy_jump only"
  // (both costs' help text): GFL runs the legacy jump (legacyJump above), so it builds.
  staminaMax: 80,
  staminaJumpCost: 0.08,
  staminaLandCost: 0.05,
  staminaRecovery: 60,
};

// Does a standing player (feet at origin) fit in the world there, moving brushes (engine.solids()) included: where a
// spawn may go (world/run-engine.js freeSpawn), the same test in the browser and on the co-op server.
const standTrace = makeTrace();
export function standsFree(world, origin, solids) {
  world.dynamic = solids;
  const h = [CS.halfWidth, CS.halfWidth, CS.standHeight / 2];
  const c = [origin[0], origin[1], origin[2] + CS.standHeight / 2];
  return !world.traceBox(c, c, h, standTrace).startSolid;
}

const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class Player {
  constructor(world) {
    this.world = world;
    this.origin = v3();
    this.velocity = v3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.groundEntity = null;
    this.ducked = false; // hull is the short one
    this.duckAmount = 0; // 0..1, view height blend
    this.duckFlag = false; // FL_DUCKING
    this.lastDuckTime = -Infinity; // m_flLastDuckTime: when the last duck finished (sv_timebetweenducks)
    this.jumpHeld = false;
    this.tr = makeTrace();
    this.baseVelocity = v3(); // trigger_push etc. add here for one tick
    this.gravityScale = 1; // the player's own "gravity" keyvalue (maps set 0.1 for low-grav sections)
    this.speedScale = 1; // the "speed" keyvalue: lagged movement, scales the whole move
    // the "runspeed" keyvalue (CS2Fixes: the pawn's m_flVelocityModifier): scales the max speed you run at. Recovers
    // toward 1 only below 1 in Source, so a map's 2 holds until it sets 1 again
    this.runSpeed = 1;
    this.onLand = null; // (fallSpeed) => void, for fall damage
    this.onJump = null;
    this.maxSpeed = CS.maxSpeed; // the held weapon's: knife 250, AK-47 215
    // the map's movement cvars (sv_accelerate, sv_airaccelerate, sv_friction, sv_gravity, sv_stopspeed), set by the
    // session from what the map runs; anything unset is CS2's default (CS)
    this.cvars = {};
    this.stamina = 0;
    // CCSPlayerModernJump's m_nLastLandedTick / m_flLastLandedVelocityZ: when you last landed and how fast you fell
    this.ticks = 0;
    this.landTick = -Infinity;
    this.landVz = 0;
    // water (world/water-move.js): the map's water query (world/water-volumes.js; null = no water), m_flWaterLevel and
    // its level, slime or water, the swim stroke's sound timer and the water jump; onWaterSound(name) for its sounds
    this.water = null;
    this.waterFrac = 0;
    this.waterLevel = 0;
    this.waterSlime = false;
    this.swimSoundMs = 0;
    this.waterJumpMs = 0;
    this.waterJumpVel = [0, 0];
    this.onWaterSound = null;
  }

  // the view offset CheckWater traces from: CS2's view vectors (64, ducked 46), not the duck blend
  viewZ() { return this.ducked ? CS.viewDuck : CS.viewStand; }
  stepSize() { return this.cvars.stepSize ?? CS.stepSize; }

  // The modern jump's strength right after a landing (cs2_server FUN_180ab23e0): clamp(1 + 0.0005 x the landing's
  // vertical speed, 0.2, 1), plus 0.6 per second spent on the ground after the landing tick, capped at 1. Landing
  // from a plain jump (about -300 u/s) starts at 0.85 (a jump straight away tops out near 40 u, not 57) and is back
  // to full 0.25 s later; a long fall bottoms out at 0.2. The legacy jump scales by stamina instead.
  jumpScale() {
    if (CS.legacyJump) return Math.min(1, Math.max(0, 1 - this.stamina / 100));
    if (!Number.isFinite(this.landTick)) return 1;
    const base = Math.min(1, Math.max(0.2, 1 + 0.0005 * this.landVz));
    return Math.min(1, base + 0.6 * (this.ticks - this.landTick - 1) * CS.tick);
  }

  get height() { return this.ducked ? CS.duckHeight : CS.standHeight; }
  half() { return [CS.halfWidth, CS.halfWidth, this.height / 2]; }
  centre(o = this.origin) { return [o[0], o[1], o[2] + this.height / 2]; }
  eyeHeight() { return CS.viewStand + (CS.viewDuck - CS.viewStand) * this.duckAmount; }

  teleport(origin, yaw = this.yaw) {
    this.origin = [...origin];
    this.velocity = v3();
    this.yaw = yaw;
    this.pitch = 0;
    this.ducked = false;
    this.duckAmount = 0;
    this.duckFlag = false;
    this.lastDuckTime = -Infinity;
    this.onGround = false;
    this.waterJumpMs = 0;
    this.categorize();
  }

  // Sweep the current hull from origin `a` to `b` (both feet positions).
  trace(a, b, tr = this.tr) {
    const h = this.half();
    return this.world.traceBox(this.centre(a), this.centre(b), h, tr);
  }

  // input: { forward, side (-1..1), jump, jumpPress (went down this tick), duck, walk }, settings: { autoBhop }
  tick(input, settings) {
    const dt = CS.tick * this.speedScale;
    const gravity = (this.cvars.gravity ?? CS.gravity) * this.gravityScale;
    this.ticks++;
    const wasOnGround = this.onGround;
    const fallSpeed = -this.velocity[2];
    this.handleDuck(input, dt);

    // wish direction on the horizontal plane
    const yr = (this.yaw * Math.PI) / 180;
    const fx = Math.cos(yr), fy = Math.sin(yr);
    const rx = Math.sin(yr), ry = -Math.cos(yr);
    let wx = fx * input.forward + rx * input.side;
    let wy = fy * input.forward + ry * input.side;
    const wl = Math.hypot(wx, wy);
    let wishSpeed = 0;
    if (wl > 1e-6) {
      wx /= wl; wy /= wl;
      wishSpeed = this.maxSpeed * this.runSpeed * Math.min(1, wl);
      if (this.ducked && this.onGround) wishSpeed *= CS.duckFactor;
      else if (input.walk) wishSpeed *= CS.walkFactor;
    }
    const wish = [wx, wy, 0];

    // jump
    const wantJump = input.jump && (settings.autoBhop || !this.jumpHeld || !!input.jumpPress);
    this.jumpHeld = input.jump;

    if (this.stamina > 0) this.stamina = Math.max(0, this.stamina - CS.staminaRecovery * dt);

    // water (world/water-move.js): the swim stroke's timer, where the water is now, then the water jump or the water mode
    if (this.swimSoundMs > 0) this.swimSoundMs = Math.max(0, this.swimSoundMs - dt * 1000);
    const oldLevel = this.waterLevel, oldFrac = this.waterFrac;
    if (this.water) checkWater(this, this.viewZ());
    if (this.water && (waterJumpTick(this, dt) || this.waterLevel > 2)) {
      if (this.waterJumpMs > 0) this.flyMove(dt);
      else this.swimTick(input, wantJump, dt);
      this.baseVelocity = v3();
      // CategorizePosition only flags the ground (Source / CS2 never move you in it): snapping onto the floor here kept a
      // swim stroke (100 u/s, 1.6 u a tick) from ever leaving the bottom, so a scroll-wheel jump did nothing there
      this.categorize(false);
      if (this.onGround) this.velocity[2] = 0;
      this.afterWater(oldLevel, oldFrac, wasOnGround, fallSpeed);
      return;
    }
    // wading (level 2+) on the ground: the acceleration x sv_water_slow_amount, standing and not walking (FUN_180ab0310)
    const wade = this.waterLevel >= 2 && !this.ducked && !input.walk ? WATER.slowAmount : 1;

    // gravity (half)
    if (!this.onGround) this.velocity[2] -= gravity * 0.5 * dt;


    if (this.onGround && wantJump) {
      // CS2's jump velocity (cs2_server modern FUN_180adfa70 / legacy FUN_180ab5a30, the same formula): the impulse
      // less g x gravity scale x 0.5 x 1/128, or the full impulse when crouched or crouching; then x jumpScale()
      const impulse = this.cvars.jumpImpulse ?? CS.jumpImpulse;
      const vz = (this.ducked || this.duckAmount > 0 ? impulse : impulse - gravity * 0.5 * 0.0078125) * this.jumpScale();
      // now airborne, so this tick's air move starts with its half tick of gravity, as CS2's AirMove does
      // (cs2_server FUN_180adc860: velocity -= frametime x gravity x 0.5 before the move): the arc is then an exact
      // parabola, apex = vz^2 / 2g (55.8 u standing, 57.0 from a crouch)
      this.velocity[2] = vz - gravity * 0.5 * dt;
      this.onGround = false;
      this.groundEntity = null;
      if (CS.legacyJump) this.stamina = Math.min(CS.staminaMax, this.stamina + CS.staminaJumpCost * vz);
      this.onJump?.();
    }

    // trigger_push: Source adds the push as a base velocity for this move only (it carries you, it does
    // not become your own speed). An upward push lifts you off the ground.
    const bv = this.baseVelocity;
    const pushing = bv[0] || bv[1] || bv[2];
    if (pushing && bv[2] > 0 && this.onGround) { this.onGround = false; this.groundEntity = null; }

    if (this.onGround) {
      this.velocity[2] = 0;
      this.friction(dt);
      this.accelerate(wish, wishSpeed, (this.cvars.accelerate ?? CS.accelerate) * wade, dt);
      const sp = Math.hypot(this.velocity[0], this.velocity[1]);
      if (sp > this.maxSpeed * this.runSpeed && wishSpeed > 0) {
        // Source clamps ground speed to the current max
        const s = Math.max(wishSpeed, this.maxSpeed * this.runSpeed * (this.ducked ? CS.duckFactor : 1)) / sp;
        if (s < 1) { this.velocity[0] *= s; this.velocity[1] *= s; }
      }
      if (this.stamina > 0) {
        const ratio = Math.pow((CS.staminaMax - this.stamina) / CS.staminaMax, dt / (1 / 70));
        this.velocity[0] *= ratio; this.velocity[1] *= ratio;
      }
      if (pushing) for (let i = 0; i < 3; i++) this.velocity[i] += bv[i];
      this.walkMove(dt);
      if (pushing) for (let i = 0; i < 3; i++) this.velocity[i] -= bv[i];
    } else {
      this.airAccelerate(wish, wishSpeed, dt);
      if (pushing) for (let i = 0; i < 3; i++) this.velocity[i] += bv[i];
      this.flyMove(dt, this.velocity);
      if (pushing) for (let i = 0; i < 3; i++) this.velocity[i] -= bv[i];
    }
    this.baseVelocity = v3();

    this.categorize();
    this.landed(wasOnGround, fallSpeed);
    if (!this.onGround) this.velocity[2] -= gravity * 0.5 * dt;
    else if (this.velocity[2] < 0) this.velocity[2] = 0;

    if (this.water) { checkWater(this, this.viewZ()); waterLevelSounds(this, oldLevel, oldFrac); }
    this.clampVelocity();
  }

  clampVelocity() {
    for (let i = 0; i < 3; i++) this.velocity[i] = Math.max(-CS.maxVelocity, Math.min(CS.maxVelocity, this.velocity[i]));
  }

  // touching down this tick: stamina, the modern jump's landing, the landing callback (fall damage, its sound). In
  // water a landing hurts nothing (Source's CheckFalling: "They landed in water"; UNSETTLED for CS2) and client.dll
  // plays Land_WaterVol.StepLeft for one at 260 u/s or more (FUN_1808c1df0)
  landed(wasOnGround, fallSpeed) {
    if (wasOnGround || !this.onGround) return;
    if (CS.legacyJump) this.stamina = Math.min(CS.staminaMax, this.stamina + CS.staminaLandCost * Math.max(0, fallSpeed));
    this.landTick = this.ticks;
    this.landVz = -fallSpeed;
    if (this.waterLevel > 0) { if (fallSpeed >= 260) this.onWaterSound?.('Land_WaterVol.StepLeft'); return; }
    this.onLand?.(fallSpeed);
  }

  // The water mode's move (water-move.js): CheckWaterJump at level 3, the jump button (swim up), WaterMove
  swimTick(input, wantJump, dt) {
    if (this.waterLevel === 3) checkWaterJump(this);
    if (this.velocity[2] < 0 && this.waterJumpMs) this.waterJumpMs = 0;
    if (wantJump) swimJump(this);
    // CheckParameters' max speed: the weapon's x runspeed, x 0.52 walking, x (1 - stamina / 100)^2
    let max = this.maxSpeed * this.runSpeed;
    if (input.walk && !input.duck) max *= CS.walkFactor;
    if (this.stamina > 0) max *= Math.min(1, Math.max(0, 1 - this.stamina / 100)) ** 2;
    waterMove(this, input, max, dt, this.cvars.accelerate ?? CS.accelerate, this.cvars.friction ?? CS.friction);
  }

  afterWater(oldLevel, oldFrac, wasOnGround, fallSpeed) {
    this.landed(wasOnGround, fallSpeed);
    checkWater(this, this.viewZ());
    waterLevelSounds(this, oldLevel, oldFrac);
    this.clampVelocity();
  }

  handleDuck(input, dt) {
    const now = this.ticks * CS.tick;
    if (input.duck && (this.duckFlag || this.lastDuckTime + CS.timeBetweenDucks <= now)) {
      // Approach(1, amount, step) as the binary does: 1 once the gap is no more than a step. The binary's floats are 32 bit
      // (nine 0.1f steps leave a gap under 0.1f, so the 10th tick lands on 1); doubles leave 0.1000..09: hence the 1e-6
      const step = dt / CS.duckInTime;
      this.duckAmount = 1 - this.duckAmount <= step + 1e-6 ? 1 : this.duckAmount + step;
      if (!this.ducked && (this.duckAmount >= 1 || !this.onGround)) {
        if (!this.onGround) {
          // In the air the hull shrinks about its middle: CS2's FinishDuck (cs2_server FUN_180abde20) moves the
          // origin up by ((hull max - min) - (duck hull max - min)) x 0.5 = 9, so the feet rise 9 (not the full 18)
          this.ducked = true;
          const up = [this.origin[0], this.origin[1], this.origin[2] + (CS.standHeight - CS.duckHeight) * 0.5];
          // only if there is room above the short hull at its new place
          const tr = this.trace(up, up);
          if (tr.startSolid) this.ducked = false;
          else { this.origin = up; this.duckAmount = 1; }
        } else {
          this.ducked = true;
        }
        // FinishDuck: FL_DUCKING on, m_flLastDuckTime = now
        if (this.ducked) { this.duckFlag = true; this.lastDuckTime = now; }
      }
    } else if (this.ducked || this.duckAmount > 0) {
      if (this.ducked) {
        // Unduck only when the tall hull fits: on the ground it grows up, in the air it grows about its middle (CS2's
        // unduck check, cs2_server FUN_180ab4190: the standing hull at the origin less 9 in the air, as it is on ground)
        const was = this.ducked;
        this.ducked = false;
        let target = this.origin;
        if (!this.onGround) target = [this.origin[0], this.origin[1], this.origin[2] - (CS.standHeight - CS.duckHeight) * 0.5];
        const tr = this.trace(target, target);
        if (tr.startSolid) {
          if (!this.onGround) {
            // try growing up instead
            const tr2 = this.trace(this.origin, this.origin);
            if (tr2.startSolid) { this.ducked = was; return; }
          } else { this.ducked = was; return; }
        } else this.origin = target;
        this.duckAmount = this.onGround ? Math.min(this.duckAmount, 1) : 0;
      }
      const step = dt / CS.unduckTime;
      this.duckAmount = this.duckAmount <= step + 1e-6 ? 0 : this.duckAmount - step;
      // the unduck clears FL_DUCKING once it is down to 0.75 (FUN_180abb500), and FinishUnDuck at 0
      if (this.duckAmount <= 0.75) this.duckFlag = false;
    } else this.duckFlag = false;
  }

  friction(dt) {
    const v = this.velocity;
    const speed = Math.hypot(v[0], v[1], v[2]);
    if (speed < 0.1) { v[0] = v[1] = 0; return; }
    const control = Math.max(speed, this.cvars.stopSpeed ?? CS.stopSpeed);
    const drop = control * (this.cvars.friction ?? CS.friction) * dt;
    const ns = Math.max(0, speed - drop) / speed;
    v[0] *= ns; v[1] *= ns; v[2] *= ns;
  }

  accelerate(wish, wishSpeed, accel, dt) {
    const cur = dot(this.velocity, wish);
    const add = wishSpeed - cur;
    if (add <= 0) return;
    const a = Math.min(accel * dt * wishSpeed, add);
    for (let i = 0; i < 3; i++) this.velocity[i] += a * wish[i];
  }

  airAccelerate(wish, wishSpeed, dt) {
    const capped = Math.min(wishSpeed, CS.airMaxWishSpeed);
    const cur = dot(this.velocity, wish);
    const add = capped - cur;
    if (add <= 0) return;
    const a = Math.min((this.cvars.airAccelerate ?? CS.airAccelerate) * wishSpeed * dt, add);
    for (let i = 0; i < 3; i++) this.velocity[i] += a * wish[i];
  }

  // Slide along everything hit, up to 4 planes (Source's TryPlayerMove).
  flyMove(dt) {
    const planes = [];
    const original = [...this.velocity];
    let timeLeft = dt;
    for (let bump = 0; bump < 4; bump++) {
      if (!this.velocity[0] && !this.velocity[1] && !this.velocity[2]) break;
      const end = [
        this.origin[0] + this.velocity[0] * timeLeft,
        this.origin[1] + this.velocity[1] * timeLeft,
        this.origin[2] + this.velocity[2] * timeLeft,
      ];
      const tr = this.trace(this.origin, end);
      if (tr.allSolid) { this.velocity = v3(); return 4; }
      if (tr.fraction > 0) {
        this.origin = [tr.endPos[0], tr.endPos[1], tr.endPos[2] - this.height / 2];
        planes.length = 0;
      }
      if (tr.fraction === 1) break;
      timeLeft -= timeLeft * tr.fraction;
      planes.push([...tr.normal]);
      // clip velocity against all planes so far
      let i;
      for (i = 0; i < planes.length; i++) {
        this.velocity = clipVelocity(original, planes[i], 1);
        let j;
        for (j = 0; j < planes.length; j++) if (j !== i && dot(this.velocity, planes[j]) < 0) break;
        if (j === planes.length) break;
      }
      if (i === planes.length) {
        if (planes.length !== 2) { this.velocity = v3(); break; }
        const a = planes[0], b = planes[1];
        const dir = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const d = dot(dir, this.velocity);
        this.velocity = [dir[0] * d, dir[1] * d, dir[2] * d];
      }
      if (dot(this.velocity, original) <= 0) { this.velocity = v3(); break; }
    }
    return 0;
  }

  // Ground move with stair stepping: try flat, try up-over-down, keep whichever went further.
  walkMove(dt) {
    const v = this.velocity;
    const dest = [this.origin[0] + v[0] * dt, this.origin[1] + v[1] * dt, this.origin[2]];
    let tr = this.trace(this.origin, dest);
    if (tr.fraction === 1) { this.origin = dest; this.stayOnGround(); return; }

    const startO = [...this.origin], startV = [...v];
    this.flyMove(dt);
    const downO = [...this.origin], downV = [...this.velocity];

    // step up
    this.origin = [...startO];
    this.velocity = [...startV];
    const up = [startO[0], startO[1], startO[2] + CS.stepSize];
    tr = this.trace(this.origin, up);
    if (!tr.startSolid && !tr.allSolid) this.origin = [tr.endPos[0], tr.endPos[1], tr.endPos[2] - this.height / 2];
    this.flyMove(dt);
    const down = [this.origin[0], this.origin[1], this.origin[2] - CS.stepSize];
    tr = this.trace(this.origin, down);
    if (!tr.startSolid && !tr.allSolid) this.origin = [tr.endPos[0], tr.endPos[1], tr.endPos[2] - this.height / 2];

    const steppedOnFloor = tr.fraction < 1 && tr.normal[2] >= CS.groundNormalZ;
    const dDown = (downO[0] - startO[0]) ** 2 + (downO[1] - startO[1]) ** 2;
    const dUp = (this.origin[0] - startO[0]) ** 2 + (this.origin[1] - startO[1]) ** 2;
    if (!steppedOnFloor || dDown > dUp) {
      this.origin = downO;
      this.velocity = downV;
    } else {
      this.velocity[2] = downV[2];
    }
    this.stayOnGround();
  }

  // Stick to the floor walking down slopes/stairs (CS's StayOnGround).
  stayOnGround() {
    const start = [this.origin[0], this.origin[1], this.origin[2] + 2];
    const end = [this.origin[0], this.origin[1], this.origin[2] - CS.stepSize];
    let tr = this.trace(this.origin, start);
    const s = [tr.endPos[0], tr.endPos[1], tr.endPos[2] - this.height / 2];
    tr = this.trace(s, end);
    if (tr.fraction > 0 && tr.fraction < 1 && !tr.startSolid && tr.normal[2] >= CS.groundNormalZ) {
      this.origin = [tr.endPos[0], tr.endPos[1], tr.endPos[2] - this.height / 2];
    }
  }

  // Carry the player with whatever they stand on when it moves (doors, movelinears, trains).
  // `before` is the ground entity's world matrix before this tick's entity think.
  ride(ent, before, after) {
    if (!ent || !before) return;
    const b = before.elements, a = after.elements;
    if (b.every((v, i) => v === a[i])) return;
    // feet point in the mover's old local frame, then back out through its new transform
    const inv = before.clone().invert();
    const p = { x: this.origin[0], y: this.origin[1], z: this.origin[2] };
    const e1 = inv.elements;
    const lx = e1[0] * p.x + e1[4] * p.y + e1[8] * p.z + e1[12];
    const ly = e1[1] * p.x + e1[5] * p.y + e1[9] * p.z + e1[13];
    const lz = e1[2] * p.x + e1[6] * p.y + e1[10] * p.z + e1[14];
    const nx = a[0] * lx + a[4] * ly + a[8] * lz + a[12];
    const ny = a[1] * lx + a[5] * ly + a[9] * lz + a[13];
    const nz = a[2] * lx + a[6] * ly + a[10] * lz + a[14];
    const target = [nx, ny, nz + 0.05];
    const tr = this.trace(this.origin, target);
    if (!tr.startSolid) this.origin = [tr.endPos[0], tr.endPos[1], tr.endPos[2] - this.height / 2];
    // turn with it (yaw only)
    const yb = Math.atan2(b[1], b[0]), ya = Math.atan2(a[1], a[0]);
    this.yaw += ((ya - yb) * 180) / Math.PI;
  }

  // snap: settle onto the floor found when landing (the walk / air move); the water mode only takes the flag
  categorize(snap = true) {
    if (this.velocity[2] > 140) { this.onGround = false; this.groundEntity = null; return; }
    const down = [this.origin[0], this.origin[1], this.origin[2] - 2];
    const tr = this.trace(this.origin, down);
    if (tr.fraction < 1 && tr.normal[2] >= CS.groundNormalZ && !tr.allSolid) {
      if (!this.onGround && snap) this.origin = [tr.endPos[0], tr.endPos[1], tr.endPos[2] - this.height / 2];
      this.onGround = true;
      this.groundEntity = tr.hit;
    } else {
      this.onGround = false;
      this.groundEntity = null;
    }
  }
}

function clipVelocity(v, n, overbounce) {
  const backoff = dot(v, n) * overbounce;
  const out = [v[0] - n[0] * backoff, v[1] - n[1] * backoff, v[2] - n[2] * backoff];
  const adjust = dot(out, n);
  if (adjust < 0) for (let i = 0; i < 3; i++) out[i] -= n[i] * adjust;
  return out;
}
