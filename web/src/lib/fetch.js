// Same-origin fetches that fail loudly on HTTP errors (a 404 page must never be parsed as data), and never hang:
// a response that stops arriving for IDLE_MS (a file replaced on the host mid-download, a dropped connection) is
// aborted, and a GET that failed that way (not an HTTP error) is tried once more.

const IDLE_MS = 20_000;
const RETRIES = 1;

// fetch + read the whole body, aborting when nothing arrives for IDLE_MS. onBytes(n): bytes as they arrive
async function load(url, init, onBytes) {
  const ctl = new AbortController();
  let timer = null;
  const poke = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(new Error(`${url}: no data for ${IDLE_MS / 1000} s`)), IDLE_MS); };
  const outer = init?.signal;
  if (outer) { if (outer.aborted) ctl.abort(outer.reason); else outer.addEventListener('abort', () => ctl.abort(outer.reason), { once: true }); }
  poke();
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) throw Object.assign(new Error(`${url}: ${r.status}`), { http: true });
    if (!r.body?.getReader) { const b = await r.arrayBuffer(); onBytes?.(b.byteLength); return b; }
    const reader = r.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      poke();
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); size += value.byteLength;
      onBytes?.(value.byteLength);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out.buffer;
  } finally {
    clearTimeout(timer);
  }
}

async function get(url, init, onBytes) {
  const retry = !init?.method || init.method === 'GET';
  for (let i = 0; ; i++) {
    try { return await load(url, init, onBytes); } catch (e) {
      if (e.http || !retry || i >= RETRIES || init?.signal?.aborted) throw e;
    }
  }
}

export const fetchJson = async (url, init) => JSON.parse(new TextDecoder().decode(await get(url, init)));
export const fetchBuffer = (url, init) => get(url, init);

// For the files that say which version everything else is (manifest.json, maps/index.json): always revalidate.
export const FRESH = { cache: 'no-cache' };

// An ArrayBuffer, telling onBytes(n) how many more bytes arrived as they do (a loading bar for a big file).
export const fetchBufferProgress = (url, onBytes, init) => get(url, init, onBytes);
