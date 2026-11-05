// Same-origin fetches that fail loudly on HTTP errors (a 404 page must never be parsed as data).

async function ok(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r;
}

export const fetchJson = async (url, init) => (await ok(url, init)).json();
export const fetchBuffer = async (url, init) => (await ok(url, init)).arrayBuffer();

// For the files that say which version everything else is (manifest.json, maps/index.json): always revalidate.
export const FRESH = { cache: 'no-cache' };
