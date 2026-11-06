// Voice chat in a room: hold V to talk (CS2's +voicerecord, bound to V here), everyone in the room hears it (alltalk,
// like the room chat). Packets go through the co-op server (server/coop-voice.js), never player to player, so no one
// sees another player's address. The mic opens on your first press in a room (the browser asks once) and closes when
// you leave it. Who is talking shows in CS2's voice popups (ui/voice-hud.js).
//
//   installVoice()      net wiring + the popups (main.js)
//   talk(down)          input.js's V, while playing
//   G.voice             { muted(id), mute(id, on), setVolume(v) }: the room screen's mute buttons, main.js applySettings
import { S, G } from './state.js';
import { net } from './coop.js';
import { settings } from './settings.js';
import { VoiceCapture } from '../audio/voice-capture.js';
import { VoicePlayback } from '../audio/voice-playback.js';
import { VoiceHud } from '../ui/voice-hud.js';
import { toast } from '../ui/toast.js';

const TICK_MS = 50;
const MIC_ERRORS = {
  unsupported: 'Voice chat needs a newer browser (Chrome, Edge or Firefox)',
  denied: 'Microphone blocked: allow it from the address bar to talk',
  'no-mic': 'No microphone found',
};
const curve = (v) => Math.max(0, Math.min(1, v)) ** 2; // the same slider curve as the game's sound (audio/audio.js)

let mic = null; // VoiceCapture, from your first press in a room
let out = null; // VoicePlayback, from the first voice you hear
let held = false;
const muted = new Set(); // connection ids you muted (for this visit; a reconnect is a new id)

export function talk(down) {
  if (down) {
    if (held || !net.inRoom) return;
    held = true;
    mic ||= new VoiceCapture({ onPacket: (first, opus) => net.voice(first, opus) });
    mic.talk(true);
    if (!mic.isOpen) {
      mic.open().catch((e) => {
        held = false;
        mic = null;
        toast(MIC_ERRORS[e?.message] || MIC_ERRORS['no-mic'], { tone: 'warn' });
      });
    }
    return;
  }
  if (!held) return;
  held = false;
  mic?.talk(false);
}

function hear(id, first, opus) {
  if (muted.has(id)) return;
  if (!out) { out = new VoicePlayback(); out.volume = curve(settings.voice); }
  out.push(id, first, opus);
}

function stopAll() {
  held = false;
  mic?.close(); mic = null;
  out?.close(); out = null;
}

const dead = (id) => S.mp?.players.get(id)?.alive === false;

// the popups' rows, in the order people started talking (the HUD keeps that order)
function rows() {
  const list = [];
  if (mic?.on) list.push({ id: net.you, name: net.member(net.you)?.name || 'You', level: mic.level, dead: dead(net.you) });
  for (const id of out?.ids() || []) {
    if (out.speaking(id) && !muted.has(id)) list.push({ id, name: net.member(id)?.name || 'Player', level: out.level(id), dead: dead(id) });
  }
  return list;
}

export function installVoice() {
  const hud = new VoiceHud(document.body);
  net.on('voice', hear);
  // someone left the room: their decoder goes
  net.on('room', () => { for (const id of out?.ids() || []) if (!net.member(id)) out.drop(id); });
  net.on('left', stopAll);
  G.voice = {
    muted: (id) => muted.has(id),
    mute(id, on) { if (on) { muted.add(id); out?.drop(id); } else muted.delete(id); },
    setVolume(v) { if (out) out.volume = curve(v); },
  };
  setInterval(() => {
    if (held && !S.locked) talk(false); // the menu came up (Esc, alt-tab) with V still down: its keyup never comes
    hud.update(document.body.classList.contains('in-room-screen') ? [] : rows());
  }, TICK_MS);
}
