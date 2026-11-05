// How a map's stages are grouped for the stage list and the map picker: every map reads the same way, Main stages →
// the ending → special modes (Redcore, ...) → Mini bosses, whatever order the scenario file lists its groups in.
// Inside a group the full runs come first, then the parts, each in file order. Pure (no DOM): tools/index-maps.mjs
// imports it too.

const rank = (name) => {
  if (/^main stages$/i.test(name)) return 0;
  if (/ending/i.test(name)) return 1;
  if (/^mini bosses$/i.test(name)) return 3;
  return 2;
};

// scenarios: the file's list. Returns [{ name, items: [index, ...] }] for the top-level stages (no `parent`).
export function groupStages(scenarios) {
  const parts = [];
  scenarios.forEach((s, i) => {
    if (s.parent) return;
    const name = String(s.group || 'Stages');
    let p = parts.find((x) => x.name === name);
    if (!p) parts.push((p = { name, items: [] }));
    p.items.push(i);
  });
  for (const p of parts) p.items.sort((a, b) => (scenarios[b].full ? 1 : 0) - (scenarios[a].full ? 1 : 0) || a - b);
  return parts.map((p, k) => [p, k]).sort(([a, ka], [b, kb]) => rank(a.name) - rank(b.name) || ka - kb).map(([p]) => p);
}
