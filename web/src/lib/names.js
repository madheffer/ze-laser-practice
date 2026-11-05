// Entity target names. CS2 maps prefix most names with "[PR#]"; lookups ignore it and the case.
// Pure functions (no DOM): tools/io-graph.mjs imports this file too.

export const stripPrefix = (n) => String(n ?? '').replace(/^\[PR#\]/i, '');
export const nameKey = (n) => stripPrefix(n).toLowerCase();

// Does a name match a pattern? A trailing * matches a prefix (Source's wildcard), like the engine's find().
export function nameMatches(pattern, name) {
  const p = nameKey(pattern), k = nameKey(name);
  return p.endsWith('*') ? k.startsWith(p.slice(0, -1)) : p === k;
}

// [{target, input}] (or one, or none) -> (entityKey, input) => true when one matches. `target` may end in *.
export function inputMatcher(spec) {
  const list = (Array.isArray(spec) ? spec : spec ? [spec] : [])
    .filter((w) => w && w.target != null && w.input != null)
    .map((w) => {
      const key = nameKey(w.target);
      const wild = key.endsWith('*');
      return { key: wild ? key.slice(0, -1) : key, wild, input: String(w.input).toLowerCase() };
    });
  const match = (key, input) => {
    const il = String(input).toLowerCase();
    return list.some((w) => w.input === il && (w.wild ? key.startsWith(w.key) : key === w.key));
  };
  match.size = list.length;
  return match;
}
