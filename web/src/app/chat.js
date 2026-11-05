// The chat, as on a CS2Fixes ZE server: the map's "say" lines, CS2Fixes' command replies, and the room's players.
//
//   Y = messagemode (say to all), U = messagemode2 (say to team): CS2's default binds. While it is open the game keys
//   are off and Esc closes it (the game keeps running, as in CS2). Enter sends.
//   Map messages: point_servercommand "say <text>" (classes/server.js emits 'say'); CS2Fixes rewrites every Console
//   line to " \7CONSOLE:\4 <text>" (src/detours.cpp Detour_UTIL_SayTextFilter; cs2f_trigger_timer_enable is 0 in its
//   shipped cfg and GFL's configs don't turn it on, so no "- @ m:ss" suffix).
//   Player lines: CS2's own formats (csgo_english.txt Cstrike_Chat_All " [ALL] %s1: %s2", Cstrike_Chat_CT " [CT] %s1:
//   %s2", ..._Dead "%s1 [DEAD]"); humans are CT. A line starting with ! runs a command and still shows, / runs it
//   silently (app/chat-commands.js). In a room every line goes through the server (server/coop-chat.js) to everyone.
import { S, G } from './state.js';
import { settings, saveSettings } from './settings.js';
import { clearKeys } from './input.js';
import { ChatWindow } from '../ui/chat.js';
import { runCommand, registerCommand, cs2fixes } from './chat-commands.js';
import { cleanChat, cleanChatName, cleanMapLine } from '../lib/chat-colors.js';

const CT_NAME = 'rgb(150, 200, 250)'; // csgostyles.vcss @define ct-color: a human's name in chat

let chat = null;
let net = null;

// net: the co-op client (net/coop-client.js); its room lines come in through onRoomChat
export function installChat(root, { net: client } = {}) {
  net = client;
  chat = G.chat = new ChatWindow(root, { onSend: send });
  client?.on('chat', onRoomChat);
  registerBuiltins();
}

export const chatOpen = () => !!chat?.isOpen;

// input.js keydown, while playing: Y / U open the chat. Returns true when it used the key.
export function chatKey(ev) {
  if (!chat) return false;
  if (chat.isOpen) {
    if (ev.code === 'Escape') { ev.preventDefault(); chat.close(); return true; }
    return true; // the text box has the keyboard: no game keys
  }
  if (ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey) return false;
  if (ev.code !== 'KeyY' && ev.code !== 'KeyU') return false;
  ev.preventDefault(); // or the opening key lands in the box
  clearKeys();
  chat.open(ev.code === 'KeyU');
  return true;
}

// a map's "say" (engine 'say'): silent during a fast-forward, where the map's earlier lines would flood in at once
export function consoleSay(text) {
  if (!chat || S.run?.silent) return;
  const t = cleanMapLine(text);
  if (t) chat.add(` \x07CONSOLE:\x04 ${t}`);
}

export function systemLine(line) { chat?.add(line); }

// every part cleaned here too, whoever sent it (the server already did): shown as text only (ui/chat.js)
function playerLine({ name, text, team, dead }) {
  const msg = cleanChat(text);
  if (!msg) return;
  const tag = team ? '[CT]' : '[ALL]';
  const who = `${tag} ${cleanChatName(name)}${dead ? ' [DEAD]' : ''}`;
  chat.add([[' ', CT_NAME], [who, CT_NAME], [`: ${msg}`, '#ffffff']]);
}

// the room's lines (net.on('chat'))
function onRoomChat(m) {
  if (!chat) return;
  if (m.flood) { chat.add(cs2fixes('You are flooding the server!')); return; }
  playerLine(m);
}

function send(raw, team) {
  const text = cleanChat(raw);
  if (!text) return;
  const res = runCommand(text, { S, G, settings });
  if (!res.silent) {
    if (net?.room) net.chat(text, team); // the server echoes it back to everyone, us included
    else playerLine({ name: G.lobby?.name || 'Player', text, team, dead: !!S.run?.spectating });
  }
  for (const r of res.replies) chat.add(r);
}

// --------------------------------------------------------------- commands this app has
function registerBuiltins() {
  // CS2Fixes !tp: third person on / off (app/camera.js)
  registerCommand(['tp', 'thirdperson'], () => {
    settings.thirdPerson = !settings.thirdPerson;
    saveSettings();
    const box = document.querySelector('#thirdperson');
    if (box) box.checked = settings.thirdPerson;
  });
  // CS2Fixes' buy table (src/utils/weapon.cpp): item_kevlar, $650, "Kevlar Vest", alias "kevlar"; !kev as a short form.
  // ParseWeaponCommand: humans only, money check, then the item and "You have purchased %s for $%i".
  registerCommand(['kevlar', 'kev'], () => {
    const run = S.run;
    if (!run || run.done || run.spectating || (run.hp ?? 0) <= 0) return cs2fixes('You can only buy weapons when human.');
    const money = run.money ?? 16000;
    if (money < 650) return cs2fixes(`You can't afford Kevlar Vest! It costs $650, you only have $${money}`);
    run.money = money - 650;
    run.armor = 100; // a fresh vest; the helmet you have stays
    return cs2fixes('You have purchased Kevlar Vest for $650');
  });
}
