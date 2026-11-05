// Your solo runs, to the server (POST /api/solo, server/runs-http.js): map, stage, win / death, time, hits, what
// killed you, the name you typed in the lobby, and the run's replay (app/replay-record.js: your position and view
// on every tick, gzipped). Only finished stages, never runs with god mode on.
//   Signed in through Steam: kept for your run history; "Share my runs" on (the home page's switch, kept in this
//   browser) also puts it on the live feed and lets anyone watch its replay.
//   A guest: the server keeps nothing of theirs (no runs, replays or ranks). Their last finished run waits in this
//   tab (sessionStorage, PENDING_MS) so the end card's "Sign in to save" can take them to Steam and back; once signed
//   in, it is sent (sendPendingRun) and a toast says so.
import { loadJson, saveJson } from '../lib/storage.js';
import { gzip, toBase64 } from '../lib/bytes.js';
import { signedIn, onAccount } from './account.js';
import { toast } from '../ui/toast.js';

const KEY = 'lasers.home'; // { share: boolean }
const PENDING = 'lasers.pendingRun'; // sessionStorage: { at, body } (this tab only, gone with it)
const PENDING_MS = 30 * 60 * 1000; // a run waits this long for its player to sign in

export function sharesRuns() { return loadJson(KEY).share !== false; }
export function setSharesRuns(on) { saveJson(KEY, { ...loadJson(KEY), share: !!on }); }

async function post(body) {
  try {
    const r = await fetch('/api/solo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.ok ? await r.json() : null;
  } catch {
    return null; // offline / a static host without the server: the run stays local
  }
}

// the run a guest finished last, for after they sign in (a full tab drops the replay, then the run, never throws)
function keepPending(body) {
  const put = (b) => sessionStorage.setItem(PENDING, JSON.stringify({ at: Date.now(), body: b }));
  try { put(body); } catch {
    try { const { replay, ...rest } = body; put(rest); } catch { /* storage off: it stays local only */ }
  }
}
function takePending() {
  try {
    const raw = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p === 'object' && Number.isFinite(p.at) && Date.now() - p.at < PENDING_MS && p.body && typeof p.body === 'object' ? p.body : null;
  } catch { return null; }
}
// a run is waiting for its player to sign in (the end card offers it)
export function hasPendingRun() {
  try { return !!sessionStorage.getItem(PENDING); } catch { return false; }
}

// run: { map, stage, mode, result: 'win' | 'dead' | 'lose', time, hits, cause, name, god }; replay: { meta, bytes } or null
// -> the server's { id, replay } (replay: the id to watch it by), { pending: true } for a guest, or null
export async function reportSolo({ god, ...run }, replay) {
  if (god || !run.stage || run.stage === 'free') return null;
  const body = { ...run, share: sharesRuns() };
  try { if (replay) body.replay = { meta: replay.meta, data: toBase64(await gzip(replay.bytes)) }; } catch { /* sent without it */ }
  if (!signedIn()) { keepPending(body); return { pending: true }; }
  return post(body);
}

// Signed in with a guest run waiting (back from Steam): send it, under the share setting as it is now
export async function sendPendingRun() {
  if (!signedIn()) return null;
  const body = takePending();
  if (!body) return null;
  const r = await post({ ...body, share: sharesRuns() });
  toast(r ? 'Your run was saved to your account' : 'Your run could not be saved', { tone: r ? 'ok' : 'warn' });
  return r;
}
onAccount((a) => { if (a.user) sendPendingRun(); });
