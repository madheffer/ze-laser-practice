// The home page's live feed: the last runs anyone finished on this server, pushed to every page that watches it,
// plus a few numbers (players online, open rooms, rounds being played).
//
//   co-op / versus rounds   from the server's own round result (coop-round.js): checked, the server's call
//   solo runs               reported by the player's page ({t:'solo'}): unchecked, so they are rate-limited, the
//                           map + stage must exist on this server, and the feed marks them as solo
//
// Privacy: a private room's players are never named (the row says "a private room"); a solo run shows the name
// the player typed, and players can turn reporting off on the home page. Nothing about an address is kept.
import { cleanName, cleanText } from '../src/lib/room-rules.js';
import { isMapName } from '../src/lib/paths.js';

const KEEP = 40; // rows kept and sent to a page that starts watching
const SOLO_MS = 4000; // one solo report per connection per this long
const STATS_MS = 3000; // numbers pushed at most this often, only when they changed
const SOLO_RESULTS = new Set(['win', 'dead', 'lose']);

const round1 = (v) => Math.round(v * 10) / 10;

// send(client, msg); findStage(map, id) -> scenarios.js's stage or null; stats() -> { online, rooms, rounds, playing }
export function activityFeed({ send, findStage, stats }) {
  const items = [];
  const watchers = new Set();
  let nextId = 1;
  let lastStats = '';
  let statsAt = 0;

  function push(item) {
    item.id = nextId++;
    item.at = Date.now();
    items.unshift(item);
    if (items.length > KEEP) items.length = KEEP;
    for (const c of watchers) send(c, { t: 'act', item });
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
      push({
        kind: 'solo', map: m.map, stage: stage.name, mode: endless ? 'endless' : 'normal',
        result: endless ? 'over' : m.result === 'win' ? 'win' : 'lose', time: round1(time),
        hits: Number.isInteger(m.hits) && m.hits >= 0 ? Math.min(m.hits, 9999) : null,
        names: [cleanName(m.name)], cause: cleanText(m.cause, 40),
      });
    },

    // a round the server ran, once it has ended
    round(room, round) {
      const res = round.result;
      if (!res) return;
      const players = [...round.players.values()];
      const named = !!room.settings.public;
      const winners = new Set(res.winners);
      push({
        kind: round.kind === 'versus' && players.length >= 2 ? 'versus' : 'coop',
        map: round.map, stage: round.stage.name, mode: round.mode, result: res.result, time: round1(res.at),
        players: players.length, room: named ? (room.settings.name || '') : '',
        names: named ? players.map((p) => p.name).slice(0, 8) : [],
        winners: named ? players.filter((p) => winners.has(p.id)).map((p) => p.name).slice(0, 8) : [],
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
