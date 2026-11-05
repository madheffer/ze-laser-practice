// Static files for the standalone server (main.js --static <dir> ...): the built game (web/dist) and the baked
// content that isn't in the build (maps, sounds, weapons, panorama, player), from one or more folders; the first
// folder that has a path wins. GET / HEAD only, never a directory listing, never outside a folder (every path
// is resolved and checked against its root), never a dotfile. Headers as `npm run play`: the CSP and the year-long
// cache for versioned maps + sounds (http-policy.js); an unversioned map file (manifest.json, index.json) is
// no-cache. A missing file is a plain 404, never index.html: the game probes for optional map files (quality
// tiers, chunks.json, ...) and must see them missing. Compressible files (meshopt glbs, raw lightmap blocks, JSON)
// go out brotli / gzip, as the browser accepts.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';
import { CSP_HEADER, IMMUTABLE_CACHE, isImmutable } from './http-policy.js';

const COMPRESS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.glb', '.bin', '.lut', '.wav', '.xml', '.txt', '.ttf', '.otf']);
const MIN_COMPRESS = 1024; // bytes: smaller files aren't worth it

// a compressing stream the browser accepts, or null. Brotli at 5: most of max's ratio at a fraction of its CPU.
function encoder(req, ext, size) {
  if (!COMPRESS.has(ext) || size < MIN_COMPRESS) return null;
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) {
    return { name: 'br', stream: zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } }) };
  }
  if (/\bgzip\b/.test(accept)) return { name: 'gzip', stream: zlib.createGzip({ level: 6 }) };
  return null;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.lut': 'application/octet-stream', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.xml': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const SEGMENT = /^[A-Za-z0-9_.@-]+$/; // what a baked or built file name may look like; no dotfiles (below)

// the request path as safe segments, or null: decoded, no empty / dot / dotfile / odd-character segments
function segments(url) {
  let p;
  try { p = decodeURIComponent((url || '/').split('?')[0]); } catch { return null; }
  if (p === '/' || p === '') return ['index.html'];
  const parts = p.split('/').filter((s, i) => !(i === 0 && s === ''));
  if (!parts.length || parts.some((s) => !SEGMENT.test(s) || s.startsWith('.'))) return null;
  return parts;
}

// roots: folders, first match wins. Returns (req, res, next) => handled.
export function staticFiles(roots) {
  const dirs = roots.map((r) => path.resolve(r));
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const parts = segments(req.url);
    if (!parts) return next();
    for (const root of dirs) {
      const file = path.resolve(root, ...parts);
      if (!file.startsWith(root + path.sep)) continue; // belt and braces: never leave the folder
      let st;
      try { st = await stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      const ext = path.extname(file).toLowerCase();
      const type = TYPES[ext] || 'application/octet-stream';
      const headers = {
        'content-type': type, 'content-length': st.size, 'x-content-type-options': 'nosniff',
        'last-modified': st.mtime.toUTCString(), vary: 'Accept-Encoding',
        'cache-control': isImmutable(req.url) ? IMMUTABLE_CACHE
          : parts.at(-1) === 'index.html' || parts[0] === 'maps' ? 'no-cache' // manifest.json, index.json: always fresh
          : parts[0] === 'assets' ? IMMUTABLE_CACHE /* Vite's hashed build output */ : 'public, max-age=300',
      };
      if (type.startsWith('text/html')) headers['content-security-policy'] = CSP_HEADER;
      if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(st.mtime.toUTCString())) {
        delete headers['content-length'];
        res.writeHead(304, headers);
        return res.end();
      }
      const enc = encoder(req, ext, st.size);
      if (enc) { delete headers['content-length']; headers['content-encoding'] = enc.name; }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { enc?.stream.destroy(); return res.end(); }
      // pipeline tears every stage down when the player closes the tab mid-download
      const stages = enc ? [createReadStream(file), enc.stream, res] : [createReadStream(file), res];
      pipeline(...stages, () => {});
      return;
    }
    next();
  };
}
