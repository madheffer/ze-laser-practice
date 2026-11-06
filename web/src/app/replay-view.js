// Where a replay's camera is: the recorded player's eyes, CS2Fixes' third person behind them (app/camera.js), or a
// free camera you fly (noclip: WASD, Space up, Ctrl / C down, Shift faster, mouse to look while the pointer is locked).
import { S } from './state.js';
import { settings } from './settings.js';
import { cameraPosition } from './camera.js';
import { angleForward, DEG } from '../world/entities/math.js';
import { clamp, lerpAngle } from '../lib/math.js';
import { ANG_SCALE } from '../lib/replay-codec.js';
import { keyHeld } from './input.js';

export const CAMS = ['first', 'third', 'free'];
const FREE_SPEED = 500; // u/s, x3 with Shift

const free = { pos: [0, 0, 0], yaw: 0, pitch: 0 };

// the view between the last two recorded ticks (a: 0..1 through the current tick), so slow motion stays smooth
function recordedView(a) {
  const d = S.replay.data, k = S.run.ticks;
  const i = Math.min(d.n - 1, Math.max(0, k - 1)), j = Math.max(0, i - 1);
  return { yaw: lerpAngle(d.yaw[j] / ANG_SCALE, d.yaw[i] / ANG_SCALE, a), pitch: (d.pitch[j] + (d.pitch[i] - d.pitch[j]) * a) / ANG_SCALE };
}

// switching to the free camera starts it where the camera is now
export function setCam(cam, current) {
  if (!CAMS.includes(cam)) return;
  if (cam === 'free' && S.replay.cam !== 'free' && current) {
    free.pos = [...current.pos]; free.yaw = current.yaw; free.pitch = current.pitch;
  }
  S.replay.cam = cam;
}

// mouse look (app/input.js), for the free camera only
export function freeLook(dy, dp) {
  free.yaw -= dy;
  free.pitch = clamp(free.pitch + dp, -89, 89);
}

// eye: the interpolated eye position; a: how far through the tick; dt: real seconds since the last frame
// -> { pos, yaw, pitch, body } (body: draw the recorded player's CT body)
export function replayView(eye, a, dt) {
  const r = S.replay;
  const view = S.run.ticks > 0 ? recordedView(a) : { yaw: S.player.yaw, pitch: S.player.pitch };
  if (r.cam === 'first') { r.last = { pos: eye, ...view, body: false }; return r.last; }
  if (r.cam === 'third') {
    r.last = { pos: cameraPosition(S.world, eye, view.yaw, view.pitch, true, settings.tpDist), ...view, body: true };
    return r.last;
  }
  // free: fly along the view
  const f = angleForward([free.pitch, free.yaw, 0]);
  const y = free.yaw * DEG;
  const right = [Math.sin(y), -Math.cos(y), 0];
  const fwd = (keyHeld('KeyW') ? 1 : 0) - (keyHeld('KeyS') ? 1 : 0);
  const side = (keyHeld('KeyD') ? 1 : 0) - (keyHeld('KeyA') ? 1 : 0);
  const up = (keyHeld('Space') ? 1 : 0) - (keyHeld('ControlLeft') || keyHeld('KeyC') ? 1 : 0);
  const sp = FREE_SPEED * (keyHeld('ShiftLeft') || keyHeld('ShiftRight') ? 3 : 1) * Math.min(dt, 0.1);
  for (let i = 0; i < 3; i++) free.pos[i] += (f[i] * fwd + right[i] * side + (i === 2 ? up : 0)) * sp;
  r.last = { pos: [...free.pos], yaw: free.yaw, pitch: free.pitch, body: true };
  return r.last;
}
