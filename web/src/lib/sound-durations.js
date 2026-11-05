// A map's soundevents.json -> Map(lower-case event name -> seconds it plays): the engine's point_soundevent times
// OnSoundFinished by it (world/entities/classes/soundents.js), on every client and on the co-op server alike. An
// event's own vsnd duration; a parent with children (a soundscape) the longest of them. Unknown or bad -> absent.
export function soundDurations(json) {
  const out = new Map();
  if (!json || typeof json !== 'object') return out;
  const own = (d) => (d && typeof d === 'object' && Number.isFinite(d.duration) && d.duration > 0 ? d.duration : 0);
  for (const [name, d] of Object.entries(json)) {
    let t = own(d);
    for (const c of Array.isArray(d?.children) ? d.children.slice(0, 32) : []) t = Math.max(t, own(json[c]));
    if (t > 0) out.set(name.toLowerCase(), t);
  }
  return out;
}
