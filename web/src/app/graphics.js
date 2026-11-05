// Graphics presets: one choice (Low / Medium / High) that sets every performance knob at once.
// The knobs themselves stay in Settings > Video; changing one by hand makes the preset 'custom'.
//
//   graphics: 'low' | 'medium' | 'high' | 'custom'   (settings.graphics)
//   applyPreset(name)   writes the preset's knobs into settings, saves, and returns what needs a map reload
//   defaultPreset()     what a player starts on until they pick: Medium (a quick load), Low on a phone or tablet
//
// What each knob costs, biggest first: render resolution (pixels drawn, x the screen's pixel ratio), the texture /
// lightmap tier (download, decode, GPU memory), MSAA (4 samples a pixel into a half-float target), particle lights
// (a loop per pixel over up to 16 lights), reflections (the cubemaps in view), fog, how much of the world streams in.
// Low is the fast build for phones and old PCs: about a sixth of High's pixels on a phone, nothing optional per pixel.
import { settings, saveSettings } from './settings.js';

export const PRESET_NAMES = ['low', 'medium', 'high'];

export const PRESETS = {
  high: {
    quality: 3, renderScale: 1, pixelCap: 2, msaa: true, fog: true, reflections: true, bakedLighting: true,
    particleLights: true, streamDistance: 1, bloom: true,
  },
  medium: {
    quality: 2, renderScale: 0.85, pixelCap: 1.5, msaa: false, fog: true, reflections: true, bakedLighting: true,
    particleLights: true, streamDistance: 1, bloom: true,
  },
  low: {
    quality: 1, renderScale: 0.75, pixelCap: 1, msaa: false, fog: false, reflections: false, bakedLighting: true,
    particleLights: false, streamDistance: 2, bloom: false,
  },
};

// the knobs a preset owns; a hand change to any of them makes the preset 'custom'
export const PRESET_KEYS = Object.keys(PRESETS.high);
// knobs that only apply when a map loads (the rest apply at once)
const ON_MAP_LOAD = new Set(['quality', 'bakedLighting']);

// a phone or tablet: touch first, or a small screen
export function isMobile() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarse || (globalThis.screen ? Math.min(screen.width, screen.height) < 600 : false);
}

// what a player starts on until they pick one
export const defaultPreset = () => (isMobile() ? 'low' : 'medium');

// Write a preset's knobs into settings. Returns the knobs that changed and only apply on the next map load.
// chosen: the player picked it (false: the default, set at start until they do)
export function applyPreset(name, { chosen = true } = {}) {
  const p = PRESETS[name];
  if (!p) return [];
  const later = [];
  for (const [k, v] of Object.entries(p)) {
    if (settings[k] !== v && ON_MAP_LOAD.has(k)) later.push(k);
    settings[k] = v;
  }
  settings.graphics = name;
  if (chosen) settings.graphicsChosen = true;
  saveSettings();
  return later;
}

// A knob changed by hand: the preset no longer describes the settings (unless it lands back on it exactly)
export function markCustom() {
  const p = PRESETS[settings.graphics];
  if (p && PRESET_KEYS.every((k) => settings[k] === p[k])) return;
  settings.graphics = 'custom';
  saveSettings();
}
