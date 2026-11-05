// Room chat (coop-relay.js 'chat'): a player's line goes to everyone in their room, with CS2Fixes' flood protection.
// The text is cleaned here (no colour codes, 127 chars), the name and [DEAD] come from the server, never the client.
import { cleanChat, cleanChatName } from '../src/lib/chat-colors.js';

// CS2Fixes ZEPlayer::IsFlooding (src/playermanager.cpp): cs2f_flood_interval 0.75 s, cs2f_max_flood_tokens 3,
// cs2f_flood_cooldown 3 s. A line within the interval of the last one takes a token; with all tokens taken the
// player is blocked for the cooldown; a slower line gives one token back.
const FLOOD_INTERVAL = 0.75, MAX_TOKENS = 3, COOLDOWN = 3;

export function isFlooding(c, now) {
  const t = now / 1000;
  c.chat ||= { last: 0, tokens: 0 };
  const f = c.chat;
  if (f.last >= t) {
    if (f.tokens >= MAX_TOKENS) { f.last = t + FLOOD_INTERVAL + COOLDOWN; return true; }
    f.tokens++;
  } else if (f.tokens > 0) f.tokens--;
  f.last = t + FLOOD_INTERVAL;
  return false;
}

// -> the message every room member gets, or null (nothing to send). flooded() tells the sender, as CS2Fixes does.
export function roomChat(c, m, now, { flooded } = {}) {
  const room = c.room;
  if (!room) return null;
  const text = cleanChat(m.text);
  if (!text) return null;
  if (isFlooding(c, now)) { flooded?.(); return null; }
  const p = room.round && !room.round.ended ? room.round.players.get(c.id) : null;
  return { t: 'chat', id: c.id, name: cleanChatName(c.name), text, team: m.team === true, dead: !!p && p.alive === false };
}
