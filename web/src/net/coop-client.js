// The browser side of the co-op relay (server/coop-relay.js): one WebSocket to /coop on this same host, a room
// (code, members, who hosts) and game messages to / from the others. Knows nothing about the game: app/coop.js
// listens to it.
//
//   const net = new CoopClient();
//   net.on('room', (room) => ...)   // joined / members changed / host moved
//   net.on('msg', (from, d) => ...) // a member's game message (untrusted: validate before use)
//   net.on('left' | 'error' | 'status', ...)
//   net.create(name) / net.join(name, code) / net.leave() / net.send(d, to?)
export const ROOM_CODE = /^[A-Z]{4}$/;

export class CoopClient {
  constructor() {
    this.ws = null;
    this.room = null; // { code, host, you, members: [{id, name}] }
    this.you = 0;
    this.status = 'offline'; // offline | connecting | online
    this.handlers = new Map();
    this.pending = null; // what to send once the socket opens
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  emit(type, ...a) { for (const fn of this.handlers.get(type) || []) fn(...a); }

  get inRoom() { return !!this.room; }
  get isHost() { return !!this.room && this.room.host === this.you; }
  member(id) { return this.room?.members.find((m) => m.id === id) || null; }

  setStatus(s, detail = '') { this.status = s; this.emit('status', s, detail); }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/coop`;
    this.setStatus('connecting');
    const ws = this.ws = new WebSocket(url);
    ws.onopen = () => {
      this.setStatus('online');
      for (const m of this.pending || []) this.raw(m);
      this.pending = null;
    };
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const had = !!this.room;
      this.room = null;
      this.setStatus('offline', had ? 'Disconnected from the room' : 'Could not reach the co-op server');
      if (had) this.emit('left', 'disconnected');
    };
  }

  raw(m) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
    else { (this.pending ||= []).push(m); this.connect(); }
  }

  create(name) { this.raw({ t: 'hello', name }); this.raw({ t: 'create' }); }
  join(name, code) { this.raw({ t: 'hello', name }); this.raw({ t: 'join', code: String(code).toUpperCase() }); }
  rename(name) { if (this.ws?.readyState === 1) this.raw({ t: 'hello', name }); }
  leave() {
    if (!this.room) return;
    this.raw({ t: 'leave' });
    this.room = null;
    this.emit('left', 'left');
  }
  // a game message to everyone else in the room (or one member)
  send(d, to) { if (this.room && this.ws?.readyState === 1) this.ws.send(JSON.stringify(to ? { t: 'msg', d, to } : { t: 'msg', d })); }

  onFrame(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'welcome': this.you = m.you | 0; break;
      case 'room': {
        if (!ROOM_CODE.test(m.code) || !Array.isArray(m.members)) return;
        const members = m.members.filter((x) => Number.isInteger(x?.id)).map((x) => ({ id: x.id, name: String(x.name ?? '').slice(0, 20) || 'Player' }));
        const prev = this.room;
        this.you = m.you | 0 || this.you;
        this.room = { code: m.code, host: m.host | 0, you: this.you, members };
        this.emit('room', this.room, prev);
        break;
      }
      case 'left': break; // our own leave, already handled
      case 'error': this.emit('error', String(m.msg ?? 'error').slice(0, 120)); break;
      case 'msg': if (this.room && Number.isInteger(m.from) && m.d && typeof m.d === 'object') this.emit('msg', m.from, m.d); break;
    }
  }
}
