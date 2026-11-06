// Your map items: which you hold at the stage start (heldItems -> world/run-engine.js), the teammates' items your copy
// of the map runs (heldMates), and E (CS2 +use) to use yours. Nobody holds more than one item.
// Solo: your settings (world/items.js soloLoadout): the heal option, the map's ultima held by you (E) or set off by a
// teammate at a time you pick. A replay: the rules it was recorded with. In a room the room decides who holds what
// (S.mp.heldItems / mateItems: lib/room-rules.js itemHolders, everyone sees who on the item HUD).
import { S } from './state.js';
import { settings } from './settings.js';
import { soloLoadout, useItems as press } from '../world/items.js';

const soloRules = () => (S.replay ? S.replay.meta.rules : settings);

export function heldItems() {
  if (S.mp) return S.mp.heldItems?.() || [];
  return soloLoadout(soloRules(), S.map?.items).items;
}

export function heldMates() {
  if (S.mp) return S.mp.mateItems?.() || [];
  return soloLoadout(soloRules(), S.map?.items).mates;
}

export function useItems() {
  const { engine, run } = S;
  if (!engine || !run?.items?.length || !run.started || run.done || run.spectating || S.replay) return;
  run.rec?.event(run.ticks, 'use');
  press(engine, run.items);
  S.mp?.used(run.ticks); // a round's server presses it on its copy of your run, on the same tick
}
