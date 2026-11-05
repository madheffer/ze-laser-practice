// The graphics preset picker (app/graphics.js): Low / Medium / High, shown in two places that stay in step: above
// the map list (the first thing you see when picking a map) and at the top of Settings > Video, above the knobs a
// preset sets. A knob changed by hand shows Custom (no button lit).
//
//   installGraphics({ apply, mapLoaded }) -> { refresh, presetChanged }   apply(): main.js applySettings; mapLoaded(): a map is in (the texture
//                                           tier and baked lighting then wait for the next one)
import './graphics.css';
import { $ } from '../lib/dom.js';
import { settings } from '../app/settings.js';
import { applyPreset, markCustom, defaultPreset, PRESET_NAMES } from '../app/graphics.js';
import { fillSliders } from './controls.js';

const LABEL = { low: 'Low', medium: 'Medium', high: 'High' };
const HINT = {
  low: 'Fastest. For phones and older PCs.',
  medium: 'Quick to load and looks good.',
  high: 'Full detail. Slower to load.',
  custom: 'Custom: changed in Settings › Video.',
};
// the Video controls each preset knob is bound to (app/settings.js bindSettings)
const CONTROLS = { renderScale: '#renderscale', msaa: '#msaa', fog: '#fog', reflections: '#reflections', bakedLighting: '#bakedlighting', quality: '#quality', streamDistance: '#streamdistance' };

export function installGraphics({ apply, mapLoaded = () => false }) {
  // until a preset is picked, the knobs sit at this device's default (and follow it to a new device)
  if (!settings.graphicsChosen && settings.graphics !== 'custom') applyPreset(defaultPreset(), { chosen: false });

  const pickers = [];
  const make = (cls) => {
    const box = document.createElement('div');
    box.className = `gfx ${cls}`;
    // fixed strings only (no map or user data)
    box.innerHTML = `
      <span class="gfx-label" id="gfx-label-${cls}">Graphics</span>
      <div class="seg gfx-seg" role="radiogroup" aria-labelledby="gfx-label-${cls}">
        ${PRESET_NAMES.map((n) => `<button type="button" role="radio" data-preset="${n}" aria-checked="false" tabindex="-1">${LABEL[n]}</button>`).join('')}
      </div>
      <span class="gfx-note" aria-live="polite"></span>`;
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-preset]');
      if (!b) return;
      const later = applyPreset(b.dataset.preset);
      syncControls();
      apply();
      refresh(later.length && mapLoaded() ? 'Texture detail changes on the next map load.' : '');
    });
    // a radiogroup: arrow keys move and pick
    box.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const bs = [...box.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      const next = bs[(i + (ev.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
      next.focus();
      next.click();
    });
    pickers.push(box);
    return box;
  };
  // above the map list (Play), and the top of Settings > Video (after its legend)
  $('#panel-play')?.prepend(make('gfx-play'));
  const video = [...document.querySelectorAll('#panel-settings legend')].find((l) => /video/i.test(l.textContent))?.parentElement;
  if (video) video.insertBefore(make('gfx-video'), video.querySelector('legend')?.nextSibling || null);

  function refresh(note = '') {
    const g = settings.graphics;
    for (const box of pickers) {
      const bs = [...box.querySelectorAll('button')];
      for (const b of bs) {
        const on = b.dataset.preset === g;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      if (!bs.some((b) => b.tabIndex === 0)) bs[1].tabIndex = 0; // Custom: Medium takes the focus stop
      box.querySelector('.gfx-note').textContent = note || HINT[g] || '';
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

  for (const id of Object.values(CONTROLS)) $(id)?.addEventListener('input', () => { markCustom(); refresh(); });

  syncControls();
  refresh();
  // presetChanged: a preset set from code (app/perf.js), the controls and pickers follow
  return { refresh, presetChanged: () => { syncControls(); refresh(); } };
}
