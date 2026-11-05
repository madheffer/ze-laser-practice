// Small HTTP helpers shared by the server's handlers (api.js, auth/, runs-http.js) and the co-op socket.

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

// the request body, at most `limit` bytes (rejects with .status 413 past it)
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { const e = new Error('too large'); e.status = 413; reject(e); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

// A request that changes something must come from a page on this site: the browser always sends Origin on a
// POST, and it has to be this host. (The session cookie is SameSite=Lax too; this is the second lock.)
export function sameOriginWrite(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// A socket opening from a page: when an Origin is sent it has to be this host (no Origin: not a browser).
export function sameOriginSocket(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// The address rate limits count. Behind a reverse proxy / tunnel every request comes from the proxy, so the host
// names the header that proxy sets to the real client (ipHeader, e.g. cf-connecting-ip). Only set it when a proxy
// you run always sets that header: otherwise a client could send any value. Never logged or sent anywhere.
export function clientAddress(req, ipHeader) {
  const fromProxy = ipHeader ? String(req.headers[ipHeader] || '').split(',')[0].trim().slice(0, 64) : '';
  return fromProxy || req.socket.remoteAddress || '';
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!Object.hasOwn(out, k)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// https as the browser sees it: TLS here, or a proxy in front that says so
export const isHttps = (req) => !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// one call per key per `ms` (a sliding gate, with the map pruned as it grows)
export function rateGate(ms, max = 10000) {
  const last = new Map();
  return (key) => {
    const now = Date.now();
    if (now - (last.get(key) || 0) < ms) return false;
    last.set(key, now);
    if (last.size > max) for (const [k, t] of last) if (now - t > ms) last.delete(k);
    return true;
  };
}
