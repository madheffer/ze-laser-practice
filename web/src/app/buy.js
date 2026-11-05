// Buying a gun, CS2Fixes style (src/commands.cpp ParseWeaponCommand): !bizon, !ak, !m4a1 ... replace your primary
// with that gun and switch to it. Only while you are a living human in a stage (a replay plays its own buys back).
// The co-op server is told, so its shot checks hold you to the new gun's numbers (server/coop-check.js setGun).
// It costs CS2's price (m_nPrice) out of your money, worded as CS2Fixes words it.
import { S, G } from './state.js';
import { GUNS, GUN_IDS, findGun, gunCommandNames, gunSounds } from '../lib/weapons.js';
import { registerCommand, cs2fixes } from './chat-commands.js';
import { playGunDraw } from './weapon-sounds.js';

// -> { ok, gun?, reply } (reply: CS2Fixes' chat line, without its prefix)
export function buyWeapon(text) {
  const name = findGun(text);
  if (!name) return { ok: false, reply: `Unknown weapon "${String(text ?? '').slice(0, 40)}"` };
  const { run } = S;
  if (!run || run.done || run.spectating || S.replay) return { ok: false, gun: name, reply: 'You can only buy weapons when human.' };
  const g = GUNS[name];
  // CS2Fixes charges m_nPrice from your money (run.money: app/session.js)
  if (Number.isFinite(run.money)) {
    if (run.money < g.price) return { ok: false, gun: name, reply: `You can't afford ${g.label}! It costs $${g.price}, you only have $${run.money}` };
    run.money -= g.price;
  }
  G.audio.preload(gunSounds(name));
  G.vm.setGun(name);
  G.hud.showWeapons('gun', name);
  playGunDraw();
  run.rec?.event(run.ticks, 'buy', { gun: GUN_IDS.indexOf(name) }); // its replay switches gun on the same tick
  S.mp?.bought?.(name);
  return { ok: true, gun: name, reply: `You have purchased ${g.label} for $${g.price}` };
}

// a chat command for every alias and class name (with and without weapon_)
for (const name of Object.keys(GUNS)) {
  registerCommand(gunCommandNames(name), () => cs2fixes(buyWeapon(name).reply));
}
