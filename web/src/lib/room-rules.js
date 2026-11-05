// A co-op / versus room's settings, shared by the server (server/coop-*.js, which owns them) and the browser
// (the lobby form, the round's rules). Pure functions, no DOM: anything from a client is untrusted, and both
// sides clean it the same way.
//
// Cheats (god mode, laser hitboxes, auto bunnyhop) start OFF in every room: only the room owner can turn them
// on, everyone in the room sees that they are on (lobby + public list), and a round plays by the room's rules,
// never by a player's own settings.

export const ROOM_KINDS = ['coop', 'versus'];
export const ROOM_MAX = 8;
export const CHEATS = ['god', 'hitboxes', 'autoBhop'];

// A ZE server's defaults: the map's boss HP for 20 humans, the team shooting, no fall damage, no cheats.
export const RULE_DEFAULTS = Object.freeze({
  humans: 20, bossHp: 100, autoFire: true, perfectTeam: false, fallDamage: false,
  god: false, hitboxes: false, autoBhop: false,
  // who carries the map's heal item (world/items.js heals): 'none', 'all', or one player's id (co-op only; versus is
  // all or none, so nobody starts with an edge)
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
    else if (k === 'heal') out.heal = v === 'all' || v === 'none' ? v : Number.isInteger(v) && v > 0 ? v : 'none';
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
  const kind = ROOM_KINDS.includes(o.kind) ? o.kind : SETTINGS_DEFAULTS.kind;
  const rules = cleanRules(o.rules);
  if (kind === 'versus' && typeof rules.heal === 'number') rules.heal = 'all';
  return {
    name: cleanText(o.name, 32),
    public: o.public === true,
    kind,
    max: Math.min(ROOM_MAX, Math.max(2, members, max)),
    rules,
  };
}

// the round's item holders: the room's heal setting against who is in the round
export function healHolders(heal, ids) {
  if (heal === 'all') return [...ids];
  return typeof heal === 'number' && ids.includes(heal) ? [heal] : [];
}

export const cheatsOn = (rules) => CHEATS.filter((k) => rules?.[k] === true);
export const CHEAT_LABELS = { god: 'God mode', hitboxes: 'Laser hitboxes', autoBhop: 'Auto bunnyhop' };
