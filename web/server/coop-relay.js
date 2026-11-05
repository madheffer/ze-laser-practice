// The co-op server: rooms of up to 8 players over one WebSocket each (path /coop). Rooms and rounds live HERE:
// the room owner (whoever made it; the next oldest member if they leave) can change the room's settings, pick
// the stage and kick, and the server checks every one of those; a round (coop-round.js) is run by the server,
// not by a player. Public rooms show up in a list anyone can browse; private ones only by code / invite link.
//
// Rounds are checked: the server runs its own copy of each player's run (coop-check.js), so HP, deaths, shots and
// movement are the server's call, not the client's.
//
// Players only ever talk to the server, never to each other, so no one sees another player's address, and the
// server never sends or logs one. Everything a client sends is untrusted: frames are size- and rate-limited,
// names and settings are cleaned (lib/room-rules.js), and connections per address are capped.
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanName, cleanSettings, cheatsOn, ROOM_MAX } from '../src/lib/room-rules.js';
import { isMapName } from '../src/lib/paths.js';
import { Round } from './coop-round.js';
import { scenarioStore } from './scenarios.js';
import { mapStore } from './map-store.js';
import { activityFeed } from './activity.js';

export const PATH = '/coop';
const MAX_ROOMS = 300;
const MAX_ROUNDS = 24; // rounds running at once: each player in one costs the server a copy of the map's logic
const MAX_FRAME = 8 * 1024; // bytes
const RATE = 80; // messages per second per connection (20 Hz state + events)
const PER_ADDRESS = 6; // open sockets per remote address
const LIST_MS = 1000; // a client may ask for the public list once a second
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O (they read as 1 / 0)
const CODE = /^[A-Z]{4}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));

function newCode(rooms) {
  for (let k = 0; k < 50; k++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

// A page on another site must not open a socket here: when an Origin is sent it has to be this host.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// a name nobody else in the room has: "Bob", "Bob (2)"
function uniqueName(room, name, self) {
  const taken = new Set(room.members.filter((m) => m !== self).map((m) => m.name));
  if (!taken.has(name)) return name;
  for (let i = 2; i < 20; i++) { const n = `${name.slice(0, 16)} (${i})`; if (!taken.has(n)) return n; }
  return name;
}

export function attachCoopRelay(httpServer, { log = () => {}, scenariosDir = path.resolve(HERE, '../public/scenarios'), mapsDir = path.resolve(HERE, '../public/maps') } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const rooms = new Map(); // code -> room
  const perAddress = new Map();
  const findStage = scenarioStore(scenariosDir);
  const loadMap = mapStore(mapsDir);
  let nextId = 1;

  const send = (c, msg) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
  const io = { send, log };
  // the home page's live feed (activity.js): finished rounds and solo runs, and how busy the server is
  const feed = activityFeed({
    send, findStage,
    stats: () => {
      const live = [...rooms.values()].filter((r) => r.round && !r.round.ended);
      return {
        online: wss.clients.size,
        rooms: [...rooms.values()].filter((r) => r.settings.public && r.members.length < r.settings.max).length,
        rounds: live.length, playing: live.reduce((n, r) => n + r.round.players.size, 0),
      };
    },
  });

  const roomView = (room) => ({
    code: room.code, owner: room.owner, settings: room.settings, map: room.map,
    members: room.members.map((m) => ({ id: m.id, name: m.name })),
    round: room.round && !room.round.ended ? { r: room.round.r, stage: room.round.stage.name, ids: [...room.round.players.keys()] } : null,
  });
  const announce = (room) => { const v = roomView(room); for (const m of room.members) send(m, { t: 'room', you: m.id, ...v }); };

  function leave(c, why = 'left') {
    const room = c.room;
    if (!room) return;
    c.room = null;
    room.members = room.members.filter((m) => m !== c);
    room.round?.onLeave(c);
    if (!room.members.length) { rooms.delete(room.code); return; }
    if (room.owner === c.id) room.owner = room.members[0].id; // the next oldest runs the room
    room.round?.updateLeader();
    announce(room);
    if (why === 'kicked') send(c, { t: 'kicked' });
  }

  function publicList() {
    return [...rooms.values()].filter((r) => r.settings.public).map((r) => ({
      code: r.code, name: r.settings.name || `${r.members.find((m) => m.id === r.owner)?.name || 'Someone'}'s room`,
      kind: r.settings.kind, players: r.members.length, max: r.settings.max, map: r.map || '',
      playing: !!(r.round && !r.round.ended), stage: r.round && !r.round.ended ? r.round.stage.name : '',
      cheats: cheatsOn(r.settings.rules),
    })).sort((a, b) => (a.playing - b.playing) || (b.players - a.players)).slice(0, 100);
  }

  async function startRound(c, m) {
    const room = c.room;
    if (!room || room.owner !== c.id) return send(c, { t: 'error', msg: 'Only the room owner picks the stage' });
    if (!isMapName(m.map)) return;
    const stage = await findStage(m.map, m.stage == null ? null : String(m.stage).slice(0, 80));
    if (c.room !== room) return; // left while the file was read
    if (!stage) return send(c, { t: 'error', msg: 'That stage is not on this server' });
    const mode = m.mode === 'endless' && stage.endless ? 'endless' : 'normal';
    const live = [...rooms.values()].filter((r) => r !== room && r.round && !r.round.ended).length;
    if (live >= MAX_ROUNDS) return send(c, { t: 'error', msg: 'The server is busy, try again in a minute' });
    let assets;
    try { assets = await loadMap(m.map); } catch { return send(c, { t: 'error', msg: 'That map is not on this server' }); }
    if (c.room !== room || room.owner !== c.id) return;
    room.round = new Round(room, { map: m.map, stage, mode, kind: room.settings.kind, rules: room.settings.rules, assets }, io);
    room.map = m.map;
    room.round.broadcast(room.round.startMessage());
    announce(room);
  }

  function onMessage(c, raw) {
    const now = Date.now();
    if (now - c.windowAt > 1000) { c.windowAt = now; c.count = 0; }
    if (++c.count > RATE) return; // dropped, not disconnected: a burst after a hidden tab wakes is normal
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    const room = c.room, round = room?.round;
    const owner = !!room && room.owner === c.id;
    switch (m.t) {
      case 'hello':
        c.name = cleanName(m.name);
        if (room) { c.name = uniqueName(room, c.name, c); announce(room); }
        break;
      case 'list':
        if (now - c.listAt < LIST_MS) return;
        c.listAt = now;
        send(c, { t: 'list', rooms: publicList() });
        break;
      case 'create': {
        leave(c);
        if (rooms.size >= MAX_ROOMS) return send(c, { t: 'error', msg: 'The server is full, try again later' });
        const code = newCode(rooms);
        if (!code) return send(c, { t: 'error', msg: 'Could not make a room code' });
        const r = { code, members: [c], owner: c.id, settings: cleanSettings(m.settings), map: isMapName(m.map) ? m.map : '', round: null, banned: new Set() };
        rooms.set(code, r);
        c.room = r;
        announce(r);
        log(`coop: room ${code} (${r.settings.public ? 'public' : 'private'})`);
        break;
      }
      case 'join': {
        const code = String(m.code ?? '').toUpperCase();
        const r = CODE.test(code) ? rooms.get(code) : null;
        if (!r) return send(c, { t: 'error', msg: `No room ${CODE.test(code) ? code : ''}`.trim() });
        if (r === room) return announce(r);
        if (r.banned.has(c.id)) return send(c, { t: 'error', msg: 'You were removed from that room' });
        if (r.members.length >= r.settings.max) return send(c, { t: 'error', msg: `Room ${code} is full` });
        leave(c);
        c.name = uniqueName(r, c.name, c);
        r.members.push(c);
        c.room = r;
        announce(r);
        break;
      }
      case 'leave': leave(c); send(c, { t: 'left' }); break;
      case 'settings':
        if (!owner) return;
        room.settings = cleanSettings(m.settings, room.members.length);
        announce(room); // a round in progress keeps the rules it started with
        break;
      case 'map': if (owner && isMapName(m.map)) { room.map = m.map; announce(room); } break;
      case 'kick': {
        if (!owner || m.id === c.id) return;
        const target = room.members.find((x) => x.id === m.id);
        if (target) { room.banned.add(target.id); leave(target, 'kicked'); }
        break;
      }
      case 'start': if (round && !round.ended && !owner) return; startRound(c, m); break;
      case 'abort': if (owner && round && !round.ended) round.end('lose'); break;
      // a round's traffic, for the round the client is in
      case 's': if (round && m.r === round.r) round.onState(c, m); break;
      case 'dead': if (round && m.r === round.r) round.onDead(c, m); break;
      case 'hit': if (round && m.r === round.r) round.onHit(c, m); break;
      // the home page's live feed: watch it, or report your own solo run to it
      case 'feed': feed.watch(c, m.on !== false); break;
      case 'solo': feed.solo(c, m).catch(() => {}); break;
      case 'reload': if (round && m.r === round.r) round.onReload(c); break;
      case 'use': if (round && m.r === round.r) round.onUse(c, m); break;
    }
  }

  wss.on('connection', (ws, req) => {
    const addr = req.socket.remoteAddress || '';
    const c = { id: nextId++, name: 'Player', ws, room: null, windowAt: Date.now(), count: 0, listAt: 0, addr };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    send(c, { t: 'welcome', you: c.id, max: ROOM_MAX });
    ws.on('message', (raw) => onMessage(c, raw));
    const gone = () => {
      leave(c);
      feed.unwatch(c);
      const n = (perAddress.get(addr) || 1) - 1;
      if (n > 0) perAddress.set(addr, n); else perAddress.delete(addr);
    };
    ws.once('close', gone);
  });

  // rounds: boss damage, clock, vote timeouts; and dead sockets
  const tick = setInterval(() => {
    const now = Date.now();
    for (const r of rooms.values()) {
      r.round?.tick(now);
      if (r.round?.ended && !r.round.fed) { r.round.fed = true; feed.round(r, r.round); }
    }
    feed.tick(now);
  }, 100);
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20000);
  wss.on('close', () => { clearInterval(tick); clearInterval(ping); });

  httpServer.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== PATH) return; // Vite's own HMR socket and anything else
    const addr = req.socket.remoteAddress || '';
    if (!sameOrigin(req) || (perAddress.get(addr) || 0) >= PER_ADDRESS) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    perAddress.set(addr, (perAddress.get(addr) || 0) + 1);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return wss;
}

// Vite plugin: the co-op server on the dev server (npm run dev) and the preview server (npm run play / host).
export function coopRelayPlugin() {
  const attach = (server) => {
    if (server.httpServer) attachCoopRelay(server.httpServer, { log: (m) => server.config.logger.info(m) });
  };
  return { name: 'coop-relay', configureServer: attach, configurePreviewServer: attach };
}
