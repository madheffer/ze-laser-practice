// The rules a run plays by. Solo, they are your own settings. In a co-op / versus round they are the ROOM's
// (lib/room-rules.js), sent by the server with the round start: every client runs the same simulation (same
// humans, boss HP, team fire), and cheats (god mode, hitboxes, auto bunnyhop) are off unless the room owner
// turned them on. Your own toggles do nothing in a round, and the room's rules are never saved into your settings.
import { S } from './state.js';
import { settings } from './settings.js';
import { RULE_DEFAULTS } from '../lib/room-rules.js';

export function rule(key) {
  if (S.mp && Object.hasOwn(RULE_DEFAULTS, key)) return S.mp.rules[key];
  return settings[key];
}

// a round runs on the server's clock: no slow motion
export const timescale = () => (S.mp ? 1 : settings.timescale);
export const godMode = () => rule('god');

// what movement reads (player.tick's settings): the room's auto bunnyhop in a round
let moveCache = null;
export function moveSettings() {
  if (!S.mp) return settings;
  if (moveCache?.src !== settings || moveCache.bhop !== S.mp.rules.autoBhop) moveCache = { src: settings, bhop: S.mp.rules.autoBhop, value: { ...settings, autoBhop: S.mp.rules.autoBhop } };
  return moveCache.value;
}
