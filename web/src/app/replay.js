// Watching a replay: one from the server (/api/replays/<id>: the live feed, your run history, a shared link
// ?replay=<id>) or your own last run (kept in memory, works offline). The stage is rebuilt from the replay's seed
// and rules (session.js), the recorded player is put back on every tick (app/replay-play.js), and you watch through
// their eyes, from behind them, or from a free camera (app/replay-view.js).
//
// Controls (ui/replay-bar.js, and keys): Space pause, Left / Right 5 s back / on, [ / ] speed, V or 1 / 2 / 3
// camera, R from the start, Esc the mouse back / leave.
import { S, G, log } from './state.js';
import { startScenario, endRun } from './session.js';
import { step, updateHud } from './loop.js';
import { decodeReplay } from '../lib/replay-codec.js';
import { gunzip } from '../lib/bytes.js';
import { fetchJson } from '../lib/fetch.js';
import { indexEvents } from './replay-play.js';
import { lastRun } from './replay-record.js';
import { CAMS, setCam } from './replay-view.js';
import { CS } from '../world/movement.js';
import { formatTime } from '../lib/format.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const FF_CHUNK = 256; // ticks per slice of a seek (the page stays responsive)
const REPLAY_ID = /^[0-9]{1,15}$/;

export const isReplayId = (id) => REPLAY_ID.test(String(id ?? ''));

// a replay from the server: { run: { name, stageName, time, result, hits, at }, meta, data: base64 gzip }
export async function watchReplay(id) {
  if (!isReplayId(id)) throw new Error('not a replay');
  const r = await fetchJson(`/api/replays/${id}`);
  const zipped = Uint8Array.from(atob(String(r.data || '')), (c) => c.charCodeAt(0));
  const bytes = await gunzip(zipped);
  const run = r.run && typeof r.run === 'object' ? r.run : {};
  await playReplay({ meta: r.meta, bytes, info: { id: String(id), name: String(run.name || ''), time: run.time, result: run.result } });
}

export const watchLastRun = () => { const l = lastRun(); return l ? playReplay(l) : Promise.resolve(); };

// meta: lib/replay-codec.js cleanMeta's; bytes: the decoded (un-gzipped) replay; info: who / what, for the bar
export async function playReplay({ meta, bytes, info = {} }) {
  if (!meta || typeof meta !== 'object' || !Number.isInteger(meta.seed)) throw new Error('replay: no seed');
  const data = decodeReplay(bytes);
  if (!S.mapIndex.some((m) => m.name === meta.map)) throw new Error(`replay: ${meta.map} is not on this server`);
  stopReplay(false);
  await G.selectMap(meta.map);
  await G.loadStage?.(); // a map that loads its world on a stage pick (main.js); older boots load it with the map
  const index = S.scenarios.findIndex((s) => s.id === meta.stage);
  if (index < 0) throw new Error('replay: that stage is not in this map any more');
  if (meta.mapVersion && S.map.version && meta.mapVersion !== S.map.version) log('replay: the map was re-baked since this run; it may play out differently');
  S.replay = { meta, data, byTick: indexEvents(data.events), info, index, cam: 'first', speed: 1, paused: false, fast: false, gun: meta.weapon === 'gun', stageName: S.scenarios[index].name || '' };
  G.overlay.hide();
  G.home?.hide();
  begin();
  G.replayBar.show(S.replay);
}

function begin() {
  const r = S.replay;
  startScenario(r.index, r.meta.mode);
  r.paused = false;
  S.paused = false;
  G.audio.resume();
  G.menu.update();
}

// leave the replay: back to the stage list (or where you were)
export function stopReplay(toMenu = true) {
  if (!S.replay) return;
  if (document.pointerLockElement) document.exitPointerLock?.();
  S.replay = null;
  endRun();
  G.replayBar.hide();
  if (toMenu) { S.paused = true; G.audio.pause(); G.overlay.hide(); G.menu.show('stages'); G.menu.update(); }
}

// the tick the stage clock starts on: 0 for a stage that starts mid-map (world/run-engine.js fastForward), else after
// the countdown
const startTick = (run) => run.startTick ?? (run.started ? 0 : Math.round(run.startAt / CS.tick));

// replay seconds: the stage clock (negative during the countdown); total: where the recording ends on it
export function replayClock() {
  const r = S.replay, run = S.run;
  if (!r || !run) return { t: 0, total: 0 };
  const k0 = startTick(run);
  return { t: (run.ticks - k0) * CS.tick, total: (r.data.n - k0) * CS.tick, at: run.ticks, n: r.data.n };
}

export function togglePause() {
  const r = S.replay;
  if (!r || r.fast) return;
  if (S.run?.done) { seekTo(-Infinity); return; } // over: Space watches it again
  r.paused = !r.paused;
  if (r.paused) G.audio.pause(); else G.audio.resume();
  G.replayBar.sync();
}

export function setSpeed(dir) {
  const r = S.replay;
  if (!r) return;
  const i = Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(r.speed) + dir));
  r.speed = SPEEDS[i];
  G.replayBar.sync();
}

export function cycleCam(cam) {
  const r = S.replay;
  if (!r) return;
  const next = cam || CAMS[(CAMS.indexOf(r.cam) + 1) % CAMS.length];
  setCam(next, r.last);
  if (next !== 'free' && document.pointerLockElement) document.exitPointerLock?.();
  G.replayBar.sync();
}

// jump to stage time t (seconds): forward runs the map on from here, back rebuilds the stage and runs it up to t
// (it is the same simulation either way: the seed and the recording decide everything)
export async function seekTo(t) {
  const r = S.replay;
  if (!r || r.fast) return;
  if (!S.run || S.run.done) begin();
  const target = Math.max(1, Math.min(r.data.n, startTick(S.run) + Math.round(t / CS.tick)));
  if (target < S.run.ticks) begin();
  const run = S.run;
  r.fast = true;
  G.replayBar.sync();
  try {
    while (run.ready === false) { await new Promise((res) => setTimeout(res, 50)); if (S.run !== run || S.replay !== r) return; }
    run.hooks?.silent?.(true);
    while (run.ticks < target && !run.done && S.run === run) {
      for (let k = 0; k < FF_CHUNK && run.ticks < target && !run.done; k++) step();
      updateHud();
      G.replayBar.sync();
      await new Promise((res) => setTimeout(res, 0));
    }
  } finally {
    if (S.run === run) run.hooks?.silent?.(false);
    r.fast = false;
    G.replayBar.sync();
  }
}

export const skip = (dt) => seekTo(replayClock().t + dt);

// session.finish in a replay: the recording reached its end (or the map ended it)
G.replayOver = (result, t) => {
  const r = S.replay;
  if (!r) return;
  r.paused = true;
  G.replayBar.sync();
  const who = r.info.name || 'Player';
  const what = result === 'win' ? 'cleared it' : result === 'dead' ? 'died' : result === 'lose' ? 'failed the stage' : 'stopped';
  G.overlay.show({
    kind: result === 'win' ? 'win' : 'dead', kicker: `Replay · ${S.scenario?.name || ''}`, title: 'REPLAY OVER',
    subtitle: `${who} ${what} at ${formatTime(Math.max(0, t))}`,
    stats: [['Hits taken', String(S.run?.hits ?? 0)]],
    buttons: [
      { label: 'Watch again', key: 'Enter', primary: true, onClick: () => { G.overlay.hide(); seekTo(-Infinity); } },
      { label: 'Leave', key: 'Escape', onClick: () => stopReplay(true) },
    ],
  });
};

// keys while a replay plays (app/input.js hands them over)
export function replayKey(code) {
  switch (code) {
    case 'Space': togglePause(); break;
    case 'ArrowLeft': skip(-5); break;
    case 'ArrowRight': skip(5); break;
    case 'BracketLeft': case 'Minus': setSpeed(-1); break;
    case 'BracketRight': case 'Equal': setSpeed(1); break;
    case 'KeyV': cycleCam(); break;
    case 'Digit1': cycleCam('first'); break;
    case 'Digit2': cycleCam('third'); break;
    case 'Digit3': cycleCam('free'); break;
    case 'KeyR': seekTo(-Infinity); break;
    case 'Escape': stopReplay(true); break;
  }
}
