// The menu, which doubles as the pause screen: a top bar (title, Play | Settings tabs, Maps / current map,
// Resume / Restart), the Play tab's two views (the map picker, ui/maps.js; then the picked map's stages,
// ui/stage-list.js) and the settings (index.html; app/settings.js binds them by id).
import './menu.css';
import { S, G } from '../app/state.js';
import { $ } from '../lib/dom.js';
import { syncPlayState } from '../app/input.js';
import { renderStageList } from './stage-list.js';

export class Menu {
  constructor({ onPick, onResume, onRestart, onMaps }) {
    this.onPick = onPick;
    this.view = 'maps';
    $('#resume').addEventListener('click', () => onResume());
    $('#restart').addEventListener('click', () => onRestart());
    $('#maps-back').addEventListener('click', () => onMaps());
    const select = installTabs($('#menu .tabs'));
    // asking for a tab means the full menu, not the pause screen (ui/pause.js)
    this.selectTab = (tab) => { this.mode = 'full'; select(tab); };
    this.mode = 'pause'; // a paused run shows the pause screen until you ask for stages or settings
  }

  // The Play tab's view: 'maps' (the picker) or 'stages' (the loaded map's parts). Picking a view also brings
  // the Play tab forward.
  show(view) {
    this.view = view;
    $('#maps').hidden = view !== 'maps';
    $('#stages').hidden = view !== 'stages';
    $('#maps-back').hidden = view !== 'stages';
    $('#map-name').textContent = view === 'stages' && S.map ? S.map.name : '';
    this.selectTab($('#tab-play'));
    $('#menu .tab-panels').scrollTop = 0;
  }

  // Show the menu when paused (and no end card or room screen is up); Resume only when there is a run to go back
  // to. A paused run gets the pause screen (ui/pause.js) instead, until you open stages or settings from it. This
  // runs on every pause / unpause, so the touch controls follow it too (syncPlayState).
  update() {
    const live = !!S.run && !S.run.done;
    $('#resume').hidden = !live;
    $('#restart').hidden = !S.run;
    // back to the pause screen once you're in again, and for every new run (loading its map opens the stage list)
    if (!S.paused || S.run !== this.modeRun) { this.mode = 'pause'; this.modeRun = S.run; }
    const show = S.paused && !G.overlay?.open && !G.room?.open;
    const card = show && live && this.mode === 'pause' && !!G.pauseScreen;
    G.pauseScreen?.show(card);
    const menu = $('#menu');
    const opening = show && !card && menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !show || card);
    $('#hud').classList.toggle('hidden', !S.run);
    syncPlayState();
    if (opening && live) $('#resume').focus({ preventScroll: true });
  }

  // The loaded map's stages (ui/stage-list.js): a header, part chips, a grid of stage cards per part.
  build(info = {}) {
    renderStageList(info, (i, mode) => this.onPick(i, mode));
  }
}

// WAI-ARIA tabs: click, or arrow keys / Home / End, select a tab and show its panel.
function installTabs(list) {
  const tabs = [...list.querySelectorAll('[role=tab]')];
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  };
  for (const t of tabs) t.addEventListener('click', () => select(t, false));
  list.addEventListener('keydown', (ev) => {
    const at = tabs.indexOf(document.activeElement);
    if (at < 0) return;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    select(tabs[(to + tabs.length) % tabs.length], true);
  });
  return (tab) => select(tab, false);
}
