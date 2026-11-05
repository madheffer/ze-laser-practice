// Player settings, kept in this browser.
//
// sens: CS2's own `sensitivity` (yaw degrees per raw mouse count = sensitivity x m_yaw); copy it from your CS2
//   config. m_yaw is CS2's default 0.022 (M_YAW); the FOV is CS2's fixed 90 (FOV). Raw input (no OS
//   acceleration) is requested from the browser so 1 count is 1 count.
// humans: how many humans you stand in for (boss HP adds and team damage scale with it)
// bossHp: % of that boss HP to actually fight through; autoFire: the other humans shoot the boss
// sfx / music: game sound and CS2's `snd_musicvolume`, 0-1 each
// thirdPerson / tpDist: CS2Fixes' third person (cs2f_thirdperson_distance_default 65, _min 15, _max 150)
import { $ } from '../lib/dom.js';
import { clamp } from '../lib/math.js';
import { loadJson, saveJson } from '../lib/storage.js';

export const M_YAW = 0.022; // CS2's m_yaw (and m_pitch) default
export const FOV = 90; // CS2's horizontal FOV at 4:3, fixed

export const DEFAULTS = {
  sens: 2.0, autoBhop: false, god: false, hitboxes: false, timescale: 1,
  humans: 20, bossHp: 100, autoFire: true, fallDamage: false, fullscreen: true,
  healItem: false, // hold the map's heal item (EntWatch / map data: mist's Cleansing Aura, westersand's Heal Magick), E to use it
  sfx: 0.5, music: 0.5,
  perfectTeam: false, // true = the other humans never stop shooting (the old fast kill)
  ping: 0, // simulated round trip in ms (0-500): the map's entities are drawn this late (see render.js record())
  thirdPerson: false, tpDist: 65,
  touchSens: 1, touchCrouch: false, // phone / tablet: look speed multiplier, crouch as a toggle instead of hold
};

// Allowed range per numeric setting; a saved value outside it is clamped (the menu can't produce one).
const RANGES = {
  sens: [0.001, 100], timescale: [0.01, 4], humans: [1, 64], bossHp: [1, 100], ping: [0, 500],
  sfx: [0, 1], music: [0, 1], tpDist: [15, 150], touchSens: [0.2, 3],
};
const DROPPED = new Set(['myaw', 'fov', 'stamina', 'volume']);
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

const KEY = 'lasers.settings';

// What localStorage holds is untrusted: keep each known setting only if it has the default's type (numbers
// finite and in range), migrate the old `volume` into `sfx`, keep unknown keys only as plain primitives.
export function sanitizeSettings(saved) {
  const out = {};
  if (saved.sfx === undefined && saved.volume !== undefined) saved = { ...saved, sfx: saved.volume };
  for (const [k, v] of Object.entries(saved)) {
    if (FORBIDDEN.has(k) || DROPPED.has(k)) continue;
    if (Object.hasOwn(DEFAULTS, k)) {
      const d = DEFAULTS[k];
      if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v;
      else if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = RANGES[k] ? clamp(v, ...RANGES[k]) : v;
    } else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200)) {
      out[k] = v;
    }
  }
  return out;
}

export const settings = { ...DEFAULTS, ...sanitizeSettings(loadJson(KEY)) };

export function saveSettings() { saveJson(KEY, settings); }

const PERCENT = new Set(['sfx', 'music']);

// Wire every settings control in the menu to `settings`; onChange runs after each edit.
export function bindSettings(onChange) {
  const bind = (id, key, label) => {
    const el = $(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!settings[key]; else el.value = settings[key];
    const out = $(id + '-v');
    const show = () => {
      if (!out) return;
      out.textContent = label ? label(settings[key]) : PERCENT.has(key) ? `${Math.round(settings[key] * 100)}%` : settings[key];
    };
    show();
    el.addEventListener('input', () => {
      if (el.type === 'checkbox') settings[key] = el.checked;
      else { const v = Number(el.value); if (Number.isFinite(v)) settings[key] = RANGES[key] ? clamp(v, ...RANGES[key]) : v; }
      show();
      saveSettings();
      onChange();
    });
  };
  bind('#sens', 'sens'); bind('#bhop', 'autoBhop');
  bind('#god', 'god'); bind('#hitboxes', 'hitboxes'); bind('#humans', 'humans'); bind('#bosshp', 'bossHp');
  bind('#autofire', 'autoFire'); bind('#falldmg', 'fallDamage');
  bind('#fullscreen', 'fullscreen'); bind('#perfectteam', 'perfectTeam');
  bind('#thirdperson', 'thirdPerson'); bind('#touchcrouch', 'touchCrouch');
  bind('#touchsens', 'touchSens', (v) => `${v.toFixed(1)}×`);
  bindPair('#ping', '#ping-num', 'ping', 0, 500, onChange);
  bindPair('#tpdist', '#tpdist-num', 'tpDist', 15, 150, onChange);
  // 0-1 like CS2's console values: game sound (the menu's #volume pair, labelled SFX) and `snd_musicvolume`
  bindPair('#volume', '#volume-num', 'sfx', 0, 1, onChange, 0.01);
  bindPair('#musicvol', '#musicvol-num', 'music', 0, 1, onChange, 0.01);
}

// A slider with an editable number beside it: drag for coarse, type for exact (e.g. 194, or 0.35).
function bindPair(rangeId, numId, key, min, max, onChange, step = 1) {
  const range = $(rangeId), num = $(numId);
  if (!range || !num) return;
  const snap = (v) => clamp(Math.round(v / step) * step, min, max);
  const dp = step < 1 ? String(step).split('.')[1].length : 0;
  const show = () => { range.value = settings[key]; num.value = Number(settings[key]).toFixed(dp); };
  show();
  const commit = (v) => { settings[key] = snap(v); show(); saveSettings(); onChange(); };
  range.addEventListener('input', () => commit(Number(range.value)));
  num.addEventListener('change', () => { const v = Number(num.value); commit(Number.isFinite(v) ? v : settings[key]); });
  num.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') num.blur();
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') { ev.preventDefault(); commit(settings[key] + (ev.key === 'ArrowUp' ? 1 : -1) * step * (ev.shiftKey ? 10 : 1)); }
  });
}

// Keep a checkbox in sync when a hotkey flips its setting.
export function setToggle(key, id, value) {
  settings[key] = value;
  const el = $(id);
  if (el) el.checked = value;
  saveSettings();
}
