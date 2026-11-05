// A multiplayer room's settings, shared by the server (server/coop-*.js, which owns them) and the browser
// (the lobby form, the round's rules). Pure functions, no DOM: anything from a client is untrusted, and both
// sides clean it the same way.
//
// One mode: everyone plays the same stage together and against each other (server/coop-round.js decides the end
// and who did best). Co-op and versus were two kinds; a room of either kind now cleans to the one ('coop', the
// name the stored runs and leaderboards already use).
//
// Cheats (god mode, laser hitboxes, auto bunnyhop) start OFF in every room: only the room owner can turn them
// on, everyone in the room sees that they are on (lobby + public list), and a round plays by the room's rules,
// never by a player's own settings.

export const ROOM_KINDS = ['coop'];
export const ROOM_MAX = 8;
export const CHEATS = ['god', 'hitboxes', 'autoBhop'];

// The defaults: the map's boss HP for who is playing, no team fire, no fall damage, no cheats.
// fixedHumans: off = boss HP scales as the map scales it on a server, once per human who is there (solo: 1; a
// round: everyone in it at the start, never fewer as they die: the map adds HP when the boss starts and never takes
// it back); on = it is for `humans` of them, and the ones who aren't real players are the simulated team
export const RULE_DEFAULTS = Object.freeze({
  humans: 20, fixedHumans: false, bossHp: 100, autoFire: false, perfectTeam: false, fallDamage: false,
  god: false, hitboxes: false, autoBhop: false,
  // who carries the map's heal item (world/items.js usableHeals): 'none', 'random' (one player, from the round's
  // seed) or a player's id (an aura the group gathers round, so ONE human holds it, as on a server), or 'all'
  // (everyone their own: each player's run is separate, so an aura heals only its holder)
  heal: 'none',
});
const RANGES = { humans: [1, 64], bossHp: [1, 100] };

export const SETTINGS_DEFAULTS = Object.freeze({ name: '', public: false, kind: 'coop', max: 4 });

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f<>]/g;
export function cleanText(v, max) {
  return String(v ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
export const cleanName = (n) => cleanText(n, 20) || 'Player';

export function cleanRules(r) {
  const out = { ...RULE_DEFAULTS };
  if (!r || typeof r !== 'object') return out;
  for (const k of Object.keys(RULE_DEFAULTS)) {
    if (!Object.hasOwn(r, k)) continue;
    const d = RULE_DEFAULTS[k], v = r[k];
    if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (k === 'heal') out.heal = ['none', 'all', 'random'].includes(v) ? v : Number.isInteger(v) && v > 0 ? v : 'none';
    else if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v)) {
      const [lo, hi] = RANGES[k];
      out[k] = Math.round(Math.min(hi, Math.max(lo, v)));
    }
  }
  return out;
}

// { name, public, kind, max, rules }; `members` = how many are in the room now (max never drops below it)
export function cleanSettings(s, members = 1) {
  const o = s && typeof s === 'object' ? s : {};
  const max = Number.isInteger(o.max) ? o.max : SETTINGS_DEFAULTS.max;
  const rules = cleanRules(o.rules);
  return {
    name: cleanText(o.name, 32),
    public: o.public === true,
    kind: SETTINGS_DEFAULTS.kind, // one mode (a saved 'versus' room comes back as it)
    max: Math.min(ROOM_MAX, Math.max(2, members, max)),
    rules,
  };
}

// the round's heal holders: the room's setting against who is in the round ('random': one of them, picked from the
// round's seed, so it is the same pick wherever it's worked out)
export function healHolders(heal, ids, seed = 0) {
  if (!ids.length) return [];
  if (heal === 'all') return [...ids];
  if (heal === 'random') return [[...ids].sort((a, b) => a - b)[Math.abs(seed | 0) % ids.length]];
  return typeof heal === 'number' && ids.includes(heal) ? [heal] : [];
}

// how many humans the boss HP is for, with `players` real ones in the run (see fixedHumans above)
export const bossHumans = (rules, players = 1) => (rules?.fixedHumans ? Math.max(players, rules.humans) : Math.max(1, players));
// the room's chip / summary for it
export const humansLabel = (rules) => (rules?.fixedHumans ? `Boss HP for ${rules.humans} humans` : 'Boss HP for the lobby');

export const cheatsOn = (rules) => CHEATS.filter((k) => rules?.[k] === true);
export const CHEAT_LABELS = { god: 'God mode', hitboxes: 'Laser hitboxes', autoBhop: 'Auto bunnyhop' };
