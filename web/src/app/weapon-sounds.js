// The guns' own sounds, as CS2 plays them: the shot is the gun's m_aShootSounds (lib/weapons.js fireSound), and
// the draw and reload sounds are the CNmSoundEvents of its viewmodel clips, at their times (lasers-bake --weapons).
// A draw's sounds stop if you switch away or buy another; a reload's if the reload is cut short.
import { G } from './state.js';
import { firearm } from '../lib/weapons.js';

let drawn = 0; // bumps on every draw, so an earlier draw's pending sounds go quiet

function schedule(list, still) {
  for (const [t, name] of list) {
    if (t <= 0) { G.audio.play(name); continue; }
    setTimeout(() => { if (still()) G.audio.play(name); }, t * 1000);
  }
}

// a gun was drawn (key 1 / 2, Q back to it, a buy): the held one's draw
export function playGunDraw() {
  const id = ++drawn, gun = G.vm.held;
  schedule(gun?.drawSounds || [], () => drawn === id && G.vm.held === gun);
}

// the knife was drawn: a gun's draw still pending goes quiet
export function playKnifeDraw() {
  drawn++;
  G.audio.play('knife.deploy');
}

// the held gun's reload started
export function playGunReload() {
  const gun = G.vm.held;
  schedule(gun?.reloadSounds || [], () => G.vm.reloading && G.vm.held === gun);
}

// the sound of a bullet from this gun (a shot names its gun; an older shot without one is the held gun's)
export const fireSound = (gun) => firearm(gun)?.fireSound || G.vm.held?.fireSound || G.vm.gun.fireSound;
