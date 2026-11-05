// Where the camera sits: your eyes, or CS2Fixes' third person (!tp).
//
// CS2Fixes ZEPlayer::ToggleThirdPerson (upstream src/playermanager.cpp) uses a custom_player_camera in
// CUSTOM_CAMERA_MODE_FOLLOW_POSITION with m_bFollowEyes, m_vecCameraOffset = (distance, -15, 0) for a
// right-handed player (back along the view by `distance`, 15 units to the right) and m_bClipCameraOffset,
// so walls pull the camera in. Distance: cs2f_thirdperson_distance_min/max 15..150, default 65.
import { angleForward, DEG } from '../world/entities/math.js';

const SIDE = 15; // CS2Fixes: 15 units to the right (right-handed)
const CLIP_HALF = [4, 4, 4]; // a small box, so the camera stops just short of a wall instead of inside it

// eye: [x, y, z]; returns the camera position for this frame.
export function cameraPosition(world, eye, yaw, pitch, thirdPerson, distance) {
  if (!thirdPerson) return eye;
  const f = angleForward([pitch, yaw, 0]);
  const y = yaw * DEG;
  const right = [Math.sin(y), -Math.cos(y), 0]; // Source: +Y is left
  const want = [eye[0] - f[0] * distance + right[0] * SIDE, eye[1] - f[1] * distance + right[1] * SIDE, eye[2] - f[2] * distance];
  const tr = world.traceBox(eye, want, CLIP_HALF, undefined, true);
  return [...tr.endPos];
}
