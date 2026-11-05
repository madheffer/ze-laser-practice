// The home page's live feed: the last runs anyone finished on this server, pushed to every page that watches it,
// plus a few numbers (players online, open rooms, rounds being played). Every finished run is also written to the
// run store (db/store.js: Postgres, or memory), which the leaderboards read and which refills the feed on start.
//
//   co-op / versus rounds   from the server's own round result (coop-round.js): checked, the server's call
//   solo runs               reported by the player's page ({t:'solo'}): unchecked, so they are rate-limited, the
//                           map + stage must exist on this server, and they are stored as verified = false
//
// Privacy: a private room's players are never named or stored (the row says "a private room"); a solo run keeps
// the name the player typed, and players can turn reporting off on the home page. Nothing about an address is kept.
import { cleanName, cleanText, cheatsOn } from '../src/lib/room-rules.js';
import { isMapName } from '../src/lib/paths.js';

const KEEP = 40; // rows kept and sent to a page that starts watching
const SOLO_MS = 4000; // one solo report per connection per this long
const STATS_MS = 3000; // numbers pushed at most this often, only when they changed
const SOLO_RESULTS = new Set(['win', 'dead', 'lose']);

const round1 = (v) => Math.round(v * 10) / 10;

// a stored run (db/store.js shape) as the feed's row
function feedItem(run) {
  const names = run.people.map((p) => p.name);
  if (run.kind === 'solo') {
    return { kind: 'solo', map: run.map, stage: run.stageName, mode: run.mode, result: run.result, time: round1(run.time),
      hits: run.people[0]?.hits ?? null, names, cause: run.cause, at: run.finishedAt };
  }
  return { kind: run.kind, map: run.map, stage: run.stageName, mode: run.mode, result: run.result, time: round1(run.time),
    players: run.players, room: run.roomName, names: names.slice(0, 8),
    winners: run.people.filter((p) => p.won).map((p) => p.name).slice(0, 8), at: run.finishedAt };
}

// send(client, msg); findStage(map, id) -> scenarios.js's stage or null; stats() -> { online, rooms, rounds, playing };
// store: db/store.js's (a promise for one is fine: the feed fills from it once it's open)
export function activityFeed({ send, findStage, stats, store, log = () => {} }) {
  const items = [];
  const watchers = new Set();
  let nextId = 1;
  let lastStats = '';
  let statsAt = 0;
  const ready = Promise.resolve(store);

  // the last runs from before a restart, under any that finished while the store was opening
  ready.then((s) => s.recentRuns(KEEP)).then((runs) => {
    for (const run of runs) { if (items.length >= KEEP) break; items.push({ id: nextId++, ...feedItem(run) }); }
  }).catch((e) => log(`runs: could not read the feed history: ${e.message}`));

  function push(item) {
    item.id = nextId++;
    items.unshift(item);
    if (items.length > KEEP) items.length = KEEP;
    for (const c of watchers) send(c, { t: 'act', item });
  }

  function record(run) {
    push(feedItem(run));
    ready.then((s) => s.addRun(run)).catch((e) => log(`runs: could not store a run: ${e.message}`));
  }

  return {
    watch(c, on) {
      if (!on) { watchers.delete(c); return; }
      watchers.add(c);
      send(c, { t: 'feed', items, stats: stats(), now: Date.now() });
    },
    unwatch(c) { watchers.delete(c); },

    // a page's own solo run: { map, stage, mode, result, time, hits, name, cause }
    async solo(c, m) {
      const now = Date.now();
      if (now - (c.soloAt || 0) < SOLO_MS) return;
      c.soloAt = now;
      if (!isMapName(m.map) || typeof m.stage !== 'string' || !SOLO_RESULTS.has(m.result)) return;
      const time = Number(m.time);
      if (!Number.isFinite(time) || time < 0 || time > 6 * 3600) return;
      const stage = await findStage(m.map, m.stage.slice(0, 80));
      if (!stage?.id) return;
      const endless = m.mode === 'endless' && stage.endless;
      const won = !endless && m.result === 'win';
      record({
        kind: 'solo', verified: false, map: m.map, stageId: stage.id, stageName: stage.name,
        mode: endless ? 'endless' : 'normal', result: endless ? 'over' : won ? 'win' : 'lose', time: round1(time),
        players: 1, named: true, roomName: '', cheats: false, cause: cleanText(m.cause, 40), finishedAt: now,
        people: [{ name: cleanName(m.name), won, hits: Number.isInteger(m.hits) && m.hits >= 0 ? Math.min(m.hits, 9999) : null,
          survived: round1(time), removed: '' }],
      });
    },

    // a round the server ran, once it has ended
    round(room, round) {
      const res = round.result;
      if (!res) return;
      const players = [...round.players.values()];
      const named = !!room.settings.public;
      const winners = new Set(res.winners);
      const stats = new Map(res.stats.map((s) => [s.id, s]));
      record({
        kind: round.kind === 'versus' && players.length >= 2 ? 'versus' : 'coop', verified: true,
        map: round.map, stageId: round.stage.id ?? 'free', stageName: round.stage.name, mode: round.mode,
        result: res.result, time: round1(res.at), players: players.length, named,
        roomName: named ? (room.settings.name || '') : '', cheats: cheatsOn(round.rules).length > 0, cause: '', finishedAt: Date.now(),
        people: named ? players.map((p) => {
          const s = stats.get(p.id);
          return { name: p.name, won: winners.has(p.id), hits: s?.hits ?? null, survived: round1(s?.at ?? res.at), removed: p.cheat || '' };
        }) : [],
      });
    },

    // called from the server's tick: push the numbers when they changed
    tick(now) {
      if (!watchers.size || now - statsAt < STATS_MS) return;
      statsAt = now;
      const s = stats();
      const key = JSON.stringify(s);
      if (key === lastStats) return;
      lastStats = key;
      for (const c of watchers) send(c, { t: 'stats', stats: s });
    },
  };
}
