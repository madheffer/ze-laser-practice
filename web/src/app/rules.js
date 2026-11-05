// The rules a run plays by. Solo, they are your settings. In a co-op / versus round they are the host's, sent with
// the round start (app/coop.js), so every client runs the same simulation: same seed, same humans and boss HP,
// same team fire. They are held for the round only and never saved into your settings.
import { S } from './state.js';
import { settings, sanitizeSettings } from './settings.js';
import { own } from '../lib/storage.js';

// what a round shares; everything else (sensitivity, ping, volume, camera) stays each player's own
export const SHARED = ['humans', 'bossHp', 'autoFire', 'perfectTeam', 'fallDamage'];

export function rule(key) {
  const r = S.mp?.rules;
  const v = r ? own(r, key) : undefined;
  return v !== undefined ? v : settings[key];
}

// God mode and slow motion would break a shared clock or a fair versus: a round runs at 1x, and versus never
// has god mode.
export const timescale = () => (S.mp ? 1 : settings.timescale);
export const godMode = () => (S.mp?.kind === 'versus' ? false : settings.god);

// The host's rules for a new round.
export function hostRules() {
  const out = { seed: settings.seed || ((Date.now() & 0xffff) || 1) };
  for (const k of SHARED) out[k] = settings[k];
  return out;
}

// Rules that came over the network: only the shared keys, typed and in range like saved settings are.
export function cleanRules(r) {
  if (!r || typeof r !== 'object') return { seed: 1 };
  const picked = {};
  for (const k of SHARED) if (Object.hasOwn(r, k)) picked[k] = r[k];
  const out = sanitizeSettings(picked);
  out.seed = Number.isInteger(r.seed) && r.seed > 0 && r.seed < 2 ** 31 ? r.seed : 1;
  return out;
}
