// Replays and the Steam account, wired into the page (main.js calls these): the replay bar, the end card's
// "Watch replay", a shared link (?replay=<id>; ?player=<SteamID64> opens a profile), and who is signed in (?signin=ok|failed after Steam sends you back).
import { G, $, log } from './state.js';
import { ReplayBar } from '../ui/replay-bar.js';
import { watchReplay, watchLastRun, togglePause, seekTo, setSpeed, cycleCam, stopReplay, replayClock, replayKey, isReplayId } from './replay.js';
import { loadAccount } from './account.js';
import { isSteamId } from '../lib/steam.js';

export { replayKey };

function failed(e) {
  log(`replay: ${e.message || e}`);
  stopReplay(false);
  G.home?.show();
  G.home?.note?.(`Couldn't play that replay (${e.message || e})`);
}

export function installReplays() {
  G.replayBar = new ReplayBar($('#replaybar'), {
    pause: togglePause, seek: (t) => seekTo(t), speed: setSpeed, cam: (c) => cycleCam(c), leave: () => stopReplay(true), clock: replayClock,
    link: (info) => (info?.id && isReplayId(info.id) ? `${location.origin}/?replay=${info.id}` : ''),
  });
  G.watchLastRun = () => watchLastRun().catch(failed);
  G.watchReplay = (id) => watchReplay(id).catch(failed);
  // a replay opened from a link starts without a click: its sound waits for the first one
  document.addEventListener('pointerdown', () => G.audio?.resume?.(), { once: true });
}

// after the map index is in: the account, then a shared replay link
export async function bootReplays() {
  const url = new URL(location.href);
  const signin = url.searchParams.get('signin');
  const replay = url.searchParams.get('replay');
  if (signin) { url.searchParams.delete('signin'); history.replaceState(null, '', url); }
  if (signin === 'failed') log('Steam sign-in did not go through');
  await loadAccount();
  if (replay && isReplayId(replay)) await watchReplay(replay).catch(failed);
  else if (isSteamId(url.searchParams.get('player'))) G.home?.showPlayer(url.searchParams.get('player')); // a profile link (ui/profile.js)
}

export const hasReplayLink = () => isReplayId(new URLSearchParams(location.search).get('replay'));
