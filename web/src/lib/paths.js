// Names and paths that end up in a fetch URL. Map names come from ?map=, maps/index.json and the menu; asset
// paths come from a map's own files (manifest.json, entities.json, soundevents.json): all untrusted.
// Pure functions (no DOM): tools/index-maps.mjs imports this file too. The bake applies the same rules
// (bake/SafePath.cs).

// A map folder name: letters, digits, _ and -, no dots or slashes (so never "..", never a URL).
export const MAP_NAME = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;
export const isMapName = (n) => typeof n === 'string' && MAP_NAME.test(n);

export function mapName(n) {
  if (!isMapName(n)) throw new Error(`bad map name: ${JSON.stringify(String(n).slice(0, 80))}`);
  return n;
}

// A relative path inside a map folder ("world/x.glb", "sounds/a/b.wav"): forward slashes, no "." / ".."
// segments, not rooted, no scheme or drive (":"), no query/fragment/percent-escapes (the URL parser turns
// %2e%2e into ".."), no control characters or HTML quote/angle characters. Returns the normalised path, or
// null if it isn't safe.
export function safeRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 512) return null;
  const s = p.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f:?#%<>"'`]/.test(s) || s.startsWith('/')) return null;
  const parts = s.split('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '.' || seg === '..') return null;
    if (!seg && i !== parts.length - 1) return null; // "a//b" (a trailing "/" is fine: a directory)
  }
  return s;
}

// A URL with the map's version on it (`?v=<manifest.version>`), so files the dev server / host cache as
// immutable (/maps, /sounds: vite.config.js) are fetched again after a rebake. No version = the URL as is.
// GLTFLoader resolves a glb's textures against the URL up to its last "/", so the query doesn't leak into them.
export function versioned(url, version) {
  if (version == null || version === '') return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(version))}`;
}

// The key a model / effect path is stored and looked up under: forward slashes, lower case.
// Maps baked before the bake unwrapped resource-typed keys have model values like resource_name:"maps/x.vmdl".
export const assetKey = (p) => String(p ?? '').replace(/^resource_name:"(.*)"$/s, '$1').replace(/\\+/g, '/').toLowerCase();
