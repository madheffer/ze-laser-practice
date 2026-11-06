// CS:GO player movement: its own rules, for Source 1 maps (lasers-bake source1: entities.json "engine": "source1"),
// kept apart from CS2's (movement.js) so a map (or later a player) can pick either. Everything CS:GO does the same way
// is CS2's Player as is; only what CS:GO's server.dll does differently is here.
//
// Truth source: CS:GO's own server.dll (the "csgo legacy" build, md5 8048019154549052cb6dc057b76f6a85; Ghidra project
// "cs2" /csgo_server_legacy.dll). CCSGameMovement's vtable 0x108e6d58; the functions by their place in it:
//   CheckParameters 0x103f87e0, CanDuck 0x103f8700, Duck 0x103fce10, FinishUnDuck 0x103fc870, FinishDuck 0x103fcb30,
//   CanUnduck 0x103fc630, CheckJumpButton 0x103fb370, FinishGravity 0x102ab830, OnJump 0x103fd6c0, ReduceTimers 0x103fb050.
//
// The same as CS2 (checked there, so CS2's code runs): the view vectors (static table at file offset 0xa513a4: eye 64,
// hull 72, duck hull 54, duck eye 46), the in-air duck lifting the feet by half the hull difference (9) and the in-air
// unduck testing 9 lower (FinishDuck / CanUnduck), the duck finishing at once in the air, sv_timebetweenducks 0.4, the
// jump (impulse + the StartGravity'd vz standing, the impulse alone ducked, x (1 - stamina / 100), then FinishGravity's
// half tick: CS2's numbers come out equal), the stamina costs (OnJump / OnLand) and recovery (ReduceTimers: linear,
// sv_staminarecoveryrate), and every movement cvar default (sv_jump_impulse 301.993377, accelerate 5.5, friction 5.2...).
//
// Different, and so overridden here:
//  - duck speed (m_flDuckSpeed) is not pinned: each change of the duck key (press or release) takes 2.0 off it (floor
//    0: CheckParameters' IN_DUCK edge test), it recovers toward 8 at 3 / s, and at 6 / s more once you are 64 units
//    from where it was last full while not mid-duck (Duck); below 1.5 the duck key counts as released (CanDuck). A duck
//    goes in at duckSpeed x 0.8 a second and out at max(duckSpeed, 1.5). CS2's ZE servers pin it at 8 (CS2Fixes).
//  - unducking in the air finishes at once (Duck calls FinishUnDuck when you have no ground entity); on the ground
//    at duck amount 0. A failed CanUnduck holds the duck at amount 1.
//  - the max speed (CheckParameters): the weapon's x runspeed, x 0.52 for the walk key only while you are already
//    under walk speed + 25 (and not ducking), x (1 - stamina / 100)^2; the move input is cut to it and WalkMove clamps
//    ground velocity to it. The duck crop (x 0.34) is on the input, while FL_DUCKING and on the ground. There is no
//    per-tick stamina velocity factor (nothing in CS:GO's movement code uses 70 or 1/70).
import { Player, CS } from './movement.js';

export const CSGO = {
  duckSpeedIdeal: 8, // CS_PLAYER_DUCK_SPEED_IDEAL
  duckKeyCost: 2, // per duck key change (CheckParameters)
  duckRecover: 3, // per second toward ideal (Duck)
  duckRecoverMoved: 6, // per second more, 64 units away from where it was last ideal
  duckRecoverDist: 64,
  duckMinSpeed: 1.5, // CanDuck's floor, and the unduck rate's
  duckInScale: 0.8,
  walkSlack: 25, // the walk key only bites under walk speed + 25
};

const approach = (target, value, speed) => {
  const d = target - value;
  return d > speed ? value + speed : d < -speed ? value - speed : target;
};

export class CsgoPlayer extends Player {
  constructor(world) {
    super(world);
    this.movement = 'csgo';
    this.duckSpeed = CSGO.duckSpeedIdeal; // m_flDuckSpeed
    this.duckKey = false; // the duck key last tick (CheckParameters' edge test)
    this.ducking = false; // m_bDucking: a duck or an unduck under way
    this.duckSpot = null; // where duck speed was last ideal (x, y)
    this.mvMax = 0; // this tick's max speed (CheckParameters)
  }

  teleport(origin, yaw) {
    super.teleport(origin, yaw);
    this.duckSpeed = CSGO.duckSpeedIdeal;
    this.duckKey = false;
    this.ducking = false;
    this.duckSpot = null;
  }

  // CheckParameters' duck part + CanDuck, then Duck
  handleDuck(input, dt) {
    const now = this.ticks * CS.tick;
    if (!!input.duck !== this.duckKey) {
      this.duckKey = !!input.duck;
      this.duckSpeed = Math.max(0, this.duckSpeed - CSGO.duckKeyCost);
    }
    const canDuck = this.duckSpeed >= CSGO.duckMinSpeed && (this.duckFlag || this.lastDuckTime + CS.timeBetweenDucks <= now);
    const duck = !!input.duck && canDuck;

    // duck speed recovery
    this.duckSpeed = approach(CSGO.duckSpeedIdeal, this.duckSpeed, dt * CSGO.duckRecover);
    if (this.duckSpeed < CSGO.duckSpeedIdeal) {
      if (this.duckAmount <= 0 || this.duckAmount >= 1) {
        const s = this.duckSpot;
        if (s && (this.origin[0] - s[0]) ** 2 + (this.origin[1] - s[1]) ** 2 > CSGO.duckRecoverDist ** 2) {
          this.duckSpeed = approach(CSGO.duckSpeedIdeal, this.duckSpeed, dt * CSGO.duckRecoverMoved);
        }
      }
    } else this.duckSpot = [this.origin[0], this.origin[1]];

    const inAir = !this.onGround;
    if (duck) {
      if (this.duckAmount < 1 && !this.ducking) this.ducking = true;
      if (!this.ducking) return;
      this.duckAmount = approach(1, this.duckAmount, dt * this.duckSpeed * CSGO.duckInScale);
      if (this.duckAmount >= 1 || inAir) this.finishDuck(now, inAir);
      return;
    }
    // released (or the duck refused)
    if (this.duckAmount > 0 && !this.ducking) this.ducking = true;
    if (!this.ducking) return;
    if (!this.canUnduck(inAir)) {
      this.duckAmount = 1;
      this.ducked = true;
      this.ducking = false;
      this.duckFlag = true;
      return;
    }
    // m_bDucked clears as the unduck starts: on the ground the standing hull is back at once (CanUnduck tested it in
    // place) while the view eases up; in the air FinishUnDuck runs now and moves the hull down 9
    const wasShort = this.ducked;
    this.duckAmount = approach(0, this.duckAmount, dt * Math.max(this.duckSpeed, CSGO.duckMinSpeed));
    this.ducked = false;
    if (this.duckAmount <= 0 || inAir) this.finishUnduck(inAir && wasShort);
    else if (this.duckAmount <= 0.75) this.duckFlag = false;
  }

  // FinishDuck: in the air the hull shrinks about its middle (feet up 9), on the ground in place
  finishDuck(now, inAir) {
    if (inAir && !this.ducked) this.origin = [this.origin[0], this.origin[1], this.origin[2] + (CS.standHeight - CS.duckHeight) * 0.5];
    this.ducked = true;
    this.ducking = false;
    this.duckFlag = true;
    this.lastDuckTime = now;
    this.duckAmount = 1;
    this.categorize(false);
  }

  // CanUnduck: the standing hull fits where it would be (9 lower in the air)
  canUnduck(inAir) {
    if (!this.ducked) return true;
    const at = inAir ? [this.origin[0], this.origin[1], this.origin[2] - (CS.standHeight - CS.duckHeight) * 0.5] : this.origin;
    this.ducked = false;
    const tr = this.trace(at, at);
    this.ducked = true;
    return !tr.startSolid;
  }

  // FinishUnDuck: back to the standing hull, 9 lower when it grows in the air (shift: the hull was the short one)
  finishUnduck(shift) {
    if (shift) this.origin = [this.origin[0], this.origin[1], this.origin[2] - (CS.standHeight - CS.duckHeight) * 0.5];
    this.ducked = false;
    this.ducking = false;
    this.duckFlag = false;
    this.duckAmount = 0;
    this.categorize(false);
  }

  // CheckParameters' max speed, and the move input cut to it (the duck crop on the input: HandleDuckingSpeedCrop)
  wishSpeedFor(input, wl) {
    let max = this.maxSpeed * this.runSpeed;
    if (!input.duck && !this.ducking && !this.duckFlag && input.walk) {
      const walk = max * CS.walkFactor;
      if (Math.hypot(this.velocity[0], this.velocity[1], this.velocity[2]) < walk + CSGO.walkSlack) max = walk;
    }
    if (this.stamina > 0) max *= Math.min(1, Math.max(0, 1 - this.stamina / 100)) ** 2;
    this.mvMax = max;
    if (wl <= 1e-6) return 0;
    let s = max * Math.min(1, wl);
    if (this.duckFlag && this.onGround) s *= CS.duckFactor;
    return Math.min(s, max);
  }

  // WalkMove: ground velocity clamped to this tick's max speed
  clampGroundSpeed() {
    const sp = Math.hypot(this.velocity[0], this.velocity[1]);
    if (sp > this.mvMax && sp > 0) { const s = this.mvMax / sp; this.velocity[0] *= s; this.velocity[1] *= s; }
  }

  // CS:GO has no per-tick stamina velocity factor: stamina works through the max speed
  staminaSlow() {}
}

// the player class a map plays with: CS:GO's on a Source 1 map, CS2's otherwise
export const playerFor = (entities) => (entities?.engine === 'source1' ? CsgoPlayer : Player);
