// Entity target names. CS2 maps prefix most names with "[PR#]"; lookups ignore it and the case.
// Pure functions (no DOM): tools/io-graph.mjs imports this file too.

export const stripPrefix = (n) => String(n ?? '').replace(/^\[PR#\]/i, '');
export const nameKey = (n) => stripPrefix(n).toLowerCase();

// Does a name match a pattern? A trailing * matches a prefix (Source's wildcard), like the engine's find().
export function nameMatches(pattern, name) {
  const p = nameKey(pattern), k = nameKey(name);
  return p.endsWith('*') ? k.startsWith(p.slice(0, -1)) : p === k;
}

// [{target, input}] (or one, or none) -> (entityKey, input, callerKey) => the matching entry ({ key, wild, input,
// survive, from }), or undefined. `target` may end in *. `survive`: s the player must still be alive after it (a win on
// a nuke's Enable). `from`: only when that entity sends it (ze_deadcore's dodge corridor: the end trigger's Disable,
// not the map's clock sending the same one).
export function inputMatcher(spec) {
  const list = (Array.isArray(spec) ? spec : spec ? [spec] : [])
    .filter((w) => w && w.target != null && w.input != null)
    .map((w) => {
      const key = nameKey(w.target);
      const wild = key.endsWith('*');
      return { key: wild ? key.slice(0, -1) : key, wild, input: String(w.input).toLowerCase(), survive: Math.max(0, Number(w.survive) || 0), from: w.from != null ? nameKey(w.from) : null };
    });
  const match = (key, input, from) => {
    const il = String(input).toLowerCase();
    return list.find((w) => w.input === il && (w.wild ? key.startsWith(w.key) : key === w.key) && (!w.from || w.from === from));
  };
  match.size = list.length;
  return match;
}
