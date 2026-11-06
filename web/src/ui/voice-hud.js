// Who is talking: CS2's voice popups (layout/hud/hudvoicestatus.vxml's VoiceNotice snippet; client.dll's
// CCSGO_HudVoiceStatus sets its classes). One row per speaker, in the order they started: the speaker icon with its
// three sound bars (Looping animates them; SoundOff / SoundLow / SoundHigh cap them at the voice's loudness), the team
// avatar (DefaultAvatarCT: humans are CT) and the name. Dead and spectating, the avatar turns the spectator grey
// (DefaultAvatarSpec, ours: CS2's stylesheet has no spectator avatar, so it is the CT icon under ShowSkull's
// #6666669c wash) with the skull over it (ShowSkull), swapped the tick they die.
// A row fades in 0.2 s and out 0.3 s (.VoiceNotice / .VoiceNotice.Hidden). Names are the server's: textContent only.
//
//   const hud = new VoiceHud(document.body); hud.update([{ id, name, level 0..1, dead }])
//   voiceBadge()   the room / loading screens' "talking" mark on a player square (shown by the square's .talking)
import './voice-hud.css';

const FADE_MS = 300;
// the loudness -> CS2's sound bar classes (none of the three = all three bars)
const levelClass = (v) => (v < 0.1 ? 'SoundOff' : v < 0.4 ? 'SoundLow' : v < 0.7 ? 'SoundHigh' : '');

function div(cls) { const e = document.createElement('div'); e.className = cls; return e; }

// CS2's speaker and its looping sound bars, small, for a player square
export function voiceBadge() {
  const b = document.createElement('span');
  b.className = 'vc-badge';
  b.setAttribute('aria-hidden', 'true');
  b.append(div('SpeakerIcon'), div('SoundIcon1'), div('SoundIcon2'), div('SoundIcon3'));
  return b;
}

export class VoiceHud {
  constructor(parent) {
    this.root = div('voice-status');
    this.root.setAttribute('aria-hidden', 'true');
    parent.append(this.root);
    this.rows = new Map(); // id -> { el, text, hideT }
  }

  row(id) {
    let r = this.rows.get(id);
    if (r) { clearTimeout(r.hideT); r.hideT = 0; return r; }
    const el = div('VoiceNotice DefaultAvatarCT Looping Hidden');
    const anim = div('SoundAnim');
    anim.append(div('SpeakerIcon'), div('SoundIcon1'), div('SoundIcon2'), div('SoundIcon3'));
    const avatar = div('AvatarPanel');
    avatar.append(div('AvatarBG'), div('Skull'));
    const text = div('VoiceText');
    el.append(anim, avatar, text);
    this.root.append(el);
    void el.offsetWidth; // laid out at opacity 0 first, so it fades in (not a frame later: a hidden tab gets no frames)
    el.classList.remove('Hidden');
    r = { el, text, hideT: 0, cls: '' };
    this.rows.set(id, r);
    return r;
  }

  update(list) {
    const on = new Set();
    for (const s of list) {
      on.add(s.id);
      const r = this.row(s.id);
      if (r.text.textContent !== s.name) r.text.textContent = s.name;
      const cls = levelClass(s.level);
      if (cls !== r.cls) { if (r.cls) r.el.classList.remove(r.cls); if (cls) r.el.classList.add(cls); r.cls = cls; }
      r.el.classList.toggle('DefaultAvatarCT', !s.dead);
      r.el.classList.toggle('DefaultAvatarSpec', !!s.dead);
      r.el.classList.toggle('ShowSkull', !!s.dead);
    }
    for (const [id, r] of this.rows) {
      if (on.has(id) || r.hideT) continue;
      r.el.classList.add('Hidden');
      r.hideT = setTimeout(() => { r.el.remove(); this.rows.delete(id); }, FADE_MS);
    }
  }
}
