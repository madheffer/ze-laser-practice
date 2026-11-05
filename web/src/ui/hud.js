// The in-game HUD = CS2's base Panorama HUD for your team (humans are CT): money bottom-left, the
// health/ammo bar bottom-centre (hudhealthammocenter: armor + health with its bar, the team circle, ammo clip
// with its bar + reserve), the weapon list bottom-right (hudweaponselection), plus the boss HUD (CS2Fixes
// BossHUD's text) and our stage line top-left. Built from the game's own layout/styles/SVGs
// (`lasers-bake --panorama`); sizes are its 1080p reference px (scaled by --u in hud.css).
import './hud.css';
import { esc, replayClass } from '../lib/dom.js';
import { clamp, clamp01 } from '../lib/math.js';
import { thousands } from '../lib/format.js';

const P = 'panorama/';
const ICONS = {
  ak47: `${P}icons/equipment/ak47.svg`,
  knife: `${P}icons/equipment/knife.svg`,
  armor: `${P}hud/armor.svg`,
  helmet: `${P}hud/armor_helmet.svg`,
  fullauto: `${P}hud/ammo_fullauto.svg`,
  magazine: `${P}hud/ammo_reserve_magazine.svg`,
  ct: `${P}icons/ui/ct_logo_1c.svg`,
  t: `${P}icons/ui/t_logo_1c.svg`,
  cart: `${P}icons/ui/shoppingcart.svg`,
};
// CS2's inventory slots for what a ZE human carries
const WEAPONS = [
  { slot: 1, id: 'gun', name: 'AK-47', icon: ICONS.ak47 },
  { slot: 3, id: 'knife', name: 'Knife', icon: ICONS.knife },
];

const icon = (src, cls = '') => `<i class="pano-icon ${cls}" style="--src:url('${src}')"></i>`;

export class Hud {
  constructor(root, { team = 'ct' } = {}) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-stage"><div class="hud-title"></div><div class="hud-timer"></div><div class="hud-sub"></div></div>
      <div class="hud-boss"></div>
      <div class="hud-spec"></div>
      <div class="hud-countdown" aria-live="polite"></div>
      <div class="hud-money"><span class="money-digits">$0</span>${icon(ICONS.cart, 'money-cart')}</div>
      <div class="hud-ha">
        <div class="hud-ha-half left">
          <div class="hud-ha-stroke left"></div>
          <div class="hud-ha-main">
            <div class="hud-ha-armor">${icon(ICONS.helmet, 'armor-icon')}<span class="hud-ha-armor-label">0</span></div>
            <div class="hud-ha-health">
              <span class="hud-ha-big hp">100</span>
              <div class="hud-bar hp-bar"><i></i></div>
            </div>
          </div>
        </div>
        <div class="hud-ha-center"><div class="ring"></div>${icon(team === 't' ? ICONS.t : ICONS.ct, 'team-logo')}</div>
        <div class="hud-ha-half right">
          <div class="hud-ha-stroke right"></div>
          <div class="hud-wpn-main">
            <div class="hud-wpn-ammo">
              ${icon(ICONS.fullauto, 'mode-icon')}
              <div class="clip-wrap"><span class="hud-ha-big clip">30</span><div class="hud-bar clip-bar"><i></i></div></div>
            </div>
            <span class="hud-wpn-reserve">90</span>
            ${icon(ICONS.magazine, 'reserve-icon')}
          </div>
        </div>
      </div>
      <div class="hud-ws">
        ${WEAPONS.map((w) => `
          <div class="ws-row" data-id="${w.id}">
            <div class="ws-num">${w.slot}</div>
            ${icon(w.icon, 'ws-icon')}
            <div class="ws-name">${esc(w.name)}</div>
          </div>`).join('')}
      </div>`;
    root.dataset.team = team;
    const q = (s) => root.querySelector(s);
    this.el = {
      title: q('.hud-title'), timer: q('.hud-timer'), sub: q('.hud-sub'), boss: q('.hud-boss'), spec: q('.hud-spec'), countdown: q('.hud-countdown'),
      money: q('.money-digits'), ha: q('.hud-ha'), hp: q('.hud-ha-big.hp'), hpBar: q('.hp-bar i'),
      armor: q('.hud-ha-armor'), armorLabel: q('.hud-ha-armor-label'), armorIcon: q('.armor-icon'),
      wpn: q('.hud-wpn-main'), clip: q('.hud-ha-big.clip'), clipBar: q('.clip-bar i'), reserve: q('.hud-wpn-reserve'),
      ws: q('.hud-ws'), rows: [...root.querySelectorAll('.ws-row')],
    };
    this.last = {};
  }

  // The held weapon: its row lights up in the team colour with its name (CS2 keeps the list on screen).
  showWeapons(id) {
    for (const r of this.el.rows) r.classList.toggle('selected', r.dataset.id === id);
    const w = this.el.wpn;
    replayClass(w, 'changed');
  }

  // HUD--health--on-damage: the number and bar jitter
  damaged() {
    for (const el of [this.el.hp, this.el.hpBar.parentElement]) replayClass(el, 'hit');
  }

  update(v) {
    const e = this.el;
    const set = (k, el, val) => { if (this.last[k] !== val) { this.last[k] = val; el.textContent = val; } };
    set('title', e.title, v.title || '');
    set('timer', e.timer, v.timer || '');
    set('sub', e.sub, v.sub || '');
    set('spec', e.spec, v.spectate || ''); // dead in a round: who you are watching
    // the stage's countdown (world/run-engine.js COUNTDOWN): 3, 2, 1 big in the middle, each number popping in
    const cd = v.countdown ? String(v.countdown) : '';
    if (this.last.countdown !== cd) { this.last.countdown = cd; e.countdown.textContent = cd; if (cd) replayClass(e.countdown, 'tick'); }
    set('money', e.money, `$${v.money ?? 16000}`);
    const hp = Math.max(0, Math.ceil(v.hp));
    set('hp', e.hp, v.god ? '∞' : thousands(hp));
    // the bar is health out of 100, like CS2's (anything above 100 shows full)
    const frac = v.god ? 1 : clamp01(hp / 100);
    if (this.last.hpf !== frac) { this.last.hpf = frac; e.hpBar.style.width = `${frac * 100}%`; }
    e.ha.classList.toggle('low-health', !v.god && hp <= 20);
    const armor = v.armor || 0;
    e.armor.classList.toggle('has-armor', armor > 0);
    set('armor', e.armorLabel, String(armor));
    const gun = v.weapon === 'gun';
    e.wpn.classList.toggle('no-ammo', !gun);
    if (gun) {
      set('clip', e.clip, String(v.clip));
      set('reserve', e.reserve, String(v.reserve));
      const cf = clamp01(v.clip / 30);
      if (this.last.cf !== cf) { this.last.cf = cf; e.clipBar.style.width = `${cf * 100}%`; }
      e.wpn.classList.toggle('low-clip', v.clip <= 6);
      e.wpn.classList.toggle('reloading', !!v.reloading);
    }
    if (e.boss.innerHTML !== (v.bossHtml || '')) e.boss.innerHTML = v.bossHtml || '';
  }
}

// Boss HP as CS2Fixes BossHUD shows it in game: its text (name, coloured HP + (pct%), the 14-block bar) goes
// out through SendHudMessage, which CS2 draws in its bottom-centre message box (the show-damage channel).
// The blocks render as one solid bar there; one line per boss when several show.
export function bossHudHtml(list) {
  if (!list.length) return '';
  const col = (p) => (p <= 33 ? '#FF0000' : p <= 66 ? '#FFFF00' : '#00FF00');
  let body;
  if (list.length === 1) {
    const { name, hp, pct } = list[0];
    const fill = clamp(Math.ceil(14 * (pct / 100)), 0, 14) / 14; // BossHUD's 14 blocks
    body = `<div class="bh-name">${esc(name)}</div>`
      + `<div class="bh-hp"><span class="bh-l" style="color:${col(pct)}">${esc(hp)}</span> <span class="bh-m">(${esc(pct)}%)</span></div>`
      + `<div class="bh-bar"><i style="width:${(fill * 100).toFixed(1)}%;background:${col(pct)}"></i></div>`;
  } else {
    body = list.map(({ name, hp, pct }) => `<div class="bh-line">${esc(name)}: <span style="color:${col(pct)}">${esc(hp)}</span> (${esc(pct)}%)</div>`).join('');
  }
  return `<div class="bh-panel">${body}</div>`;
}
