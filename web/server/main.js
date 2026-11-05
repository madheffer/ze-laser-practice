// The server on its own, for hosting: `npm run coop-server` (= node server/main.js [options]).
//   --port 5810            or PORT
//   --static <dir>         serve the game's files from here (repeat: the first folder that has a path wins), e.g.
//                          --static dist --static /assets (the baked maps, sounds, weapons, panorama, player)
//   --maps <dir>           the baked maps the anti-cheat reads (default public/maps)
//   --scenarios <dir>      the stage files (default public/scenarios)
//   CLIENT_IP_HEADER       behind a proxy / tunnel: the header it sets to the client's address (cf-connecting-ip,
//                          x-real-ip). Only when that proxy always sets it (coop-relay.js clientAddress)
// It answers the /coop WebSocket and the read-only /api/ (api.js), and with --static the game itself. Without
// --static, serve web/dist from your web server and forward /coop + /api/ here on the same origin (the server
// refuses sockets whose Origin isn't the Host they asked for). Runs are stored in Postgres: DATABASE_URL must be
// set (web/.env or the environment) and reachable, or the server won't start. Steam sign-in: auth/index.js
// (STEAM_API_KEY, STEAM_RETURN_HOST, SESSION_SECRET).
import http from 'node:http';
import { attachCoopRelay, PATH } from './coop-relay.js';
import { apiHandler } from './api.js';
import { staticFiles } from './static.js';
import { openStore } from './db/store.js';
import { serverAuth } from './auth/index.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const args = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const port = Number(arg('--port', process.env.PORT || 5810));
const staticDirs = args('--static');
const opts = {
  ...(arg('--scenarios') ? { scenariosDir: arg('--scenarios') } : {}),
  ...(arg('--maps') ? { mapsDir: arg('--maps') } : {}),
  ipHeader: (process.env.CLIENT_IP_HEADER || '').toLowerCase().trim(),
};
const log = (m) => console.log(m);

let store;
try {
  store = await openStore({ required: true, log });
} catch (e) {
  console.error(`runs: ${e.message}. Set DATABASE_URL (see README "Database").`);
  process.exit(1);
}

const notFound = (req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); };
const files = staticDirs.length ? staticFiles(staticDirs) : (req, res, next) => next();
const auth = serverAuth({ log });
let relay = null;
const api = apiHandler(store, { auth, feed: () => relay?.feed, ipHeader: opts.ipHeader });
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  api(req, res, () => files(req, res, () => notFound(req, res)));
});
relay = attachCoopRelay(server, { log, store, sessions: auth.sessions, ...opts });
server.listen(port, () => console.log(`server on :${port}: ${PATH} + /api/${staticDirs.length ? ` + files from ${staticDirs.join(', ')}` : ''}`));

const stop = () => {
  setTimeout(() => process.exit(0), 3000).unref(); // open sockets would hold close() up
  server.close(() => store.close().finally(() => process.exit(0)));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
