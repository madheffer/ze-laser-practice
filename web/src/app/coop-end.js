// The end card of a multiplayer round (the server's verdict, server/coop-round.js end): did the stage get cleared,
// who did best, and a line per player (survived / died at, hits), best run first. One mode: together on the same
// stage, and against each other. The room owner's card has "Play again" (the server starts the next round for
// everyone); everyone has "Back to room" (the room screen, where the owner picks the next stage).
import { S, G } from './state.js';
import { formatTime, plural } from '../lib/format.js';

export function showRoundEnd(round, d) {
  const me = round.me;
  const won = d.winners.includes(me);
  const top = d.best.includes(me);
  const solo = round.players.size === 1;
  const names = (ids) => ids.map((id) => (id === me ? 'You' : round.name(id))).join(' & ');
  const hitsOf = (id) => d.stats.find((s) => s.id === id)?.hits ?? 0;
  const scenario = S.scenario;
  let kind, title, subtitle;
  if (d.result === 'win') {
    kind = 'win';
    const survivors = d.winners;
    // you survived and had the best run: the round is yours; survived: cleared; down while others cleared it: theirs
    title = solo ? 'STAGE CLEARED' : top && won ? 'VICTORY' : won ? 'STAGE CLEARED' : 'TEAM CLEARED';
    subtitle = solo ? 'Cleared'
      : survivors.length === 1 ? `${names(survivors)} cleared it, the last one alive`
        : `${names(survivors)} cleared it · best run: ${names(d.best)} (${plural(hitsOf(d.best[0]), 'hit')})`;
  } else if (d.result === 'over') {
    kind = 'endless';
    title = solo ? 'RUN OVER' : top ? 'LASTED LONGEST' : 'RUN OVER';
    subtitle = solo ? 'Survived to the end' : `${names(d.best)} lasted the longest`;
  } else if (d.reason === 'wiped') {
    kind = 'dead';
    title = solo ? 'YOU DIED' : top ? 'LASTED LONGEST' : 'EVERYONE DOWN';
    subtitle = solo ? 'Nobody survived' : `Nobody cleared it · ${names(d.best)} lasted the longest`;
  } else {
    kind = 'dead';
    title = 'STAGE FAILED';
    subtitle = d.best.length ? `The stage was lost · best run: ${names(d.best)}` : 'The stage was lost';
  }

  // best run first, then who survived, then who lasted longer
  const order = [...d.stats].sort((a, b) => (d.best.includes(b.id) - d.best.includes(a.id)) || (b.alive - a.alive) || ((b.at ?? Infinity) - (a.at ?? Infinity)) || (a.hits - b.hits));
  const stats = order.map((s) => [
    s.id === me ? `${round.name(s.id)} (you)` : round.name(s.id),
    `${s.alive ? 'alive' : `died ${formatTime(s.at)}`} · ${plural(s.hits, 'hit')}${d.best.includes(s.id) && !solo ? ' · best' : ''}`,
    d.best.includes(s.id) || (d.result === 'win' && d.winners.includes(s.id)),
  ]);
  stats.push(['Round time', formatTime(d.at)]);

  // back to the room screen (ui/room.js), where the owner picks the next stage; Play again restarts this one
  const room = { label: 'Back to room', key: 'Escape', primary: !round.isHost, onClick: () => { G.overlay.hide(); G.room?.comeBack(); G.menu.update(); } };
  const buttons = round.isHost
    ? [{ label: 'Play again', key: 'Enter', primary: true, onClick: () => G.hostStart(S.scenarioIndex, round.mode) }, room]
    : [room];
  G.overlay.show({
    kind,
    kicker: `${scenario?.name || 'Free roam'} · online${round.mode === 'endless' ? ' · endless' : ''}`,
    title, subtitle, record: round.isHost ? '' : 'Waiting for the room owner to start the next round', stats, buttons,
  });
  G.menu.update();
}
