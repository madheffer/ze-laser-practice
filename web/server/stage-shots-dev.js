// Dev only: the stage thumbnail capture (src/dev/capture-stage-shots.js, run in the page) POSTs one small webp per
// stage here, and this writes it to web/public/maps/<map>/stages/<id>.webp. `vite` (serve) only, never a build or
// preview, and only from this machine: a loopback socket, a localhost Host (no DNS rebinding) and, when the browser
// sends one, a localhost Origin. The map must be a map name with a scenario file, the id one of that file's stages,
// the body a real webp under MAX_BYTES. Nothing else is ever written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMapName, isStageId } from '../src/lib/paths.js';

const ROUTE = '/__dev/stage-shot';
const MAX_BYTES = 64 * 1024;
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function fail(res, code, msg) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain');
  res.end(msg);
}

function stageIds(map) {
  const f = path.join(PUBLIC, 'scenarios', `${map}.json`);
  if (!fs.existsSync(f)) return null;
  const list = JSON.parse(fs.readFileSync(f, 'utf8')).scenarios;
  return new Set((Array.isArray(list) ? list : []).map((s) => s?.id).filter(isStageId));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { reject(new Error('too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const isWebp = (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';

async function handle(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  if (!LOOPBACK.has(req.socket.remoteAddress) || !LOCAL_HOST.test(req.headers.host || '')) return fail(res, 403, 'localhost only');
  if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return fail(res, 403, 'localhost only');
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'image/webp') return fail(res, 415, 'image/webp only');
  if (Number(req.headers['content-length'] || 0) > MAX_BYTES) return fail(res, 413, 'too large');
  const q = new URL(req.url, 'http://localhost').searchParams;
  const map = q.get('map');
  const id = q.get('id');
  if (!isMapName(map) || !isStageId(id)) return fail(res, 400, 'bad map or stage id');
  const ids = stageIds(map);
  if (!ids || !ids.has(id)) return fail(res, 404, 'no such stage');
  const mapDir = path.join(PUBLIC, 'maps', map);
  if (!fs.existsSync(path.join(mapDir, 'manifest.json'))) return fail(res, 404, 'map not baked');
  let body;
  try { body = await readBody(req); } catch { return fail(res, 413, 'too large'); }
  if (!isWebp(body)) return fail(res, 415, 'not a webp');
  const dir = path.join(mapDir, 'stages');
  const file = path.resolve(dir, `${id}.webp`);
  if (path.dirname(file) !== path.resolve(dir)) return fail(res, 400, 'bad path');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, bytes: body.length }));
}

export function stageShotsDevPlugin() {
  return {
    name: 'stage-shots-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(ROUTE, (req, res) => {
        handle(req, res).catch((e) => fail(res, 500, String(e?.message || e)));
      });
    },
  };
}
