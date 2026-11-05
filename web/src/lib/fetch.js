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

// An ArrayBuffer, telling onBytes(n) how many more bytes arrived as they do (a loading bar for a big file).
export async function fetchBufferProgress(url, onBytes, init) {
  const r = await ok(url, init);
  if (!r.body?.getReader) { const b = await r.arrayBuffer(); onBytes(b.byteLength); return b; }
  const reader = r.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); size += value.byteLength;
    onBytes(value.byteLength);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out.buffer;
}
