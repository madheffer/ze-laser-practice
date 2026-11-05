// CS2 chat colour codes: a control character in a chat line switches the colour of the text after it.
// Servers and plugins colour with these (CS2Fixes prints map messages as " \7CONSOLE:\4 <text>" and its replies as
// " \7[CS2Fixes]\1 <text>"), so a line is split into runs of [text, colour].
//
// Truth: client.dll keeps the chat palette as a table of "#rrggbb" strings (0x1ce41d8 in the 2026-11-05 build:
// #ffffff #40ff40 #bfff90 #a2ff47 #c5cad0 #ede47a #ff0000 next to #ba81f0) and #FF4040 for errors; the codes past
// \x09 are CS2's item rarity colours (csgostyles.vcss @define color-rarity-*). Which code maps to which colour is the
// order plugins document and use (CounterStrikeSharp ChatColors, CS2Fixes' own \4 green / \7 light red). \x0D has
// no colour anyone documents: it leaves the colour as it is.
export const CHAT_COLORS = Object.freeze({
  1: '#ffffff', // default / white
  2: '#ff0000', // dark red
  3: '#ba81f0', // light purple (CS:GO's team colour code)
  4: '#40ff40', // green
  5: '#bfff90', // olive
  6: '#a2ff47', // lime
  7: '#ff4040', // light red
  8: '#c5cad0', // grey
  9: '#ede47a', // yellow
  10: '#b0c3d9', // blue-grey (rarity common)
  11: '#5e98d9', // light blue (uncommon)
  12: '#4b69ff', // dark blue (rare)
  14: '#d32ce6', // magenta (legendary)
  15: '#eb4b4b', // light red (ancient)
  16: '#e4ae39', // gold (immortal)
});
export const DEFAULT_COLOR = CHAT_COLORS[1];

// "\x07CONSOLE:\x04 hi" -> [['CONSOLE:', '#ff4040'], [' hi', '#40ff40']]. Other control characters are dropped.
export function chatRuns(line, color = DEFAULT_COLOR) {
  const runs = [];
  let cur = '';
  for (const ch of String(line ?? '')) {
    const c = ch.codePointAt(0);
    if (c < 0x20) {
      if (cur) { runs.push([cur, color]); cur = ''; }
      if (CHAT_COLORS[c]) color = CHAT_COLORS[c];
      continue;
    }
    cur += ch;
  }
  if (cur) runs.push([cur, color]);
  return runs;
}

// What a player may type, cleaned the same on the client and the server (server/coop-chat.js): a plain string only
// (anything else is nothing), no colour codes or other control characters (C0, DEL, C1), no invisible formatting that
// can disguise a line (bidi overrides / isolates that reverse text, zero-width characters, line / paragraph separators,
// the BOM), no stacks of combining marks ("zalgo" that draws over other lines: at most 2 per character), whitespace
// runs collapsed, at most CS2's 127 characters (ChatTextEntryBox maxchars). It is only ever shown as text
// (ui/chat.js: textContent, colours from CHAT_COLORS), never parsed, evaluated or put into HTML.
export const MAX_CHAT = 127;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const INVISIBLE = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\ufff9-\ufffb]/g;
const ZALGO = /(\p{M}{2})\p{M}+/gu;
export function cleanChat(s) {
  if (typeof s !== 'string') return '';
  const t = s.slice(0, MAX_CHAT * 4).normalize('NFC').replace(CONTROL, '').replace(INVISIBLE, '').replace(ZALGO, '$1').replace(/\s+/g, ' ').trim();
  return [...t].slice(0, MAX_CHAT).join('').trim(); // by code point, so an emoji is never cut in half
}
// A player's name in a chat line: the same cleaning, 24 characters.
export const cleanChatName = (s) => [...cleanChat(typeof s === 'string' ? s : '')].slice(0, 24).join('').trim() || 'Player';
// A map's own line (point_servercommand say): it may colour itself with the codes, so only the invisible formatting and
// mark stacks go (chatRuns drops the other control characters when it draws it), at most 255 characters.
export function cleanMapLine(s) {
  if (typeof s !== 'string') return '';
  return [...s.slice(0, 1024).normalize('NFC').replace(INVISIBLE, '').replace(ZALGO, '$1')].slice(0, 255).join('');
}
