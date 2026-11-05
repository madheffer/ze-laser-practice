// Your map items: which you hold at the stage start (heldItems -> world/run-engine.js) and E (CS2 +use) to use them.
// Solo: the map's heal items when the map's heal option is on (the stage list header). In a room the room decides who
// holds what (S.mp.heldItems(): one human holds the heal, everyone sees who on the item HUD).
import { S } from './state.js';
import { rule } from './rules.js';
import { useItems as press } from '../world/items.js';

export function heldItems() {
  if (S.mp) return S.mp.heldItems?.() || [];
  return rule('healItem') ? (S.map?.items || []).filter((it) => it.heal && it.usable) : [];
}

export function useItems() {
  const { engine, run } = S;
  if (!engine || !run?.items?.length || !run.started || run.done || run.spectating || S.replay) return;
  run.rec?.event(run.ticks, 'use');
  press(engine, run.items);
  S.mp?.used(run.ticks); // a round's server presses it on its copy of your run, on the same tick
}
