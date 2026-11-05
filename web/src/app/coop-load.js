// A round's loading roster: who is in it, how far each one's load is and who is ready, from the server's 'wait'
// (server/coop-round.js sendWait), for the loading screen (ui/loading.js) and the HUD's wait line. It starts with the
// round's 'start' (app/coop.js onStart), before this client has even loaded the map, and our own progress goes to
// the server every REPORT_MS while we load (its straggler rule reads it). Everything from the server is checked.
import { G, S } from './state.js';
import { settings } from './settings.js';

const REPORT_MS = 500;
const REPORT_LIMIT_MS = 180_000;
const MAX_PLAYERS = 8;

let roster = null; // { r, me, ids: [id], names: Map, ready: Set, load: Map id -> 0..100, out: Set }
let reportTimer = null;

// start: app/coop.js's checked start message; me: this client's id
export function beginRoster(start, me) {
  roster = {
    r: start.r, me, ids: start.roster.map((m) => m.id), names: new Map(start.roster.map((m) => [m.id, m.name])),
    ready: new Set(), load: new Map(), out: new Set(), go: false,
  };
}

// the round's go (its clock started: the roster's job is done), or leaving the room
export function rosterGo(r) { if (roster && r === roster.r) roster.go = true; }
export function clearRoster() { roster = null; }

// { ready: [id], load: [[id, percent]] }
export function applyWait(d) {
  if (!roster || d.r !== roster.r) return;
  if (Array.isArray(d.ready)) roster.ready = new Set(d.ready.filter((id) => roster.names.has(id)).slice(0, MAX_PLAYERS));
  if (Array.isArray(d.load)) {
    for (const e of d.load.slice(0, MAX_PLAYERS)) {
      if (!Array.isArray(e) || !roster.names.has(e[0]) || !Number.isFinite(e[1])) continue;
      roster.load.set(e[0], Math.max(0, Math.min(100, Math.round(e[1]))));
    }
  }
}

// a player of the round died before it started: left, or left out for loading too slowly
export function markOut(r, id) { if (roster && r === roster.r && roster.names.has(id)) roster.out.add(id); }

// [{ id, name, pct, ready, out, you }] for the round being loaded, or null outside one
export function loadRoster() {
  if (!roster || roster.go) return null;
  return roster.ids.map((id) => {
    const you = id === roster.me;
    const ready = roster.ready.has(id) || (you && !!S.run?.ready && S.mp?.r === roster.r);
    const pct = ready ? 100 : you ? Math.round((G.loading?.frac || 0) * 100) : roster.load.get(id) || 0;
    return { id, name: roster.names.get(id), pct, ready, out: roster.out.has(id), you };
  });
}

// "waiting for players 1/2": the ready ones among those still in
export function waitLine() {
  if (!roster) return 'waiting for players';
  const inIds = roster.ids.filter((id) => !roster.out.has(id));
  const ready = inIds.filter((id) => roster.ready.has(id) || id === roster.me).length;
  return `waiting for players ${ready}/${inIds.length}`;
}

// our progress (the loading screen's bar) to the server while we load: only when it moved, until we are ready
export function startReports(r, send) {
  clearInterval(reportTimer);
  let last = -1;
  const until = Date.now() + REPORT_LIMIT_MS;
  reportTimer = setInterval(() => {
    const done = roster?.r !== r || (S.mp?.r === r && (S.run?.ready || S.run?.go || S.mp.ended)) || Date.now() > until;
    if (done) { clearInterval(reportTimer); reportTimer = null; return; }
    const p = Math.round((G.loading?.frac || 0) * 100) / 100;
    if (p > last) { last = p; send({ t: 'load', r, p, ping: simulatedPing() }); }
  }, REPORT_MS);
}

// this player's simulated ping (ms): with 'load' and 'ready', so the server's checks of our run allow for it
// (server/coop-check.js MAX_PING); it is ours alone and changes nobody else's round. A round locks it from its start
// to its end (the server only takes it while the round loads): the lasers are drawn and heard that late all round,
// and the ping controls are disabled (ui/room.js lockPing). Solo it is the setting, whenever it changes.
let lockedPing = null;
const settingPing = () => Math.max(0, Math.min(500, Math.round(Number(settings.ping) || 0)));
export const simulatedPing = () => lockedPing ?? settingPing();
export function lockPing() { lockedPing = settingPing(); G.room?.lockPing(true); G.applySettings?.(); }
export function unlockPing() {
  if (lockedPing == null) return;
  lockedPing = null;
  G.room?.lockPing(false);
  G.applySettings?.(); // a ping changed some other way meanwhile applies now
}
