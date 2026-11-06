// The rules a run plays by. Solo, they are your own settings. In a co-op / versus round they are the ROOM's
// (lib/room-rules.js), sent by the server with the round start: every client runs the same simulation (same
// humans, boss HP, team fire), and cheats (god mode, hitboxes, auto bunnyhop) are off unless the room owner
// turned them on. Your own toggles do nothing in a round, and the room's rules are never saved into your settings.
// A replay (app/replay.js) plays by the rules it was recorded with (lib/replay-codec.js cleanMeta), cheats off.
import { S } from './state.js';
import { settings } from './settings.js';
import { RULE_DEFAULTS, bossHumans } from '../lib/room-rules.js';

// humans: the count the boss HP is for (lib/room-rules.js bossHumans). A round's comes resolved from the server and a
// replay's was recorded resolved; solo it is you alone unless "Boss HP for N humans" is on
export function rule(key) {
  if (S.mp && Object.hasOwn(RULE_DEFAULTS, key)) return S.mp.rules[key];
  if (S.replay) return Object.hasOwn(S.replay.meta.rules, key) ? S.replay.meta.rules[key] : (Object.hasOwn(RULE_DEFAULTS, key) ? RULE_DEFAULTS[key] : settings[key]);
  if (key === 'humans') return bossHumans(settings, 1);
  return settings[key];
}

// GFL's map edits (lib/stripper.js) this run leaves out: none in a round (the server's copy plays them all, as GFL's
// server does), a replay's own, solo your settings' for the map (settings.stripperOff / stripperCount).
// -> { off: [ids], counts: { id: n } } (lib/stripper.js cleanChoice); a round plays every edit at its default count
export function stripperChoice(map) {
  if (S.mp) return { off: [], counts: {} };
  if (S.replay) return { off: S.replay.meta.rules.stripperOff || [], counts: S.replay.meta.rules.stripperCount || {} };
  const own = (o) => (Object.hasOwn(o, map) ? o[map] : undefined);
  return { off: own(settings.stripperOff) || [], counts: own(settings.stripperCount) || {} };
}

// the real players in this run: a round's roster, else you
export const players = () => (S.mp ? Math.max(1, S.mp.players?.size || 1) : 1);

// a round runs on the server's clock: no slow motion
export const timescale = () => (S.mp ? 1 : S.replay ? S.replay.speed : settings.timescale);
export const godMode = () => rule('god');

// what movement reads (player.tick's settings): the room's auto bunnyhop in a round
let moveCache = null;
export function moveSettings() {
  if (!S.mp) return settings;
  if (moveCache?.src !== settings || moveCache.bhop !== S.mp.rules.autoBhop) moveCache = { src: settings, bhop: S.mp.rules.autoBhop, value: { ...settings, autoBhop: S.mp.rules.autoBhop } };
  return moveCache.value;
}
