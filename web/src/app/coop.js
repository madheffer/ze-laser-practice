// A multiplayer round on this client. The server runs the round (server/coop-round.js); this side builds the
// same run as everyone else and reports what happens to YOU. How a round stays 1:1 without syncing an entity:
//   - the server's start carries the map, stage, mode, seed and the room's rules (lib/room-rules.js). Every
//     client builds the same run from them, and the map's logic is deterministic for a seed;
//   - a round runs on the wall clock (loop.js simulate), pulled onto the server's round clock;
//   - boss damage goes through the server: your hits (and the team's fire, if you're the round's "leader") go up,
//     everyone's capped hits come back and every client applies the same ones;
//   - you send where you are ~20 times a second, when you die, and when your map says the stage is won / lost.
// The server decides the end, who won and who did best (server/coop-round.js end: one mode, together and against
// each other).
//
// S.mp is the Round while you're in one (session, bosses and loop call its hooks); null solo.
import { S, G, log } from './state.js';
import { CoopClient } from '../net/coop-client.js';
import { cleanRules, cleanText, ROOM_KINDS } from '../lib/room-rules.js';
import { startScenario, stageTime, finish } from './session.js';
import { bossTargets, applyBossDamage } from './bosses.js';
import { showRoundEnd } from './coop-end.js';
import { isMapName } from '../lib/paths.js';
import { TICK } from '../world/run-engine.js';
import { lastFrameAt } from './loop.js';
import { systemLine } from './chat.js';
import { ownerLine } from '../ui/room-chat.js';
import { itemState, spendUse, usableHeals } from '../world/items.js';
import { installCoopDiag } from './coop-diag.js';
import { beginRoster, applyWait, markOut, rosterGo, clearRoster, waitLine, startReports, simulatedPing, lockPing, unlockPing } from './coop-load.js';

export const net = new CoopClient();
const diag = installCoopDiag(net); // what this client saw, for the server's log
export const lobby = { busy: false }; // busy = a round is on that you're not in (you'll be in the next one)

const STATE_MS = 33; // 30 Hz: the others draw you this much less late (world/peers.js)
const RELAY_TICKS = 8; // ticks per relayed state the server sends (server/coop-round.js)
// the server's notes that mean the player is out of the round, not dead (server/coop-round.js onLeave / load timeout)
const LEFT = new Set(['left the game', 'could not load in time']);
const NOTE_COLOR = '#c5cad0'; // chat code 8, grey
const BOSS_MS = 100;
const MAX_HITS = 2000; // per boss message entry
const MAX_SAMPLES = 100; // ticks per state message (the server takes up to 160; frames are capped at 8 KB)

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const vec = (v, lim) => Array.isArray(v) && v.length === 3 && v.every((x) => num(x, -lim, lim));
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

class Round {
  constructor(d) {
    this.r = d.r;
    this.kind = d.kind;
    this.rules = d.rules;
    this.mode = d.mode;
    this.leader = d.leader;
    this.holders = d.holders; // who started with the map's heal (the room's choice)
    // teammates' items, for the item HUD: the same EntWatch bookkeeping as yours, from their presses
    const heals = usableHeals(S.map?.items);
    this.peerItems = new Map(d.holders.filter((id) => id !== net.you).map((id) => [id, heals.map((it) => ({ ...it, uses: 0, readyAt: 0 }))]));
    this.players = new Map(d.roster.map((m) => [m.id, { id: m.id, name: m.name, alive: true, deadAt: null, hits: 0 }]));
    this.me = net.you;
    this.ended = false;
    this.sendAt = 0; this.bossAt = 0;
    this.hitOut = new Map(); this.teamOut = new Map();
    this.ticks = []; this.tick0 = 0; // your positions since the last send: tick tick0, tick0 + 1, ...
    this.specId = null;
    this.lastAliveSaid = false;
    this.readyIds = new Set(); // who has loaded the stage (the server's 'wait'), until its 'go'
  }

  get isHost() { return net.isHost; } // the room owner (Play again on the end card)

  // ---- items (app/items.js, ui/itemhud.js)
  heldItems() { return this.holders.includes(this.me) ? usableHeals(S.map?.items) : []; }
  myName() { return this.name(this.me); }
  itemRows() {
    const now = S.engine?.time ?? 0, rows = [];
    for (const [id, items] of this.peerItems) {
      if (!this.players.get(id)?.alive) continue;
      for (const it of items) rows.push({ state: itemState(it, now), short: it.shortname || it.name, color: it.color, holder: this.name(id) });
    }
    return rows;
  }
  peerUsed(id) { const now = S.engine?.time ?? 0; for (const it of this.peerItems.get(id) || []) spendUse(it, now); }
  get isLeader() { return this.leader === this.me; } // carries the simulated team's fire
  get alive() { return [...this.players.values()].filter((p) => p.alive); }
  name(id) { return this.players.get(id)?.name || net.member(id)?.name || 'Player'; }

  // ---- hooks for session.js / bosses.js / loop.js
  bossHit(e, dmg, team) { add(team ? this.teamOut : this.hitOut, e.id, dmg); }

  died(cause) {
    const p = this.players.get(this.me);
    if (!p || !p.alive || this.ended) return;
    this.sendTicks(); // your last positions first: the server's copy reaches the same death (with its own count)
    net.game({ t: 'dead', r: this.r, by: cause, at: stageTime(), hits: S.run.hits });
    // the server stamps it and tells everyone (us too); until then we're already spectating
  }

  // you used your map item (E) after tick k: the server's copy presses it before tick k + 1, as yours does
  used(k) { if (!this.ended && !S.run?.spectating) { this.sendTicks(); net.game({ t: 'use', r: this.r, k }); } }

  // your gun's reload started: the server's shot check holds your next rounds until it's done
  reloaded() { if (!this.ended && !S.run?.spectating) net.game({ t: 'reload', r: this.r }); }

  // you bought a gun (app/buy.js): the server's shot check holds you to its numbers from now on
  bought(gun) { if (!this.ended && !S.run?.spectating) net.game({ t: 'weapon', r: this.r, gun }); }

  // the stage's clear / fail: the server's own copy of the run decides it, so nothing is sent
  outcome() {}

  // every tick: where you stood (what your map's triggers saw), for the server's copy of your run
  record(k, player) {
    if (this.ended || S.run?.spectating) return;
    if (!this.ticks.length) this.tick0 = k;
    const o = player.origin; // to 1/1000 u: small frames, and far finer than any trigger edge
    this.ticks.push([r3(o[0]), r3(o[1]), r3(o[2]), player.ducked ? 1 : 0]);
  }

  pump(now) {
    const run = S.run;
    if (!run || run.done || this.ended) return;
    if (now - this.sendAt >= STATE_MS && this.ticks.length) { this.sendAt = now; this.sendTicks(); }
    if (now - this.bossAt >= BOSS_MS) {
      this.bossAt = now;
      if (this.hitOut.size) net.game({ t: 'hit', r: this.r, h: drain(this.hitOut) });
      if (this.teamOut.size) net.game({ t: 'hit', r: this.r, team: true, h: drain(this.teamOut) });
    }
  }

  // your recorded ticks to the server, up to MAX_SAMPLES a message (a tab catching up sends several)
  sendTicks() {
    const p = S.player;
    while (this.ticks.length) {
      const part = this.ticks.splice(0, MAX_SAMPLES);
      net.game({ t: 's', r: this.r, k: this.tick0, p: part, yaw: r1(p.yaw), pitch: r1(p.pitch) });
      this.tick0 += part.length;
    }
  }

  spectateView() {
    if (this.specId == null || !this.players.get(this.specId)?.alive) this.specId = this.alive.find((p) => p.id !== this.me)?.id ?? null;
    return this.specId == null ? null : G.peers.eye(this.specId);
  }
  spectateNext() {
    const ids = this.alive.filter((p) => p.id !== this.me).map((p) => p.id);
    if (ids.length) this.specId = ids[(ids.indexOf(this.specId) + 1) % ids.length];
    G.audio?.deathFade?.('clear'); // spectating: CS2's death-cam mix is over (audio/layers.js)
  }
  // the spectator bar (ui/hud.js): who you watch, and that Mouse 1 changes it when there's anyone else to watch
  spectateLabel() {
    const v = this.spectateView();
    if (!v) return 'You died';
    return `Spectating ${this.name(v.id)}${this.alive.filter((p) => p.id !== this.me).length > 1 ? ' · Mouse 1: next' : ''}`;
  }
  // someone alive to watch: your death goes straight to their eyes (no death cam)
  get watchable() { return this.alive.some((p) => p.id !== this.me); }
  // what the camera has of a player (app/coop-diag.js): how many positions, the newest one's run time
  peerSamples(id) { const p = G.peers.list.get(id); const q = p?.track?.samples || p?.samples || []; return { n: q.length, last: q[q.length - 1]?.t ?? 0 }; }

  // ---- loading: the stage is loaded and drawn here (app/readiness.js); the server starts the clock when all are
  sendReady() { if (!this.ended) { this.readyIds.add(this.me); net.game({ t: 'ready', r: this.r, ping: simulatedPing() }); } }
  waitLine() { return waitLine(); } // app/coop-load.js: the ready ones among those still in

  hudLine() {
    const n = this.players.size, a = this.alive.length;
    const cheats = [this.rules.god && 'god mode', this.rules.hitboxes && 'hitboxes', this.rules.autoBhop && 'auto bhop'].filter(Boolean);
    return `Online${n > 1 ? ` · ${a}/${n} alive` : ''}${cheats.length ? ` · ${cheats.join(', ')}` : ''}`;
  }

  // the server says someone died (you too)
  markDead(id, cause, t, note) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.ended) return;
    p.alive = false; p.deadAt = t;
    G.peers.setAlive(id, false);
    const self = id === this.me;
    if (self && S.run && !S.run.spectating) { S.run.spectating = true; S.run.deadAt = t; }
    if (self) diag.died(this); // what the death camera has, for the server's log
    // your own death in one line: what got you, and that you watch the others until the round is over (its end card)
    if (self && !note) {
      const v = this.spectateView();
      systemLine([[` You died (${cause})${v ? `: spectating ${this.name(v.id)} until the round ends` : ''}`, NOTE_COLOR]]);
    }
    // CS2's feed names no cause: every death here is the map's (a trigger_hurt / the world: attacker -1), so it reads
    // "<name> [skull] <name>" (ui/killfeed.js). Leaving or not loading is a disconnect; the server's why goes to chat.
    if (note) systemLine([[` ${p.name} ${note}`, NOTE_COLOR]]);
    G.killfeed.push({ victim: p.name, victimTeam: 'ct', disconnect: LEFT.has(note), self });
    const alive = this.alive;
    if (!this.lastAliveSaid && this.players.size > 1 && alive.length === 1) {
      this.lastAliveSaid = true;
      const last = alive[0];
      // the round plays on: the last one standing wins by clearing the stage (server/coop-round.js)
      systemLine([[last.id === this.me ? ' You are the last one alive: clear the stage to win' : ` ${last.name} is the last one alive`, NOTE_COLOR]]);
    }
  }

  applyEnd(d) {
    if (this.ended) return;
    this.ended = true;
    unlockPing();
    for (const s of d.stats) {
      const p = this.players.get(s.id);
      if (p) { p.alive = s.alive; p.deadAt = s.at; p.hits = s.hits; }
    }
    if (S.run) S.run.done = true;
    G.pause();
    document.exitPointerLock?.();
    this.endData = d; this.cardHost = net.isHost; // the card is drawn again if the room changes hands (onRoom)
    showRoundEnd(this, d);
  }
}

function add(map, id, dmg) { const k = `${id}:${dmg}`; map.set(k, (map.get(k) || 0) + 1); }
function drain(map) {
  const out = [...map].map(([k, n]) => { const [id, dmg] = k.split(':').map(Number); return [id, dmg, n]; });
  map.clear();
  return out;
}

// the server's boss hits: [entity id, damage, count], each one a live boss of this stage
function applyHits(list) {
  if (!Array.isArray(list) || !S.engine) return;
  const targets = new Map(bossTargets().map(({ e }) => [e.id, e]));
  for (const h of list.slice(0, 64)) {
    if (!Array.isArray(h) || !Number.isInteger(h[0]) || !num(h[1], 0, 1000) || !Number.isInteger(h[2]) || h[2] < 1) continue;
    const e = targets.get(h[0]);
    if (!e) continue;
    // h[3] = 1: the simulated team's bullets (their activator is the team, not you)
    for (let k = 0; k < Math.min(h[2], MAX_HITS) && e.alive; k++) applyBossDamage(e, h[1], h[3] === 1);
  }
}

// ---- starting a round: the owner asks, the server starts it for everyone (the owner included)
export function hostStart(i, mode) {
  if (!S.map || !net.isHost) return;
  net.start(S.map.name, i >= 0 ? S.scenarios[i].id : null, mode);
}

async function onStart(d) {
  const roster = Array.isArray(d.roster) ? d.roster.filter((m) => Number.isInteger(m?.id)).slice(0, 8).map((m) => ({ id: m.id, name: cleanText(m.name, 24) || 'Player' })) : [];
  if (!Number.isInteger(d.r) || !Number.isInteger(d.seed) || d.seed < 1 || !isMapName(d.map) || !['normal', 'endless'].includes(d.mode)) return;
  if (!roster.some((m) => m.id === net.you)) { lobby.busy = true; G.lobby.render(); return; }
  const start = {
    r: d.r, map: d.map, stage: d.stage == null ? null : cleanText(d.stage, 80), mode: d.mode, kind: ROOM_KINDS[0], // one mode
    rules: { ...cleanRules(d.rules), seed: d.seed }, roster, leader: Number.isInteger(d.leader) ? d.leader : 0,
    holders: Array.isArray(d.holders) ? d.holders.filter((id) => roster.some((m) => m.id === id)) : [],
  };
  // the round's messages that arrive while we load (its 'wait', or the 'go' and our 'dead' if we load too slowly)
  // are kept and played once the round exists here
  const pend = { r: start.r, queue: [] };
  starting = pend;
  // everyone's load progress on the loading screen (app/coop-load.js), and ours to the server while we load
  beginRoster(start, net.you);
  lockPing(); // your simulated ping, fixed until the round ends
  startReports(start.r, (m) => net.game(m));
  const stop = (note) => { if (starting === pend) { starting = null; G.loading.close(false); unlockPing(); } if (note) G.lobby.note(note); };
  // the loading screen (ui/loading.js) until the server's go
  G.loading.begin(start.map, start.stage, S.map?.name === start.map && S.map.loaded ? 300 : 0);
  if (S.map?.name !== start.map) {
    try { await G.selectMap(start.map); } catch (e) { stop(`Could not load ${start.map}: ${e.message || e}`); return; }
  }
  G.loading.begin(start.map, start.stage); // its stage's name, now that the map's stage list is in
  // the map's world, collision and entities (main.js loadStage, once per map); the server's clock waits for us
  try { await G.loadStage(); } catch (e) { stop(`Could not load ${start.map}: ${e.message || e}`); return; }
  if (starting !== pend || !S.map?.loaded || S.map.name !== start.map) { stop(); return; }
  const i = start.stage == null ? -1 : S.scenarios.findIndex((s) => s.id === start.stage);
  if (start.stage != null && i < 0) { stop(`This copy has no stage "${start.stage}"`); return; }
  starting = null;
  G.overlay.hide();
  G.killfeed.clear();
  lobby.busy = false;
  S.mp = new Round(start);
  G.peers.set(roster.filter((m) => m.id !== net.you));
  startScenario(i, start.mode);
  for (const { d: m, at } of pend.queue) onGame(m, at);
  // already in the game (the owner's click, or still locked in from the last round): play at once; otherwise
  // the menu shows Resume until you click in
  if (S.locked) G.unpause(); else G.menu.update();
  G.lobby.render();
}

let starting = null; // { r, queue: [{ d, at }] }: the round being loaded (onStart)
const MAX_PENDING = 64;

// at: when the message arrived (a 'go' kept while loading starts the clock from then, as the others' did)
function onGame(d, at = performance.now()) {
  const mp = S.mp, run = S.run;
  if (d.t === 'start') { onStart(d); return; }
  // the loading roster follows its round from the start, loaded here or not
  if (d.t === 'wait') applyWait(d);
  else if (d.t === 'go') rosterGo(d.r);
  else if (d.t === 'dead' && Number.isInteger(d.id)) markOut(d.r, d.id);
  if (starting && d.r === starting.r) {
    // positions and clocks are stale by the time we start; the rest is kept
    if (d.t !== 's' && d.t !== 'clock' && starting.queue.length < MAX_PENDING) starting.queue.push({ d, at });
    return;
  }
  if (!mp || d.r !== mp.r) return;
  switch (d.t) {
    case 's':
      if (!run || !Number.isInteger(d.from) || !num(d.at, 0, 1e6) || !vec(d.o, 1e6) || !num(d.yaw, -1e4, 1e4) || !num(d.pitch, -90, 90) || !num(d.duck, 0, 1)) return;
      {
        // every tick of the batch (tr); an older server sends only the newest (o)
        const tr = Array.isArray(d.tr) ? d.tr.slice(-RELAY_TICKS).filter((s) => Array.isArray(s) && s.length === 4 && vec(s.slice(0, 3), 1e6) && num(s[3], 0, 1)) : [];
        const positions = tr.length ? tr : [[...d.o, d.duck]];
        // when it arrived on the round clock, to the millisecond (run.t moves a tick at a time): how late it is
        const arrived = run.go ? Math.max(run.t, (at - run.wall0) / 1000) : run.t;
        G.peers.pushBatch(d.from, { at: d.at, positions, yaw: d.yaw, pitch: d.pitch, hp: num(d.hp, 0, 1e6) ? d.hp : 0, tick: TICK }, arrived);
      }
      break;
    case 'clock':
      // keep our run on the round's clock: half the gap each time, so one late frame can't jerk the world around.
      // Compare with where our clock SAYS the run should be, not run.t: in a throttled tab run.t lags until the
      // next catch-up, and pulling the clock forward by that lag would run us ahead of the server
      if (run && !run.done && num(d.at, 0, 1e6)) {
        const drift = d.at - (performance.now() - run.wall0) / 1000;
        if (Math.abs(drift) > 0.04) run.wall0 -= drift * 500;
      }
      break;
    case 'wait': if (Array.isArray(d.ready)) mp.readyIds = new Set(d.ready.filter(Number.isInteger).slice(0, 8)); break;
    case 'go':
      // everyone has loaded: the round's clock starts now, for every client together
      if (run && !run.done && !run.go) { run.go = true; run.wall0 = at; }
      break;
    case 'dead': if (Number.isInteger(d.id)) mp.markDead(d.id, cleanText(d.by, 40) || 'the map', num(d.at, 0, 1e6) ? d.at : stageTime(), cleanText(d.note, 30)); break;
    case 'bd': if (!mp.ended) applyHits(d.h); break;
    case 'leader': if (Number.isInteger(d.id)) mp.leader = d.id; break;
    case 'use': if (Number.isInteger(d.id) && !mp.ended) mp.peerUsed(d.id); break;
    case 'end': if (Array.isArray(d.stats) && Array.isArray(d.winners)) mp.applyEnd(cleanEnd(d)); break;
  }
}

function cleanEnd(d) {
  return {
    r: d.r, result: ['win', 'lose', 'draw', 'over'].includes(d.result) ? d.result : 'lose', reason: cleanText(d.reason, 10),
    at: num(d.at, 0, 1e6) ? d.at : 0, winners: d.winners.filter(Number.isInteger).slice(0, 8),
    best: Array.isArray(d.best) ? d.best.filter(Number.isInteger).slice(0, 8) : [],
    stats: d.stats.slice(0, 8).filter((s) => Number.isInteger(s?.id)).map((s) => ({ id: s.id, alive: !!s.alive, at: num(s.at, 0, 1e6) ? s.at : null, hits: num(s.hits, 0, 1e6) ? s.hits : 0 })),
  };
}

function onRoom(room, prev) {
  lobby.busy = !!room.round && !room.round.ids.includes(net.you);
  // the owner left and the room is someone else's now: say so in the game's chat (the room screen's has it too)
  if (prev?.code === room.code && prev.owner !== room.owner) systemLine([[` ${ownerLine(room, net.you)}`, NOTE_COLOR]]);
  // the end card still up was drawn for the old owner: the new one gets Play again, the rest stop waiting on someone gone
  const mp = S.mp;
  if (mp?.ended && mp.endData && G.overlay.open && mp.cardHost !== net.isHost) { mp.cardHost = net.isHost; showRoundEnd(mp, mp.endData); }
  G.lobby.render();
}

// Leaving the room (or being removed): a live run carries on solo (dead = that's your run over).
function onLeft(why) {
  const run = S.run;
  S.mp = null;
  // a round still loading here is dropped: onStart stops once its load is in (starting !== its pend)
  if (starting) { starting = null; G.loading.close(false); }
  clearRoster();
  unlockPing();
  lobby.busy = false;
  G.peers.clear();
  if (run && !run.done && run.spectating) { run.spectating = false; finish('dead'); }
  if (S.paused) G.audio.pause(); // the round's sound played on behind the menu (main.js G.pause); solo pauses
  G.lobby.render();
  if (why === 'kicked') G.lobby.note('The room owner removed you from the room');
  else if (why === 'disconnected') G.lobby.note('Lost the connection to the co-op server');
}

// The owner walked away from a live round (changed map): the server ends it for everyone.
// report: the pause screen's End round (its state goes to the server's log, sent or not)
export function abortRound(report = false) {
  const send = !!S.mp && !S.mp.ended && net.isHost;
  if (report) diag.endRound(send);
  if (send) net.abort(S.mp.r);
}

export function installCoop() {
  net.on('game', onGame);
  net.on('room', onRoom);
  net.on('left', onLeft);
  net.on('error', (m) => G.lobby.note(m));
  net.on('status', () => G.lobby.render());
  // dead: Mouse 1 watches the next teammate (CS2's spectator)
  document.addEventListener('mousedown', (ev) => { if (ev.button === 0 && S.locked && S.run?.spectating) S.mp?.spectateNext(); });
  // a hidden (or throttled) tab gets few or no animation frames: keep the round's clock and messages going anyway
  setInterval(() => {
    const now = performance.now();
    if (S.mp && now - lastFrameAt > 150) { G.simulate(now); S.mp?.pump(now); }
  }, 100);
  log('co-op: ready');
}
