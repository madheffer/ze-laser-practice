// Your solo runs, to the server (POST /api/solo, server/runs-http.js): map, stage, win / death, time, hits, what
// killed you, the name you typed in the lobby, and the run's replay (app/replay-record.js: your position and view
// on every tick, gzipped). Only finished stages, never runs with god mode on.
//   "Share my runs" on (the home page's switch, kept in this browser): it goes on the live feed, and anyone can watch
//   its replay. Off: signed in through Steam, it is still kept for your run history (only you can watch it);
//   signed out, nothing is sent.
import { loadJson, saveJson } from '../lib/storage.js';
import { gzip, toBase64 } from '../lib/bytes.js';
import { signedIn } from './account.js';

const KEY = 'lasers.home'; // { share: boolean }

export function sharesRuns() { return loadJson(KEY).share !== false; }
export function setSharesRuns(on) { saveJson(KEY, { ...loadJson(KEY), share: !!on }); }

// run: { map, stage, mode, result: 'win' | 'dead' | 'lose', time, hits, cause, name, god }; replay: { meta, bytes } or null
// -> the server's { id, replay } (replay: the id to watch it by), or null
export async function reportSolo({ god, ...run }, replay) {
  if (god || !run.stage || run.stage === 'free') return null;
  const share = sharesRuns();
  if (!share && !signedIn()) return null;
  const body = { ...run, share };
  try {
    if (replay) body.replay = { meta: replay.meta, data: toBase64(await gzip(replay.bytes)) };
    const r = await fetch('/api/solo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.ok ? await r.json() : null;
  } catch {
    return null; // offline / a static host without the server: the run stays local
  }
}
