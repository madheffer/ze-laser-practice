// The co-op server on its own, for hosting: `node server/main.js [--port 5810] [--scenarios <dir>]`.
// It answers only the /coop WebSocket; the static game is served by the host (Caddy / the Helm bundle), which
// proxies /coop here on the same origin (the server refuses sockets whose Origin isn't the Host they asked for).
import http from 'node:http';
import { attachCoopRelay, PATH } from './coop-relay.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(arg('--port', process.env.PORT || 5810));
const scenariosDir = arg('--scenarios', undefined);

const server = http.createServer((req, res) => {
  res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'text/plain' });
  res.end(req.url === '/healthz' ? 'ok' : 'not found');
});
attachCoopRelay(server, { log: (m) => console.log(m), ...(scenariosDir ? { scenariosDir } : {}) });
server.listen(port, () => console.log(`co-op server on :${port}${PATH}`));
