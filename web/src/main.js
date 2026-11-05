// ZE Laser Practice: pick a map and a stage, spawn where the lasers are, and the map's own entity logic runs.
// This file only boots and wires the pieces:
//   app/     state, settings, session (one attempt), loop (frames + ticks), input, bosses, endless, records
//   ui/      menu (the pause screen + stage picker), hud (CS2 Panorama HUD), overlay (end cards)
//   world/   entities (the map's I/O logic); collision, movement, render, assets
//   audio.js, viewmodel.js (+ fp/): sound and the first-person weapon
import { loadMapIndex, loadMap, loadScenarios } from './world/assets.js';
import { CollisionWorld } from './world/collision.js';
import { Player, CS } from './world/movement.js';
import { Renderer } from './world/render.js';
import { parseVec } from './world/entities/index.js';
import { GameAudio } from './audio/audio.js';
import { Viewmodel } from './weapons/viewmodel.js';
import { PlayerBody } from './world/body.js';
import { S, G, $, log } from './app/state.js';
import { replayClass } from './lib/dom.js';
import { isMapName } from './lib/paths.js';
import { settings, bindSettings, FOV } from './app/settings.js';
import { rule } from './app/rules.js';
import { startScenario, endRun } from './app/session.js';
import { frame, step, simulate, resetClock, updateHud } from './app/loop.js';
import { installInput, enterGame, clearKeys } from './app/input.js';
import { onShot } from './app/bosses.js';
import { Hud } from './ui/hud.js';
import { Overlay } from './ui/overlay.js';
import { Menu } from './ui/menu.js';
import { Killfeed } from './ui/killfeed.js';
import { Lobby } from './ui/lobby.js';
import { Peers } from './world/peers.js';
import { net, lobby, installCoop, hostStart, abortRound } from './app/coop.js';

const canvas = $('#view');
G.renderer = new Renderer(canvas);
G.audio = new GameAudio();
G.vm = new Viewmodel(G.renderer.renderer);
G.body = new PlayerBody(G.renderer.scene, { log }); // third person (!tp): your own CT
G.hud = new Hud($('#hud'));
G.overlay = new Overlay($('#overlay'));
G.killfeed = new Killfeed($('#killfeed'));
G.peers = new Peers(G.renderer.scene, { log }); // the other players in a co-op / versus round
G.simulate = simulate;

// ---- pause / resume
G.pause = () => {
  S.paused = true;
  G.vm.trigger(false);
  G.vm.trigger2(false);
  clearKeys();
  G.audio.pause();
  G.menu.update();
};
G.unpause = () => {
  S.paused = false;
  resetClock();
  G.audio.resume();
  G.menu.update();
};
G.resume = () => { if (S.run && !S.run.done) enterGame(canvas); };
// Start (or restart) a stage and drop straight into it: the lock + fullscreen requests go out first, inside the
// click, then the stage is built (pointerlockchange unpauses once it lands).
// In a room the host's pick starts the round for everyone (app/coop.js); a guest waits for it.
G.play = (i, mode = 'normal') => {
  if (net.inRoom) {
    if (!net.isHost) { G.lobby.note('The host picks the stage'); return; }
    enterGame(canvas);
    hostStart(i, mode);
    return;
  }
  S.mp = null;
  enterGame(canvas);
  startScenario(i, mode);
};

// ---- small HUD effects
// light an element's `on` class for `ms` (restarting its animation if it is already on)
const pulse = (sel, ms) => {
  let t = 0;
  return () => {
    const el = $(sel);
    replayClass(el, 'on');
    clearTimeout(t); t = setTimeout(() => el.classList.remove('on'), ms);
  };
};
G.hitmark = pulse('#hitmarker', 120);
G.flash = pulse('#flash', 250);

G.renderer.setFov(FOV); // CS2's fixed 90
function applySettings() {
  G.renderer.showHitboxes = settings.hitboxes;
  G.renderer.delay = settings.ping / 1000;
  if (S.engine) S.engine.humans = rule('humans');
  G.audio.setVolumes({ sfx: settings.sfx, music: settings.music });
}

// ---- weapons (CS2: 1 primary, 3 knife, Q last weapon, R reload)
function weapon(w) {
  if (G.vm.weapon === w) return;
  G.vm.setWeapon(w);
  G.hud.showWeapons(w);
  G.audio.play(w === 'gun' ? 'gun.deploy' : 'knife.deploy');
}
G.vm.onShot = onShot;
G.vm.onReload = () => {
  // the AK reload's own sounds, on its clip timing
  for (const [t, s] of [[0.35, 'gun.clipout'], [1.45, 'gun.clipin'], [2.05, 'gun.boltpull']]) setTimeout(() => { if (G.vm.reloading) G.audio.play(s); }, t * 1000);
};

G.menu = new Menu({
  onPick: (i, mode) => G.play(i, mode),
  onResume: () => G.resume(),
  onRestart: () => G.play(S.scenarioIndex, S.run?.mode),
});

installInput(canvas, {
  pause: G.pause, unpause: G.unpause, resume: G.resume, applySettings,
  weapon,
  lastWeapon: () => { const before = G.vm.weapon; G.vm.swapLast(); if (G.vm.weapon !== before) { G.hud.showWeapons(G.vm.weapon); G.audio.play(G.vm.weapon === 'gun' ? 'gun.deploy' : 'knife.deploy'); } },
  reload: () => G.vm.reload(),
  restart: () => { if (net.inRoom) { if (net.isHost) hostStart(S.scenarioIndex, S.run?.mode); } else startScenario(S.scenarioIndex, S.run?.mode); },
});

async function selectMap(name) {
  $('#status').textContent = `loading ${name}...`;
  abortRound(); // the host leaving a live round for another map ends it for everyone
  endRun();
  S.map = await loadMap(name, (s) => { $('#status').textContent = `loading ${name}: ${s}`; });
  G.renderer.setWorld(S.map.world);
  S.world = new CollisionWorld(S.map.collision);
  S.player = new Player(S.world);
  G.audio.loadMap(name, S.map.version).catch((e) => log(`audio: ${e.message || e}`));
  S.scenarios = (await loadScenarios(name)).scenarios || [];
  G.menu.build();
  net.setMap(name); // a room owner's map shows in the public room list
  $('#status').textContent = `${name}: ${S.map.collision.length / 9} collision triangles, ${Object.keys(S.map.entities.lumps).length} entity lumps`;
  // a still view of the map behind the menu; nothing runs until a stage is picked
  const ct = S.map.entities.lumps.default_ents?.find((d) => d.kv.classname === 'info_player_counterterrorist');
  S.player.teleport(ct ? parseVec(ct.kv.origin) : [0, 0, 0], 0);
  G.menu.update();
}

async function init() {
  bindSettings(applySettings);
  applySettings();
  G.vm.load().catch((e) => log(`viewmodel: ${e.message || e}`));
  G.body.load().catch((e) => log(`body: ${e.message || e} (third person shows no body)`));
  const idx = await loadMapIndex().catch(() => ({ maps: [] }));
  // map names become fetch paths (maps/<name>/...): only well-formed ones, from the index or ?map=
  const maps = (Array.isArray(idx?.maps) ? idx.maps : []).filter((m) => isMapName(m?.name));
  const sel = $('#map');
  for (const m of maps) {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = `${m.title || m.name}${m.scenarios ? ` (${m.scenarios})` : ''}`;
    sel.append(o);
  }
  sel.addEventListener('change', () => selectMap(sel.value));
  const asked = new URLSearchParams(location.search).get('map');
  if (asked && !isMapName(asked)) log('?map= ignored: not a map name');
  const want = (isMapName(asked) ? asked : null) || maps.find((m) => m.scenarios)?.name || maps[0]?.name;
  if (want) { sel.value = want; await selectMap(want); }
}

// a round's start can bring the host's map: load it the way picking it does
G.selectMap = async (name) => {
  if (!isMapName(name)) throw new Error('bad map name');
  const sel = $('#map');
  if (![...sel.options].some((o) => o.value === name)) throw new Error('not on this server');
  sel.value = name;
  await selectMap(name);
};
G.lobby = new Lobby($('#lobby'), {
  net, state: lobby, getMap: () => S.map?.name || '',
  mapTitle: (name) => S.mapIndex?.find((m) => m.name === name)?.title || name,
});
installCoop();

// console handle for debugging and automated checks
window.__lasers = {
  get engine() { return S.engine; }, get player() { return S.player; }, get run() { return S.run; }, get world() { return S.world; },
  get paused() { return S.paused; }, get vm() { return G.vm; }, get body() { return G.body; }, get audio() { return G.audio; }, get overlayOpen() { return G.overlay.open; },
  startScenario, settings, scenarios: () => S.scenarios,
  coop: { net, lobby, get round() { return S.mp; }, peers: G.peers },
  // run the simulation n seconds synchronously (tests; a hidden tab gets no animation frames)
  advance(seconds) { for (let i = 0; i < Math.round(seconds / CS.tick); i++) { if (!S.run || S.run.done) break; step(); } updateHud(); },
};

init().catch((e) => { $('#status').textContent = String(e); console.error(e); });
requestAnimationFrame(frame);
