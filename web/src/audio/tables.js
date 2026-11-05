// Sound tables for audio.js: the short names the game uses, a soundevents.json read into a Map, and the URL of a file
// a table names. Tables are data (a map's): names are lower-cased keys, paths go through safeRelPath.
import { safeRelPath, versioned } from '../lib/paths.js';
import { FRESH } from '../lib/fetch.js';

// main.js's short names -> stock CS2 events (an entry can override pitch/volume). A gun's sounds are its own events by
// name (lib/weapons.js fireSound / drawSounds / reloadSounds, played by app/weapon-sounds.js).
export const ALIASES = {
  'knife.deploy': 'Weapon_Knife.Deploy',
  'knife.slash': 'Weapon_Knife.Slash',
  'knife.stab': { name: 'Weapon_Knife.Slash', pitch: 0.85, volume: 1.3 }, // the heavy swing; Weapon_Knife.Stab is its *hit*
  'knife.hit': 'Weapon_Knife.Hit',
  'knife.hitwall': 'Weapon_Knife.HitWall',
  'jump': 'Default.WalkJump',
  'land': 'Land_Concrete.StepLeft',
  'footstep': 'CT_Concrete.StepLeft',
  'hurt': 'Player.DamageBody.Victim',
  'hurt.fall': 'Player.DamageFall',
  'hurt.burn': 'Player.BurnDamage',
  'death': 'Player.Death',
  // the stage countdown's 3, 2, 1 (app/loop.js): CS2's Premier map pick/ban last-seconds tick
  'countdown.tick': 'UI.Premier.CounterTimer',
};

// A soundevents.json -> Map(lower-case name -> def). The map's carries the map's version; the stock one is
// revalidated every load and its ETag becomes the version of the stock sound files (a --stock-sounds rebake
// rewrites it): stock tables get table.version set here.
export async function readTable(url, table, stock) {
  const r = await fetch(versioned(url, table.version), stock ? FRESH : undefined);
  if (!r.ok) throw new Error(`${r.status}`);
  if (stock) table.version = r.headers.get('etag') || r.headers.get('last-modified');
  const json = await r.json();
  const events = new Map();
  for (const [name, def] of Object.entries(json && typeof json === 'object' ? json : {})) {
    if (def && typeof def === 'object' && !Array.isArray(def)) events.set(name.toLowerCase(), { ...def, name });
  }
  return events;
}

// A sound file a table names, as a URL (null if the path isn't a safe relative one: tables are a map's data).
export function fileUrl(table, file) {
  const rel = safeRelPath(file);
  return rel == null ? null : versioned(table.base + rel, table.version);
}
