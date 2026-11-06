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
  // the map's ultima (world/items.js: offliner's Shockwave, westersand's Holy Magick): 'none', 'random' or a player's id
  // (they hold it and set it off with E; it never goes off by itself), or 'auto' (nobody holds it: it goes off
  // ultimaAt s after the stage starts, for everyone)
  ultima: 'none', ultimaAt: 0,
});
const RANGES = { humans: [1, 64], bossHp: [1, 100], ultimaAt: [0, 300] };

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
    else if (k === 'ultima') out.ultima = ['none', 'auto', 'random'].includes(v) ? v : Number.isInteger(v) && v > 0 ? v : 'none';
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

// Who holds what this round: the room's heal / ultima settings against who is in it, on a map that has them (`has`:
// { heal, ultima }). NOBODY HOLDS MORE THAN ONE ITEM: a player picked by name keeps that pick, a random pick is made
// among the players who hold nothing yet, 'all' (the heal) skips the ultima's holder, and a heal picked for the
// ultima's holder goes to a random other player instead. Random picks come from the round's seed, so they are the
// same wherever this runs. -> { heal: [ids], ultima: id | null, auto: the ultima goes off by itself }
export function itemHolders(rules, ids, seed = 0, has = { heal: true, ultima: false }) {
  const pool = [...ids].sort((a, b) => a - b);
  const s = Math.abs(seed | 0);
  const pick = (from, salt) => (from.length ? from[(s + salt) % from.length] : null);
  const heal = has.heal ? rules?.heal : 'none', ult = has.ultima ? rules?.ultima : 'none';
  let ultima = typeof ult === 'number' && pool.includes(ult) ? ult : null;
  let heals = [];
  if (heal === 'all') heals = pool;
  else if (typeof heal === 'number' && pool.includes(heal) && heal !== ultima) heals = [heal];
  if (ult === 'random') ultima = pick(pool.filter((id) => !heals.includes(id) || heal === 'all'), 7919);
  if (heal === 'random' || (typeof heal === 'number' && heal === ultima)) heals = [pick(pool.filter((id) => id !== ultima), 0)].filter((id) => id != null);
  heals = heals.filter((id) => id !== ultima);
  return { heal: heals, ultima, auto: ult === 'auto' };
}

// how many humans the boss HP is for, with `players` real ones in the run (see fixedHumans above)
export const bossHumans = (rules, players = 1) => (rules?.fixedHumans ? Math.max(players, rules.humans) : Math.max(1, players));
// the room's chip / summary for it
export const humansLabel = (rules) => (rules?.fixedHumans ? `Boss HP for ${rules.humans} humans` : 'Boss HP for the lobby');

// the room's item chips (lobby / room screen): who holds the heal and the ultima. has: { heal: bool, ultima: the map's
// ultima name or null }; nameOf(id): a member's name
export function itemLabels(r, has, nameOf) {
  const who = (v) => (v === 'random' ? 'a random player' : typeof v === 'number' ? nameOf(v) || 'nobody (left)' : null);
  const out = [];
  if (has.heal) { if (r.heal === 'all') out.push('Heal: everyone their own'); else if (who(r.heal)) out.push(`Heal: ${who(r.heal)}`); }
  if (has.ultima) {
    if (r.ultima === 'auto') out.push(`${has.ultima}: goes off ${r.ultimaAt} s in`);
    else if (who(r.ultima)) out.push(`${has.ultima}: ${who(r.ultima)}`);
  }
  return out;
}

export const cheatsOn = (rules) => CHEATS.filter((k) => rules?.[k] === true);
export const CHEAT_LABELS = { god: 'God mode', hitboxes: 'Laser hitboxes', autoBhop: 'Auto bunnyhop' };
