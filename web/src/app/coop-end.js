// The end card of a co-op / versus round (the server's verdict): who won, how, and a line per player (survived /
// died at). The room owner's card has "Play again" (the server starts the next round for everyone); everyone has
// "Back to room" (the room screen, where the owner picks the next stage).
import { S, G } from './state.js';
import { formatTime, plural } from '../lib/format.js';

export function showRoundEnd(round, d) {
  const me = round.me;
  const won = d.winners.includes(me);
  const versus = round.kind === 'versus' && round.players.size >= 2;
  const solo = round.players.size === 1;
  const names = (ids) => ids.map((id) => (id === me ? 'You' : round.name(id))).join(' & ');
  const scenario = S.scenario;
  let kind, title, subtitle;
  if (versus) {
    kind = d.result === 'draw' ? 'endless' : won ? 'win' : 'dead';
    title = d.result === 'draw' ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
    subtitle = d.result === 'draw' ? (d.winners.length ? `${names(d.winners)} tied` : 'Nobody made it')
      : d.reason === 'win' ? `${names(d.winners)} cleared it with the fewest hits`
        : `${names(d.winners)} ${d.winners[0] === me ? 'were' : 'was'} the last one alive`;
  } else if (d.result === 'win') {
    kind = 'win';
    const survivors = d.winners;
    title = won ? 'STAGE CLEARED' : 'TEAM CLEARED';
    subtitle = solo ? 'Cleared' : survivors.length === 1 && round.players.size > 1
      ? `${names(survivors)} cleared it solo, the last one alive`
      : `${plural(survivors.length, 'survivor')}: ${names(survivors)}`;
  } else if (d.result === 'over') {
    kind = 'endless';
    title = 'RUN OVER';
    subtitle = solo ? 'Survived to the end' : `Last alive: ${names(d.winners)}`;
  } else {
    kind = 'dead';
    title = d.reason === 'wiped' ? (solo ? 'YOU DIED' : 'TEAM WIPED') : 'STAGE FAILED';
    subtitle = d.reason === 'wiped' ? 'Nobody survived' : 'The stage was lost';
  }

  const stats = d.stats.map((s) => [
    s.id === me ? `${round.name(s.id)} (you)` : round.name(s.id),
    `${s.alive ? 'alive' : `died ${formatTime(s.at)}`} · ${plural(s.hits, 'hit')}`,
    d.winners.includes(s.id),
  ]);
  stats.push(['Round time', formatTime(d.at)]);

  // back to the room screen (ui/room.js), where the owner picks the next stage; Play again restarts this one
  const room = { label: 'Back to room', key: 'Escape', primary: !round.isHost, onClick: () => { G.overlay.hide(); G.room?.comeBack(); G.menu.update(); } };
  const buttons = round.isHost
    ? [{ label: 'Play again', key: 'Enter', primary: true, onClick: () => G.hostStart(S.scenarioIndex, round.mode) }, room]
    : [room];
  G.overlay.show({
    kind,
    kicker: `${scenario?.name || 'Free roam'} · ${versus ? 'versus' : 'co-op'}${round.mode === 'endless' ? ' · endless' : ''}`,
    title, subtitle, record: round.isHost ? '' : 'Waiting for the room owner to start the next round', stats, buttons,
  });
  G.menu.update();
}
