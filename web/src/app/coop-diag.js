// What this client saw in a round, sent to the co-op server's log (server/coop-log.js "coop client.<kind>"), so a
// round that went wrong on the live server can be followed from both ends: the server logs what it decided, these
// say what the player's game showed. Only while in a room; nothing personal (names are the room's, no settings).
//
//   endround   the owner pressed End round: whether the client sent the abort, and why not
//   spectate   ~1.5 s after you die: who the death camera follows, and what it has of the others
//   error      a script error or rejected promise while in a room (message and where)
import { S } from './state.js';

const SPECTATE_AFTER_MS = 1500;
const ERRORS_PER_MIN = 5;

// k=v pairs, one line
const line = (o) => Object.entries(o).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') || '-' : v}`).join(' ');

export function installCoopDiag(net) {
  let errAt = 0, errN = 0;
  const report = (msg) => {
    if (!net.inRoom) return;
    const now = Date.now();
    if (now - errAt >= 60_000) { errAt = now; errN = 0; }
    if (++errN <= ERRORS_PER_MIN) net.diag('error', msg, S.mp?.r);
  };
  addEventListener('error', (e) => report(`${e.message || 'error'} @ ${(e.filename || '').split('/').pop()}:${e.lineno || 0}:${e.colno || 0}`));
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report(`unhandled: ${r?.message || String(r)} @ ${String(r?.stack || '').split('\n')[1]?.trim().slice(0, 120) || '-'}`);
  });

  return {
    // sent: whether abortRound sent the abort (the server logs what it did with it)
    endRound(sent) {
      const mp = S.mp;
      net.diag('endround', line({
        sent, mp: !!mp, ended: !!mp?.ended, host: net.isHost, r: mp?.r ?? '-', roomRound: net.room?.round?.r ?? '-',
        run: !!S.run, done: !!S.run?.done, spectating: !!S.run?.spectating,
      }), mp?.r);
    },

    // you died: a moment later, what the death camera has (the round may be over by then: that is said too)
    died(mp) {
      setTimeout(() => {
        if (S.mp !== mp || !net.inRoom) return;
        const view = mp.ended ? null : mp.spectateView();
        const t = S.run?.t ?? 0;
        const peers = [...mp.players.values()].filter((p) => p.id !== mp.me).map((p) => {
          const q = mp.peerSamples(p.id);
          return `#${p.id}:${p.alive ? 'alive' : 'dead'}:${q.n}s:${q.n ? (t - q.last).toFixed(2) : '-'}`;
        });
        net.diag('spectate', line({
          ended: mp.ended, spectating: !!S.run?.spectating, done: !!S.run?.done, watching: view ? `#${view.id}` : 'nobody',
          locked: !!S.locked, paused: !!S.paused, t: t.toFixed(2), peers,
        }), mp.r);
      }, SPECTATE_AFTER_MS);
    },
  };
}
