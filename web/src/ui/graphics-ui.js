// The graphics preset picker (app/graphics.js): one Auto / Low / Medium / High control, shown in two places that
// stay in step: above the map list (the first thing you see when picking a map; until you have chosen it says what
// this device should use) and at the top of Settings > Video, above the knobs a preset sets. A knob changed by hand
// shows the preset as Custom.
//
//   installGraphics({ gl, apply, mapLoaded })   apply(): main.js applySettings; mapLoaded(): a map is in (the tier
//                                               and baked lighting then wait for the next one)
import './graphics.css';
import { $ } from '../lib/dom.js';
import { settings } from '../app/settings.js';
import { applyPreset, markCustom, recommended, recommendedReason, PRESET_KEYS } from '../app/graphics.js';
import { fillSliders } from './controls.js';

const LABEL = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };
const HINT = {
  low: 'Fastest: low textures, 1x pixels, no reflections or effect lights. For phones and old PCs.',
  medium: 'Medium textures, no anti-aliasing, a bit under full resolution.',
  high: 'Full textures, lighting, reflections and anti-aliasing.',
};
// the Video controls each preset knob is bound to (app/settings.js bindSettings)
const CONTROLS = { renderScale: '#renderscale', msaa: '#msaa', fog: '#fog', reflections: '#reflections', bakedLighting: '#bakedlighting', quality: '#quality', streamDistance: '#streamdistance' };

export function installGraphics({ gl, apply, mapLoaded = () => false }) {
  // 'auto' keeps the knobs where this device's preset puts them (a new screen or a new browser: re-picked at start)
  if (settings.graphics === 'auto') applyPreset('auto', gl, { chosen: false });

  const pickers = [];
  const make = (where, cls) => {
    if (!where) return;
    const box = document.createElement('div');
    box.className = `gfx ${cls}`;
    const rec = recommended(gl);
    // built from fixed strings only (no map or user data)
    box.innerHTML = `
      <span class="gfx-label" id="gfx-label-${cls}">Graphics</span>
      <div class="seg" role="radiogroup" aria-labelledby="gfx-label-${cls}">
        ${['auto', 'low', 'medium', 'high'].map((n) => `<button type="button" role="radio" data-preset="${n}" aria-checked="false">${LABEL[n]}${n === 'auto' ? ` <small>(${LABEL[rec]})</small>` : ''}</button>`).join('')}
      </div>
      <span class="gfx-note" aria-live="polite"></span>`;
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-preset]');
      if (!b) return;
      const later = applyPreset(b.dataset.preset, gl);
      syncControls();
      apply();
      refresh(later.length && mapLoaded() ? 'Texture detail and lighting change on the next map load.' : '');
    });
    // arrow keys move along the group (a radiogroup)
    box.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const bs = [...box.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      bs[(i + (ev.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length].focus();
    });
    where.prepend(box);
    pickers.push(box);
  };
  // above the map list (Play), and the top of Settings > Video (after its legend)
  make($('#panel-play'), 'gfx-play');
  const video = [...document.querySelectorAll('#panel-settings legend')].find((l) => /video/i.test(l.textContent))?.parentElement;
  if (video) { make(video, 'gfx-video'); video.insertBefore(pickers.at(-1), video.querySelector('legend')?.nextSibling || null); }

  function refresh(note = '') {
    const g = settings.graphics, rec = recommended(gl);
    for (const box of pickers) {
      for (const b of box.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.preset === g));
      const shown = g === 'auto' ? rec : g;
      const text = note
        || (g === 'custom' ? 'Custom: you changed a setting in Video.'
          : !settings.graphicsChosen ? `Recommended for this device (${recommendedReason(gl)}): ${LABEL[rec]}. ${HINT[rec]}`
            : HINT[shown] || '');
      box.querySelector('.gfx-note').textContent = text;
      box.classList.toggle('unchosen', !settings.graphicsChosen);
    }
  }

  // the Video controls show what a preset just set (their own listeners only run on the player's input)
  function syncControls() {
    for (const [key, id] of Object.entries(CONTROLS)) {
      const el = $(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!settings[key]; else el.value = settings[key];
    }
    const rs = $('#renderscale-v');
    if (rs) rs.textContent = `${Math.round(settings.renderScale * 100)}%`;
    fillSliders();
  }

  // a knob changed by hand: Custom (unless it lands back on the preset exactly)
  for (const id of Object.values(CONTROLS)) $(id)?.addEventListener('input', () => { markCustom(gl); refresh(); });

  syncControls();
  refresh();
  return { refresh, keys: PRESET_KEYS };
}
