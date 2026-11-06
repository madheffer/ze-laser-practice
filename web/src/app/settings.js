// Player settings, kept in this browser.
//
// sens: CS2's own `sensitivity` (yaw degrees per raw mouse count = sensitivity x m_yaw); copy it from your CS2
//   config. m_yaw is CS2's default 0.022 (M_YAW); the FOV is CS2's fixed 90 (FOV). Raw input (no OS
//   acceleration) is requested from the browser so 1 count is 1 count.
// fixedHumans / humans: off = boss HP for you alone (the map's own scaling); on = for `humans` of them, the others
//   being the simulated team (lib/room-rules.js bossHumans; app/rules.js rule('humans') is the count a run uses)
// bossHp: % of that boss HP to actually fight through; autoFire: the other humans shoot the boss
// sfx / music: game sound and CS2's `snd_musicvolume`, 0-1 each
// thirdPerson / tpDist: CS2Fixes' third person (cs2f_thirdperson_distance_default 65, _min 15, _max 150)
// gamma: CS2's r_fullscreen_gamma (ui/gamma.js; CS2's default is 2.2, lower = brighter); 2 here by default
import { $ } from '../lib/dom.js';
import { clamp } from '../lib/math.js';
import { loadJson, saveJson } from '../lib/storage.js';
import { isMapName } from '../lib/paths.js';
import { cleanEditsOff } from '../lib/stripper.js';

export const M_YAW = 0.022; // CS2's m_yaw (and m_pitch) default
export const FOV = 90; // CS2's horizontal FOV at 4:3, fixed

export const DEFAULTS = {
  sens: 2.0, autoBhop: false, god: false, hitboxes: false, timescale: 1,
  humans: 20, fixedHumans: false, bossHp: 100, autoFire: false, fallDamage: false, fullscreen: true,
  healItem: false, // hold the map's heal item (EntWatch / map data: mist's Cleansing Aura, westersand's Heal Magick), E to use it
  // the map's ultima (world/items.js: offliner's Shockwave, westersand's Holy Magick): 'none', 'hold' (yours, E; you
  // then hold nothing else) or 'auto' (a teammate sets it off ultimaAt s after the stage starts)
  ultimaItem: 'none', ultimaAt: 0,
  sfx: 0.5, music: 0.5,
  voice: 0.8, // teammates' voice in a room (app/voice.js), 0-1 like the other two
  perfectTeam: false, // true = the other humans never stop shooting (the old fast kill)
  ping: 0, // simulated round trip in ms (0-500): the map's entities are drawn this late (see render.js record())
  thirdPerson: false, tpDist: 65,
  perfMeter: true, // the FPS (and in a room, ping) readout top right (ui/perf-meter.js)
  fpsUncapped: false, // frames while playing aren't held to the monitor's refresh (app/loop.js scheduleFrame)
  minimap: true, // CS2's radar top left (ui/radar.js), on maps that ship an overview
  gamma: 2,
  // performance (Video): render resolution (x the screen's pixel ratio, capped at 2), MSAA, and the CS2 lighting
  // pieces. Fog / reflections switch instantly; baked lighting + quality apply when a map loads (quality 0 = auto)
  renderScale: 1, msaa: true, fog: true, reflections: true, bakedLighting: true, quality: 0,
  // graphics: the preset those knobs come from (app/graphics.js): Medium (Low on a phone) until one is picked,
  // 'custom' after a hand change. pixelCap: the screen pixel ratio render resolution multiplies (phones are 3x). particleLights: effects
  // lighting the world. graphicsChosen: the player picked a preset (the map list stops asking)
  graphics: 'medium', pixelCap: 2, particleLights: true, bloom: true, graphicsChosen: false,
  streamDistance: 1, // a streamed world (world/stream.js): 1 auto (area, then what can be seen), 2 area only, 0 the whole map
  touchSens: 1, touchCrouch: false, // phone / tablet: look speed multiplier, crouch as a toggle instead of hold
  // GFL's map edits turned off, per map: { <map>: [edit ids] } (lib/stripper.js; ui/stripper-settings.js). Solo only
  stripperOff: {},
};

// Allowed range per numeric setting; a saved value outside it is clamped (the menu can't produce one).
const RANGES = {
  sens: [0.001, 100], timescale: [0.01, 4], humans: [1, 64], bossHp: [1, 100], ping: [0, 500],
  sfx: [0, 1], music: [0, 1], voice: [0, 1], tpDist: [15, 150], gamma: [1, 2.5], renderScale: [0.25, 1], pixelCap: [0.5, 3], quality: [0, 3], streamDistance: [0, 2], touchSens: [0.2, 3], ultimaAt: [0, 300],
};
const DROPPED = new Set(['myaw', 'fov', 'stamina', 'volume']);
// string settings: one of these values
const CHOICES = { graphics: ['low', 'medium', 'high', 'custom'], ultimaItem: ['none', 'hold', 'auto'] };
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
      else if (typeof d === 'string' && CHOICES[k]?.includes(v)) out[k] = v;
      else if (k === 'stripperOff') out[k] = cleanStripperOff(v);
    } else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200)) {
      out[k] = v;
    }
  }
  return out;
}

// { map: [edit ids] } from storage: map names checked, ids cleaned (lib/stripper.js), empty lists dropped, 64 maps at most
function cleanStripperOff(v) {
  const out = Object.create(null);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  for (const [map, ids] of Object.entries(v).slice(0, 64)) {
    const list = isMapName(map) ? cleanEditsOff(ids) : [];
    if (list.length) out[map] = list;
  }
  return { ...out };
}

// Saved settings from before a default changed get it once: v2 turned the team's boss fire off by default.
const SETTINGS_VERSION = 3;
function migrate(saved) {
  if (!saved || typeof saved !== 'object') return {};
  const v = Number.isInteger(saved.settingsVersion) ? saved.settingsVersion : 1;
  const out = { ...saved, settingsVersion: SETTINGS_VERSION };
  if (v < 2) delete out.autoFire;
  // v3 added graphics presets (app/graphics.js): someone who already set a performance knob keeps it, as 'custom'
  if (v < 3 && ['renderScale', 'msaa', 'fog', 'reflections', 'bakedLighting', 'quality', 'streamDistance'].some((k) => k in saved)) {
    out.graphics = 'custom'; out.graphicsChosen = true;
  }
  return out;
}

export const settings = { ...DEFAULTS, ...sanitizeSettings(migrate(loadJson(KEY))), settingsVersion: SETTINGS_VERSION };

export function saveSettings() { saveJson(KEY, settings); }

const PERCENT = new Set(['sfx', 'music', 'voice']);

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
  bind('#fixedhumans', 'fixedHumans');
  // the humans slider only counts with "Boss HP for a full server" on (lib/room-rules.js bossHumans)
  const syncHumans = () => { const h = $('#humans'); if (h) h.disabled = !settings.fixedHumans; };
  syncHumans(); $('#fixedhumans')?.addEventListener('input', syncHumans);
  bind('#autofire', 'autoFire'); bind('#falldmg', 'fallDamage');
  bind('#fullscreen', 'fullscreen'); bind('#perfectteam', 'perfectTeam');
  bind('#thirdperson', 'thirdPerson'); bind('#touchcrouch', 'touchCrouch'); bind('#minimap', 'minimap'); bind('#perfmeter', 'perfMeter'); bind('#fpsuncapped', 'fpsUncapped');
  bind('#touchsens', 'touchSens', (v) => `${v.toFixed(1)}×`);
  bindPair('#ping', '#ping-num', 'ping', 0, 500, onChange);
  bindPair('#tpdist', '#tpdist-num', 'tpDist', 15, 150, onChange);
  bindPair('#gamma', '#gamma-num', 'gamma', 1, 2.5, onChange, 0.05);
  bind('#renderscale', 'renderScale', (v) => `${Math.round(v * 100)}%`); bind('#msaa', 'msaa');
  bind('#fog', 'fog'); bind('#reflections', 'reflections'); bind('#bakedlighting', 'bakedLighting'); bind('#quality', 'quality'); bind('#streamdistance', 'streamDistance');
  // 0-1 like CS2's console values: game sound (the menu's #volume pair, labelled SFX) and `snd_musicvolume`
  bindPair('#volume', '#volume-num', 'sfx', 0, 1, onChange, 0.01);
  bindPair('#musicvol', '#musicvol-num', 'music', 0, 1, onChange, 0.01);
  bindPair('#voicevol', '#voicevol-num', 'voice', 0, 1, onChange, 0.01);
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
