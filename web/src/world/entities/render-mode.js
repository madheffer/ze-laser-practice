// Whether an entity's model is drawn, from its keyvalues, as a CS2Fixes ZE server (GFL) runs the map. Truth sources
// (Ghidra: cs2_server_20260923.dll, client_20261015.dll; schema: cs2-dumper server_dll 2026-10-30; CS2Fixes src/
// mapmigrations.cpp):
//   - CS2's RenderMode_t is kRenderNormal 0, kRenderTransAlpha 1, kRenderNone 2 (kRenderModeCount 3) since the
//     2026-01-21 update; Source 1's numbers (4 TransAlpha, 10 None, ...) are gone. An enumerator name is parsed as
//     that enumerator (FUN_181371c40); a number is stored as it is. The client hides the scene object only for 2
//     (SetRenderMode, FUN_1809650c0): every other value draws, ze_alien_shooter's rendermode 3 lasers included.
//   - CS2Fixes' map migrations (cs2f_mapmigrations_20260121, default 2 = maps whose workshop item was last updated
//     before 2026-01-21; GFL keeps the default) remap a NUMBERED rendermode at spawn: 4 -> kRenderTransAlpha,
//     10 -> kRenderNone, any other above 0 -> kRenderNormal. Names are left alone. So on an older map Source 1's 10
//     hides (mist's movers, neochrome's playerstart angle helpers) and a numbered 2 draws (neochrome's nut_zpath1,
//     faded in with Alpha); on a newer one 2 hides and 10 draws.
//   - renderamt 0: the alpha the client tints the scene object with (FUN_180bf2e30): nothing to see.
//   - prop_dynamic StartDisabled: CDynamicProp::Spawn (FUN_180bbf0e0) adds EF_NODRAW when m_bStartDisabled (0xc6d).
// The scenario file's top-level `workshopUpdated` (the workshop item's time_updated, YYYY-MM-DD) says which.
// Distance fading (fademindist / fademaxdist) is per frame: render.js fadedOut.

const MIGRATION_20260121 = '2026-01-21';

// does CS2Fixes run the 2026-01-21 migrations on a map last updated on `updated` (YYYY-MM-DD)? Unknown: no (stock CS2)
export const migrates20260121 = (updated) => typeof updated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(updated) && updated < MIGRATION_20260121;

// the render mode the entity spawns with: 'normal' | 'transalpha' | 'none'
export function renderModeOf(kv, migrated) {
  const v = String(kv?.rendermode ?? '').trim();
  if (/^kRenderNone$/i.test(v)) return 'none';
  if (/^kRenderTransAlpha$/i.test(v)) return 'transalpha';
  if (!/^\d+$/.test(v)) return 'normal'; // kRenderNormal, or a name CS2 dropped (the parser keeps the default)
  const n = Number(v);
  if (migrated) return n === 10 ? 'none' : n === 4 ? 'transalpha' : 'normal';
  return n === 2 ? 'none' : n === 1 ? 'transalpha' : 'normal';
}

// the model is never drawn as spawned (an I/O input may change that later; the engine's `visible` follows)
export function spawnsHidden(kv, migrated) {
  return renderModeOf(kv, migrated) === 'none' || String(kv?.renderamt ?? '') === '0';
}

// CDynamicProp classes whose StartDisabled is EF_NODRAW
const DYNAMIC_PROPS = new Set(['prop_dynamic', 'prop_dynamic_override', 'dynamic_prop']);
export const startsNoDraw = (cls, kv) => DYNAMIC_PROPS.has(cls) && /^(1|true)$/i.test(String(kv?.startdisabled ?? ''));
