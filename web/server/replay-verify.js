// The server's check of a solo run's replay: the same anti-cheat copy of a run that checks every co-op round
// (coop-check.js PlayerCheck), fed the replay's per-tick positions and E presses, on the map's own logic from the
// replay's seed and rules. What it can prove depends on the stage:
//   - no boss on the stage: the server's copy is the client's simulation, tick for tick (team fire and your shots
//     only ever hit bosses). A run is VERIFIED when the copy reaches the same end (win / lose / death) at the same
//     time with the same hits (an endless run ended from the pause screen: alive at the replay's end, at its
//     time); it is REMOVED from the rankings on evidence: a movement cheat (noclip, speed, fly, spawn, teleport), a death the copy saw well before the end the page reported, or more hits than reported.
//   - a boss on the stage: the boss's health depends on the team's fire, which the server does not simulate
//     (ROADMAP "Team fire on the server"), so the copy can drift from the real run: it stays unverified, never removed.
// Anything the copy can't judge (a fall death: the copy has no fall damage) stays unverified too. Verdicts go to the
// run store (setVerdict). Jobs run one at a time, in slices, so a long replay never blocks the server.
import { PlayerCheck } from './coop-check.js';
import { legacyCountdown } from '../src/world/run-engine.js';
import { soloLoadout } from '../src/world/items.js';
import { POS_SCALE } from '../src/lib/replay-codec.js';

const MAX_QUEUE = 40; // replays waiting; more are left unverified
const SLICE = 512; // ticks per slice
const TIME_SLACK = 0.1; // s: the copy's end vs the page's time
const DEATH_SLACK = 0.25; // s: a copy death this far before the reported end is evidence

// { loadMap (map-store.js), findStage (scenarios.js), store (db/store.js, or a promise), log }
export function replayVerifier({ loadMap, findStage, store, log = () => {} }) {
  const queue = [];
  let busy = false;
  const ready = Promise.resolve(store);

  async function next() {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    try {
      const verdict = await check(job);
      if (verdict.removed || verdict.verified) await (await ready).setVerdict(job.id, verdict);
      if (verdict.removed) log(`replay check: run ${job.id} removed (${verdict.removed})`);
    } catch (e) {
      log(`replay check: run ${job.id} not checked: ${e.message}`);
    } finally {
      busy = false;
      setImmediate(next);
    }
  }

  // run: { map, stageId, mode, result: 'win' | 'lose' | 'over', quit (ended from the pause screen), time, hits, cause }; meta: cleanMeta's; data: decodeReplay's
  async function check({ run, meta, data }) {
    const stage = await findStage(run.map, run.stageId);
    if (!stage?.full) return { reason: 'no stage' };
    if (Array.isArray(stage.full.bosses) && stage.full.bosses.length) return { reason: 'boss stage' };
    const assets = await loadMap(run.map);
    let cheat = '', death = null, outcome = null;
    const pc = new PlayerCheck({
      assets, scenario: stage.full, mode: run.mode, seed: meta.seed,
      rules: { ...meta.rules, god: false },
      ...soloLoadout(meta.rules, assets.items), // { items, mates }: what the run held, as the page worked it out
      countdown: meta.countdown ?? legacyCountdown(stage.full),
      onDeath: (cause, t) => { if (!death) death = { cause, t }; },
      onOutcome: (r) => { if (!outcome) outcome = { r, t: pc.stageTime }; },
      onCheat: (kind) => { if (!cheat) cheat = kind; },
    });
    // E presses after tick k: the copy takes them when it has reached tick k
    const uses = data.events.filter((e) => e.type === 'use').map((e) => e.tick);
    const ducked = (i) => ((data.flags[i] & 32) ? 1 : 0);
    let k = 1;
    while (k <= data.n && pc.alive && !cheat && !outcome) {
      const end = Math.min(data.n, k + SLICE - 1);
      for (; k <= end && pc.alive && !cheat && !outcome; k++) {
        while (uses.length && uses[0] < k) { pc.use(uses.shift()); }
        const i = k - 1;
        pc.feed(k, [[data.x[i] / POS_SCALE, data.y[i] / POS_SCALE, data.z[i] / POS_SCALE, ducked(i)]], k + 1);
      }
      await new Promise((r) => setImmediate(r));
    }
    pc.dispose(); // its physics world (world/physics-world.js)
    if (cheat) return { removed: `replay: ${cheat}` };
    const reportedDead = run.result !== 'win';
    if (pc.hits > (run.hits ?? Infinity)) return { removed: 'replay: more hits than reported' };
    if (death) {
      // the copy died: fine if the page says so too, at that time; well before the reported end is a lie
      if (death.t < run.time - DEATH_SLACK) return { removed: 'replay: died earlier than reported' };
      return reportedDead && Math.abs(death.t - run.time) <= TIME_SLACK && pc.hits === run.hits ? { verified: true } : { reason: 'death mismatch' };
    }
    if (outcome) {
      const same = (outcome.r === 'win') === (run.result === 'win') && Math.abs(outcome.t - run.time) <= TIME_SLACK && pc.hits === run.hits;
      return same ? { verified: true } : { reason: 'outcome mismatch' };
    }
    // ended from the pause screen: the copy lived to the end of the replay, at the page's time; a time past what
    // the replay lived is a lie, like a death well before the reported end
    if (run.quit) {
      if (run.time > pc.stageTime + DEATH_SLACK) return { removed: 'replay: ended earlier than reported' };
      return Math.abs(pc.stageTime - run.time) <= TIME_SLACK && pc.hits === run.hits ? { verified: true } : { reason: 'quit mismatch' };
    }
    return { reason: 'no end in the replay' }; // a fall death, an endless run ended by a fall, ...
  }

  return {
    // a stored solo run with a replay
    queue(id, run, meta, data) {
      if (id == null || queue.length >= MAX_QUEUE) return;
      queue.push({ id, run, meta, data });
      next();
    },
    get pending() { return queue.length + (busy ? 1 : 0); },
    check, // for tests
  };
}
