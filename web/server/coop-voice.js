// Room voice (coop-relay.js, binary frames): a player's Opus packet goes to everyone else in their room, through the
// server like everything else, so no one sees another player's address. Everyone in the room hears everyone (alltalk:
// the room chat is room-wide too). The server never decodes or keeps the audio.
//
//   client -> server   [flags u8][opus packet]            flags bit 0: the first packet of a talk spurt
//   server -> client   [sender id u32 LE][flags u8][opus]
//
// A packet is 20 ms (app/voice.js): 50 a second while talking. Voice has its own budget, apart from the round's
// RATE, so talking never starves your position updates. A listener whose socket is backed up skips voice until it
// drains: an old packet is worse than a missing one (it only adds delay).
export const VOICE_MAX = 600; // bytes per packet: 20 ms at 40 kbit/s is ~100, Opus' own ceiling at 20 ms is 1275
const VOICE_RATE = 60; // packets per second per connection
const BACKLOG = 32 * 1024; // bytes queued to a listener past which their voice is skipped

// c: the sender's connection ({ id, room, voiceAt, voiceN }); data: the frame (Buffer). Returns the frame the others get, or null.
export function voiceFrame(c, data, now) {
  if (!c.room || !data?.length || data.length > VOICE_MAX + 1) return null;
  if (now - (c.voiceAt || 0) >= 1000) { c.voiceAt = now; c.voiceN = 0; }
  if (++c.voiceN > VOICE_RATE) return null;
  const out = Buffer.allocUnsafe(4 + data.length);
  out.writeUInt32LE(c.id >>> 0, 0);
  out[4] = data[0] & 1; // only the known flag goes on
  data.copy(out, 5, 1);
  return out;
}

export function relayVoice(c, data, now) {
  const out = voiceFrame(c, data, now);
  if (!out) return;
  for (const m of c.room.members) {
    if (m !== c && m.ws.readyState === 1 && m.ws.bufferedAmount < BACKLOG) m.ws.send(out, { binary: true });
  }
}
