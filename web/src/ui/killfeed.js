// The kill feed: CS2's death notices (CSGOHudDeathNotice), top right, newest at the bottom.
//
// Truth: panorama/layout/hud/huddeathnotice.vxml + styles/hud/huddeathnotice.vcss (lasers-bake --panorama) for the
// look and the timings, client.dll for the logic (CCSGO_HudDeathNotice's player_death handler, FUN_180e885f0 in the
// 2026-10-15 build, and its think, FUN_180e7eb90):
//   - no "weapon" in the event: no notice at all
//   - attacker -1 (the world, a trigger_hurt, any non-player) or the victim himself = a suicide: class
//     DeathNoticeSuicide shows the skull (deathnotice/icon_suicide.svg, white) and collapses the weapon icon, and the
//     Attacker label gets the VICTIM's name, coloured by the attacker's team: none for the world, so Label's default
//     baseText grey. A map death reads "<victim, grey> [skull] <victim, team colour>"
//   - a suicide by a player who is disconnecting: weapon "disconnect", the attacker label empty, no skull
//   - names: DeathNoticeCTColor / DeathNoticeTColor from the controller's team (3 / 2) when the notice is made
//   - you died: DeathNotice_Victim (dark red); you killed or assisted: DeathNotice_Killer (red border, 15px black)
//   - each notice lives DeathNoticeLifetime (5 s), x DeathNoticeLocalPlayerLifetimeMod (1.5) when it's about you,
//     then FadeOut (1 s) and is deleted; the rest slide up (transition: position .2s ease-out)
//   - a pool of 15 panels, a new notice takes the first free one (they sit after the live ones: newest at the bottom)
// Names are player names: text only, never HTML.
import './killfeed.css';

const LIFETIME_MS = 5000;  // @define DeathNoticeLifetime: 5.0
const LOCAL_MOD = 1.5;     // @define DeathNoticeLocalPlayerLifetimeMod: 1.5
const FADE_MS = 1000;      // @define DeathNoticeFadeOutTime: 1.0s
const POOL = 15;           // the think tops the panel up to 0xf
const ICONS = '/panorama/';
const WEAPON = /^[a-z0-9_]{1,40}$/; // an equipment icon name (icons/equipment/<weapon>.svg)
const TEAM = { ct: 'ct', t: 't' };  // anything else: no team class (baseText grey)

function label(name, team) {
  const l = document.createElement('span');
  l.className = 'kf-name' + (TEAM[team] ? ` ${TEAM[team]}` : '');
  l.textContent = name || '';
  return l;
}

function icon(src, cls) {
  const i = document.createElement('img');
  i.className = 'kf-icon' + (cls ? ` ${cls}` : '');
  i.src = ICONS + src;
  i.alt = '';
  i.draggable = false;
  return i;
}

export class Killfeed {
  constructor(root) {
    this.root = root;
    root.className = 'killfeed';
    root.setAttribute('aria-live', 'polite');
  }

  // One player_death, as CS2 draws it.
  //   victim, victimTeam ('ct' | 't')    who died
  //   attacker, attackerTeam             the killing player; leave out for the world / a trigger_hurt / a fall
  //   weapon                             the event's weapon ('knife', 'ak47', ...); a suicide shows the skull instead
  //   suicide                            the attacker is the victim (kill bind, slay): his name in both slots
  //   disconnect                         he left while alive (CS2: weapon "disconnect", no attacker name)
  //   headshot, penetrated               the event's modifiers
  //   self / killer                      the notice is about you dying / about your kill
  push({ victim, victimTeam = 'ct', attacker, attackerTeam, weapon = 'world', suicide = false, disconnect = false,
    headshot = false, penetrated = false, self = false, killer = false }) {
    const isSuicide = !disconnect && (suicide || !attacker);
    const row = document.createElement('div');
    row.className = 'kf-row available' + (self ? ' victim' : killer ? ' killer' : '');
    const content = document.createElement('div');
    content.className = 'kf-content';
    // Attacker label: the attacker, or (a suicide) the victim's own name in the attacker's colours
    if (disconnect) content.append(label('', null));
    else if (isSuicide) content.append(label(victim, suicide ? (attackerTeam || victimTeam) : null));
    else content.append(label(attacker, attackerTeam));
    if (disconnect) content.append(icon('icons/equipment/disconnect.svg'));
    else if (!isSuicide && WEAPON.test(weapon)) content.append(icon(`icons/equipment/${weapon}.svg`, 'kf-weapon'));
    if (penetrated) content.append(icon('hud/deathnotice/penetrate.svg'));
    if (headshot) content.append(icon('hud/deathnotice/icon_headshot.svg'));
    if (isSuicide) content.append(icon('hud/deathnotice/icon_suicide.svg'));
    content.append(label(victim, victimTeam));
    row.append(content);
    this.root.append(row);
    while (this.root.querySelectorAll('.kf-row:not(.gone)').length > POOL) this.remove(this.root.querySelector('.kf-row:not(.gone)'));
    void row.offsetWidth; // lay it out hidden, so leaving .available fades it in (the .vcss transition)
    row.classList.remove('available');
    row.timer = setTimeout(() => this.fade(row), LIFETIME_MS * (self || killer ? LOCAL_MOD : 1));
  }

  fade(row) {
    row.classList.add('out');
    row.timer = setTimeout(() => this.remove(row), FADE_MS);
  }

  // delete a notice; the ones below it slide up into its place (.DeathNotice transition: position .2s ease-out)
  remove(row) {
    clearTimeout(row.timer);
    row.classList.add('gone');
    const below = [];
    for (let n = row.nextElementSibling; n; n = n.nextElementSibling) below.push([n, n.offsetTop]);
    row.remove();
    for (const [n, top] of below) {
      const dy = top - n.offsetTop;
      if (!dy) continue;
      n.classList.add('kf-snap');
      n.style.transform = `translateY(${dy}px)`;
      void n.offsetWidth;
      n.classList.remove('kf-snap');
      n.style.transform = '';
    }
  }

  clear() {
    for (const r of this.root.children) clearTimeout(r.timer);
    this.root.replaceChildren();
  }
}
