// Chat commands, CS2Fixes style: a chat line starting with ! or / runs the command named by its first word
// (CS2Fixes ParseChatCommand: tokenised, the name lower-cased, looked up in one table). "!" lines still show in chat,
// "/" lines are silent (CS2Fixes bSilent). Replies go to the typer only, prefixed CHAT_PREFIX " \7[CS2Fixes]\1 "
// (src/commands.h), with CS2's chat colour codes (lib/chat-colors.js).
//
//   registerCommand(['tp', 'thirdperson'], (args, ctx) => 'reply')   // a string or string[] of replies, or nothing
//   runCommand('!tp', ctx) -> { command: bool, silent: bool, replies: string[] }
//
// ctx is whatever the caller passes (app/chat.js passes { S, G, settings }).
const commands = new Map();

export const CHAT_PREFIX = ' \x07[CS2Fixes]\x01 ';
export const cs2fixes = (text) => CHAT_PREFIX + text;

export function registerCommand(names, fn) {
  for (const n of names) commands.set(String(n).toLowerCase(), fn);
}

export function runCommand(text, ctx) {
  const s = String(text ?? '').trim();
  const lead = s[0];
  if (lead !== '!' && lead !== '/') return { command: false, silent: false, replies: [] };
  const args = s.slice(1).split(/\s+/).filter(Boolean);
  const fn = commands.get((args[0] || '').toLowerCase());
  if (!fn) return { command: false, silent: lead === '/', replies: [] };
  let out;
  try { out = fn(args, ctx); } catch (e) { out = cs2fixes(`\x02${e.message || e}`); }
  const replies = out == null ? [] : Array.isArray(out) ? out : [out];
  return { command: true, silent: lead === '/', replies };
}
