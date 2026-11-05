// The browser side of the co-op server (server/coop-relay.js): one WebSocket to /coop on this same host, the
// room you're in and the public room list. Knows nothing about the game: app/coop.js and ui/lobby.js listen.
//
//   net.on('room', (room, prev) => ...)  // joined / members / settings / owner changed
//   net.on('list', (rooms) => ...)       // the public rooms
//   net.on('game', (msg) => ...)         // a round message from the server (untrusted: validate before use)
//   net.on('left', why) / net.on('error', msg) / net.on('status', status)
import { cleanSettings, cleanText } from '../lib/room-rules.js';
import { isMapName } from '../lib/paths.js';

export const ROOM_CODE = /^[A-Z]{4}$/;
const GAME = new Set(['start', 's', 'dead', 'bd', 'clock', 'leader', 'end', 'use', 'wait', 'go']);

export class CoopClient {
  constructor() {
    this.ws = null;
    this.room = null; // { code, owner, you, members: [{id, name}], settings, map, round }
    this.you = 0;
    this.status = 'offline'; // offline | connecting | online
    this.handlers = new Map();
    this.pending = null;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  emit(type, ...a) { for (const fn of this.handlers.get(type) || []) fn(...a); }

  get inRoom() { return !!this.room; }
  // the room owner: changes settings, picks the stage, kicks (the server checks)
  get isHost() { return !!this.room && this.room.owner === this.you; }
  member(id) { return this.room?.members.find((m) => m.id === id) || null; }

  setStatus(s, detail = '') { this.status = s; this.emit('status', s, detail); }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    this.setStatus('connecting');
    const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/coop`);
    ws.onopen = () => {
      this.setStatus('online');
      for (const m of this.pending || []) ws.send(JSON.stringify(m));
      this.pending = null;
    };
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.pending = null;
      const had = !!this.room;
      this.room = null;
      this.setStatus('offline', had ? 'Disconnected from the room' : 'Could not reach the co-op server');
      if (had) this.emit('left', 'disconnected');
      else this.emit('error', 'Could not reach the co-op server');
    };
  }

  send(m) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
    else { (this.pending ||= []).push(m); this.connect(); }
  }

  create(name, settings, map) { this.send({ t: 'hello', name }); this.send({ t: 'create', settings, map }); }
  join(name, code) { this.send({ t: 'hello', name }); this.send({ t: 'join', code: String(code).toUpperCase() }); }
  rename(name) { if (this.ws?.readyState === 1) this.send({ t: 'hello', name }); }
  list() { this.send({ t: 'list' }); }
  // the home page's live feed (server/activity.js): 'feed' (the recent rows + numbers), then 'act' / 'stats' pushes
  watchFeed(on = true) { if (on || this.ws?.readyState === 1) this.send({ t: 'feed', on }); }
  setSettings(settings) { if (this.isHost) this.send({ t: 'settings', settings }); }
  setMap(map) { if (this.isHost && isMapName(map)) this.send({ t: 'map', map }); }
  kick(id) { if (this.isHost) this.send({ t: 'kick', id }); }
  start(map, stage, mode) { if (this.isHost) this.send({ t: 'start', map, stage, mode }); }
  // the next round's stage, chosen on the room screen (everyone in the room sees it)
  pick(map, stage, mode) { if (this.isHost && isMapName(map)) this.send({ t: 'pick', map, stage, mode }); }
  abort() { if (this.isHost) this.send({ t: 'abort' }); }
  leave() {
    if (!this.room) return;
    this.send({ t: 'leave' });
    this.room = null;
    this.emit('left', 'left');
  }
  // round traffic (only while connected: nothing is queued for a round)
  game(m) { if (this.room && this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }

  onFrame(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'welcome': this.you = m.you | 0; break;
      case 'room': {
        if (!ROOM_CODE.test(m.code) || !Array.isArray(m.members)) return;
        const members = m.members.filter((x) => Number.isInteger(x?.id)).slice(0, 8).map((x) => ({ id: x.id, name: cleanText(x.name, 24) || 'Player' }));
        const round = m.round && Number.isInteger(m.round.r)
          ? { r: m.round.r, stage: cleanText(m.round.stage, 60), ids: Array.isArray(m.round.ids) ? m.round.ids.filter(Number.isInteger) : [] } : null;
        const prev = this.room;
        this.you = (m.you | 0) || this.you;
        // next: the owner's pick for the next round (the room screen): { map, stage, stageName, mode, endless } or null
        const n = m.next && typeof m.next === 'object' && isMapName(m.next.map) ? m.next : null;
        const next = n ? { map: n.map, stage: typeof n.stage === 'string' ? cleanText(n.stage, 80) : null, stageName: cleanText(n.stageName, 60) || 'Free roam', mode: n.mode === 'endless' ? 'endless' : 'normal', endless: n.endless === true } : null;
        this.room = { code: m.code, owner: m.owner | 0, you: this.you, members, settings: cleanSettings(m.settings, members.length), map: isMapName(m.map) ? m.map : '', next, round };
        this.emit('room', this.room, prev);
        break;
      }
      case 'list': this.emit('list', Array.isArray(m.rooms) ? m.rooms.slice(0, 100).map(cleanListing).filter(Boolean) : []); break;
      case 'kicked': this.room = null; this.emit('left', 'kicked'); break;
      case 'left': break; // our own leave, already handled
      case 'feed': case 'act': case 'stats': this.emit(m.t, m); break; // untrusted: ui/home-feed.js cleans it
      case 'error': this.emit('error', cleanText(m.msg, 120) || 'error'); break;
      default: if (this.room && GAME.has(m.t)) this.emit('game', m);
    }
  }
}

function cleanListing(x) {
  if (!x || !ROOM_CODE.test(x.code)) return null;
  return {
    code: x.code, name: cleanText(x.name, 40) || 'Room', kind: x.kind === 'versus' ? 'versus' : 'coop',
    players: Math.max(0, x.players | 0), max: Math.max(2, x.max | 0), map: isMapName(x.map) ? x.map : '',
    playing: !!x.playing, stage: cleanText(x.stage, 60), cheats: Array.isArray(x.cheats) ? x.cheats.filter((c) => typeof c === 'string').slice(0, 5) : [],
  };
}
