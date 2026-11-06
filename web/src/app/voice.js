// Voice chat in a room: hold V to talk (CS2's +voicerecord, bound to V here), everyone in the room hears it (alltalk,
// like the room chat). Packets go through the co-op server (server/coop-voice.js), never player to player, so no one
// sees another player's address. The mic opens on your first press in a room (the browser asks once) and closes when
// you leave it. V works at every step of a room, not only while playing: the room screen while the host picks, the
// loading screen, the pause menu, the end card (anywhere you aren't typing). Who is talking shows in CS2's voice
// popups in a round (ui/voice-hud.js), and on the room screen's and the loading screen's player squares (any element
// with data-voice-id gets .talking).
//
//   installVoice()      net wiring, the menus' V, the popups (main.js)
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

// a field that takes typing (the room's chat, your name, the in-game chat): a V there is a letter, not the mic
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
function typing(t) {
  if (!(t instanceof Element)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && TEXT_INPUTS.has(t.type);
}

// V outside the game (input.js has it while the mouse is locked); its keyup is input.js's, for every V
function menuKey(ev) {
  if (ev.code !== 'KeyV' || ev.repeat || S.locked || !net.inRoom) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target)) return;
  talk(true);
}

// Dead in the round being played: their popup turns the spectator grey at once (ui/voice-hud.js). A round that
// ended has nobody spectating any more.
const spectating = (id) => !!S.mp && !S.mp.ended && S.mp.players.get(id)?.alive === false;

// everyone talking now, id -> loudness 0..1 (you too, while your mic is on)
function talking() {
  const m = new Map();
  if (mic?.on) m.set(net.you, mic.level);
  for (const id of out?.ids() || []) if (out.speaking(id) && !muted.has(id)) m.set(id, out.level(id));
  return m;
}

// the popups' rows, in the order people started talking (the HUD keeps that order)
function rows(now) {
  return [...now].map(([id, level]) => ({
    id, level, dead: spectating(id), name: net.member(id)?.name || (id === net.you ? 'You' : 'Player'),
  }));
}

// the room screen's and the loading screen's player squares
function markSquares(now) {
  for (const sq of document.querySelectorAll('[data-voice-id]')) {
    sq.classList.toggle('talking', now.has(Number(sq.dataset.voiceId)));
  }
}

export function installVoice() {
  const hud = new VoiceHud(document.body);
  net.on('voice', hear);
  // someone left the room: their decoder goes
  net.on('room', () => { for (const id of out?.ids() || []) if (!net.member(id)) out.drop(id); });
  net.on('left', stopAll);
  document.addEventListener('keydown', menuKey);
  G.voice = {
    muted: (id) => muted.has(id),
    mute(id, on) { if (on) { muted.add(id); out?.drop(id); } else muted.delete(id); },
    setVolume(v) { if (out) out.volume = curve(v); },
  };
  setInterval(() => {
    if (held && document.hidden) talk(false); // the tab went away with V still down: its keyup never comes
    const now = net.inRoom ? talking() : new Map();
    // the room screen shows it on its own squares (it covers the popups)
    hud.update(document.body.classList.contains('in-room-screen') ? [] : rows(now));
    markSquares(now);
  }, TICK_MS);
}
