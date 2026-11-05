// The primary's own sounds, as CS2 plays them: the shot is the gun's m_aShootSounds (lib/weapons.js fireSound), and
// the draw and reload sounds are the CNmSoundEvents of its viewmodel clips, at their times (lasers-bake --weapons).
// A draw's sounds stop if you switch away or buy another; a reload's if the reload is cut short.
import { G } from './state.js';
import { GUNS } from '../lib/weapons.js';

let drawn = 0; // bumps on every draw, so an earlier draw's pending sounds go quiet

function schedule(list, still) {
  for (const [t, name] of list) {
    if (t <= 0) { G.audio.play(name); continue; }
    setTimeout(() => { if (still()) G.audio.play(name); }, t * 1000);
  }
}

// the primary was drawn (key 1, Q back to it, a buy)
export function playGunDraw() {
  const id = ++drawn, gun = G.vm.gunName;
  schedule(GUNS[gun]?.drawSounds || [], () => drawn === id && G.vm.weapon === 'gun' && G.vm.gunName === gun);
}

// the knife was drawn: a gun's draw still pending goes quiet
export function playKnifeDraw() {
  drawn++;
  G.audio.play('knife.deploy');
}

// the primary's reload started
export function playGunReload() {
  const gun = G.vm.gunName;
  schedule(GUNS[gun]?.reloadSounds || [], () => G.vm.reloading && G.vm.gunName === gun);
}

// the sound of a bullet from this gun (a shot names its gun; an older shot without one is the held gun's)
export const fireSound = (gun) => GUNS[gun]?.fireSound || GUNS[G.vm.gunName]?.fireSound;
