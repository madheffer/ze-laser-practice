// Shared game state and services. One object each, so modules can import them instead of passing a dozen
// arguments around. main.js fills G at boot; session.js / loop.js own S.

// S: what changes during play
export const S = {
  map: null, // loaded map assets (assets.js)
  world: null, // CollisionWorld
  player: null, // Player (movement.js)
  engine: null, // EntityEngine, null until a stage is picked
  mapIndex: [], // maps/index.json's maps (validated names), for the map picker
  scenarios: [],
  scenario: null,
  scenarioIndex: -2, // -2 nothing picked, -1 free roam
  run: null, // the current attempt (session.js)
  paused: true,
  locked: false, // pointer lock held
};

// G: long-lived services (renderer, audio, viewmodel, HUD, overlay, menu)
export const G = {};

// $ and esc live in lib/dom.js; re-exported here because ui/menu.js (and others) import them from state.js
export { $, esc } from '../lib/dom.js';
import { $ } from '../lib/dom.js';

export const log = (m) => { const el = $('#log'); if (el) el.textContent = (m + '\n' + el.textContent).slice(0, 4000); };
