// The co-op server on its own, for hosting: `npm run coop-server` (= node server/main.js [--port 5810] [--scenarios <dir>]).
// It answers the /coop WebSocket and the read-only /api/ (api.js); the static game is served by your web server /
// reverse proxy, which forwards /coop and /api/ here on the same origin (the server refuses sockets whose Origin
// isn't the Host they asked for). Runs are stored in Postgres: DATABASE_URL must be set (web/.env or the
// environment) and reachable, or the server won't start.
import http from 'node:http';
import { attachCoopRelay, PATH } from './coop-relay.js';
import { apiHandler } from './api.js';
import { openStore } from './db/store.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(arg('--port', process.env.PORT || 5810));
const scenariosDir = arg('--scenarios', undefined);
const log = (m) => console.log(m);

let store;
try {
  store = await openStore({ required: true, log });
} catch (e) {
  console.error(`runs: ${e.message}. Set DATABASE_URL (see README "Database").`);
  process.exit(1);
}

const api = apiHandler(store);
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  api(req, res);
});
attachCoopRelay(server, { log, store, ...(scenariosDir ? { scenariosDir } : {}) });
server.listen(port, () => console.log(`co-op server on :${port}${PATH} (+ /api/)`));

const stop = () => {
  setTimeout(() => process.exit(0), 3000).unref(); // open sockets would hold close() up
  server.close(() => store.close().finally(() => process.exit(0)));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
