// Co-op relay: rooms of up to MAX_MEMBERS players over one WebSocket each (path /coop). The relay knows nothing
// about the game: it hands out room codes, keeps the member list (and who hosts: the oldest member), and forwards
// each member's messages to the others with a server-set `from`, so nobody can speak as someone else.
//
// Every client runs the map itself with the host's seed (the lasers line up without syncing entities); what goes
// through here is small: player states at 20 Hz, deaths, boss damage, start / end of a round (app/coop.js).
//
// Everything a client sends is untrusted: frames are size- and rate-limited, names are cleaned, codes validated,
// and relayed payloads are passed on untouched for the receiving client to validate (net/protocol.js).
import { WebSocketServer } from 'ws';

export const PATH = '/coop';
const MAX_MEMBERS = 8;
const MAX_ROOMS = 200;
const MAX_FRAME = 8 * 1024; // bytes
const RATE = 80; // messages per second per connection (20 Hz state + events), averaged over a second
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O (they read as 1 / 0)
const CODE = /^[A-Z]{4}$/;

export function cleanName(n) {
  // eslint-disable-next-line no-control-regex
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return s || 'Player';
}

function newCode(rooms) {
  for (let k = 0; k < 50; k++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

// A browser page on another site must not be able to open a socket here: when an Origin is sent it has to be
// this host (dev, `npm run play` and a LAN address all send their own host).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function attachCoopRelay(httpServer, { log = () => {} } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const rooms = new Map(); // code -> { code, members: [client] }
  let nextId = 1;

  const send = (c, msg) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
  const roster = (room) => ({
    t: 'room', code: room.code, host: room.members[0]?.id ?? 0,
    members: room.members.map((m) => ({ id: m.id, name: m.name })),
  });
  const announce = (room) => { const r = roster(room); for (const m of room.members) send(m, { ...r, you: m.id }); };

  function leave(c) {
    const room = c.room;
    if (!room) return;
    c.room = null;
    room.members = room.members.filter((m) => m !== c);
    if (!room.members.length) rooms.delete(room.code);
    else announce(room); // the next oldest member hosts
  }

  function onMessage(c, raw) {
    const now = Date.now();
    if (now - c.windowAt > 1000) { c.windowAt = now; c.count = 0; }
    if (++c.count > RATE) return; // dropped, not disconnected: a burst after a hidden tab wakes is normal
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'hello': c.name = cleanName(m.name); if (c.room) announce(c.room); break;
      case 'create': {
        leave(c);
        if (rooms.size >= MAX_ROOMS) return send(c, { t: 'error', msg: 'The server is full, try again later' });
        const code = newCode(rooms);
        if (!code) return send(c, { t: 'error', msg: 'Could not make a room code' });
        const room = { code, members: [c] };
        rooms.set(code, room);
        c.room = room;
        announce(room);
        log(`coop: room ${code} created`);
        break;
      }
      case 'join': {
        const code = String(m.code ?? '').toUpperCase();
        const room = CODE.test(code) ? rooms.get(code) : null;
        if (!room) return send(c, { t: 'error', msg: `No room ${CODE.test(code) ? code : ''}`.trim() });
        if (room === c.room) return announce(room);
        if (room.members.length >= MAX_MEMBERS) return send(c, { t: 'error', msg: `Room ${code} is full` });
        leave(c);
        room.members.push(c);
        c.room = room;
        announce(room);
        break;
      }
      case 'leave': leave(c); send(c, { t: 'left' }); break;
      case 'msg': {
        if (!c.room || !m.d || typeof m.d !== 'object') return;
        const out = JSON.stringify({ t: 'msg', from: c.id, d: m.d });
        const to = Number.isInteger(m.to) ? m.to : null;
        for (const o of c.room.members) if (o !== c && (to == null || o.id === to) && o.ws.readyState === 1) o.ws.send(out);
        break;
      }
    }
  }

  wss.on('connection', (ws) => {
    const c = { id: nextId++, name: 'Player', ws, room: null, windowAt: Date.now(), count: 0 };
    send(c, { t: 'welcome', you: c.id });
    ws.on('message', (raw) => onMessage(c, raw));
    ws.on('close', () => leave(c));
    ws.on('error', () => leave(c));
  });

  // keep idle sockets from being dropped by proxies, and drop dead ones
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20000);
  wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });
  wss.on('close', () => clearInterval(ping));

  httpServer.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== PATH) return; // Vite's own HMR socket and anything else
    if (!sameOrigin(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return wss;
}

// Vite plugin: the relay on the dev server (npm run dev) and the preview server (npm run play).
export function coopRelayPlugin() {
  const attach = (server) => {
    if (server.httpServer) attachCoopRelay(server.httpServer, { log: (m) => server.config.logger.info(m) });
  };
  return { name: 'coop-relay', configureServer: attach, configurePreviewServer: attach };
}
