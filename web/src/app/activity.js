// Your solo runs on the home page's live feed (server/activity.js). Only finished stages are sent: map, stage,
// win / death, time, hits, what killed you, and the name you typed in the lobby. Off with the home page's
// "Share my runs" switch (kept in this browser), and never for runs with god mode on (nothing to show).
// main.js hands over the co-op socket (installActivity) so this file doesn't import app/coop.js (which imports
// session.js, which reports here).
import { loadJson, saveJson } from '../lib/storage.js';

const KEY = 'lasers.home'; // { share: boolean }
let net = null;

export function installActivity(client) { net = client; }
export function sharesRuns() { return loadJson(KEY).share !== false; }
export function setSharesRuns(on) { saveJson(KEY, { ...loadJson(KEY), share: !!on }); }

// { map, stage, mode, result: 'win' | 'dead' | 'lose', time, hits, cause, name, god }
export function reportSolo({ god, ...run }) {
  if (god || !net || !sharesRuns() || !run.stage || run.stage === 'free') return;
  net.reportSolo(run);
}
