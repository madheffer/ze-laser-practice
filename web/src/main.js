// ZE Laser Practice: pick a map and a stage, spawn where the lasers are, and the map's own entity logic runs.
// This file only boots and wires the pieces:
//   app/     state, settings, session (one attempt), loop (frames + ticks), input, bosses, endless, records
//   ui/      menu (the pause screen + stage picker), hud (CS2 Panorama HUD), overlay (end cards)
//   world/   entities (the map's I/O logic); collision, movement, render, assets
//   audio.js, viewmodel.js (+ fp/): sound and the first-person weapon
import { loadMapIndex, loadMap, loadScenarios } from './world/assets.js';
import { loadImpacts } from './world/impacts.js';
import { CollisionWorld } from './world/collision.js';
import { buildBVH } from './world/bvh-build.js';
import { particleTrace } from './fx/trace.js';
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
import { installGraphics } from './ui/graphics-ui.js';
import { rule } from './app/rules.js';
import { startScenario, endRun } from './app/session.js';
import { frame, step, simulate, resetClock, updateHud } from './app/loop.js';
import { installInput, enterGame, clearKeys } from './app/input.js';
import { onShot } from './app/bosses.js';
import { Hud } from './ui/hud.js';
import { Overlay } from './ui/overlay.js';
import { Menu } from './ui/menu.js';
import { MapPicker } from './ui/maps.js';
import { Radar } from './ui/radar.js';
import { ItemHud } from './ui/itemhud.js';
import { Killfeed } from './ui/killfeed.js';
import { Lobby } from './ui/lobby.js';
import { Home } from './ui/home.js';
import { RoomScreen } from './ui/room.js';
import { PauseScreen } from './ui/pause.js';
import { LoadingScreen } from './ui/loading.js';
import { bootDone, bootFailed } from './ui/boot.js';
import { stepProgress } from './app/readiness.js';
import { installReplays, bootReplays, replayKey, hasReplayLink } from './app/replay-boot.js';
import { Peers } from './world/peers.js';
import { usableHeals } from './world/items.js';
import { applyGamma } from './ui/gamma.js';
import { loadLightmaps } from './world/lightmaps.js';
import { WorldStream } from './world/stream.js';

// what of a streamed world loads (settings.streamDistance: 1 auto = your area, then what the map lets you see;
// 2 your area only; 0 the whole map)
const streamMode = () => (settings.streamDistance === 0 ? 'all' : settings.streamDistance === 2 ? 'area' : 'auto');
import { net, lobby, installCoop, hostStart, abortRound } from './app/coop.js';

const canvas = $('#view');
G.renderer = new Renderer(canvas);
G.audio = new GameAudio();
G.vm = new Viewmodel(G.renderer.renderer);
const litByParticles = (root) => G.renderer.lighting.patchDynamic(root); // the particle lights (world/lighting.js)
G.body = new PlayerBody(G.renderer.scene, { log, onModel: litByParticles, lazy: true }); // third person (!tp): your own CT
G.hud = new Hud($('#hud'));
G.radar = new Radar($('#hud')); // the minimap (CS2's own radar) and the EntWatch-style item list under it
G.itemHud = new ItemHud($('#hud'));
G.overlay = new Overlay($('#overlay'));
G.loading = new LoadingScreen($('#loading')); // a picked stage, until its clock starts
G.killfeed = new Killfeed($('#killfeed'));
G.peers = new Peers(G.renderer.scene, { log, onModel: litByParticles }); // the other players in a co-op / versus round
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
  G.home?.hide(); // a run (yours, or a round the host started) takes over from the home page
  resetClock();
  G.audio.resume();
  G.menu.update();
};
G.resume = () => { if (S.run && !S.run.done) enterGame(canvas); };
// Start (or restart) a stage and drop straight into it: the lock + fullscreen requests go out first, inside the
// click, then the stage is built (pointerlockchange unpauses once it lands).
// In a room the host's pick starts the round for everyone (app/coop.js); a guest waits for it.
// In a room, a stage picked from the menu becomes the room's next round: back to the room screen (ui/room.js), where
// the owner starts it.
G.play = (i, mode = 'normal') => {
  if (net.inRoom) {
    if (!net.isHost) { G.lobby.note('The host picks the stage'); return; }
    if (S.map) net.pick(S.map.name, i >= 0 ? S.scenarios[i]?.id ?? null : null, mode);
    G.room.comeBack();
    return;
  }
  S.mp = null;
  beginStageLoading(i);
  enterGame(canvas);
  loadStage().then(() => {
    if (!S.map?.loaded) { G.loading.close(false); return; } // another map was picked meanwhile
    startScenario(i, mode);
    // the lock landed while the map loaded: play on; on touch, enterGame again (it unpauses once a run exists)
    if (S.locked) G.unpause(); else enterGame(canvas);
  }, (e) => { G.loading.close(false); log(`stage: ${e.message || e}`); G.pause(); });
};
// the loading screen (ui/loading.js) from the click on: at once for a map still to load; on a loaded one, only if the
// stage isn't ready within a few frames (no flash on a quick restart)
function beginStageLoading(i) {
  if (!S.map) return;
  G.loading.begin(S.map.name, i >= 0 ? S.scenarios[i]?.id : null, S.map.loaded ? 300 : 0);
}

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
  applyGamma(settings.gamma); // r_fullscreen_gamma (ui/gamma.js)
  G.renderer.setQuality({ renderScale: settings.renderScale, msaa: settings.msaa, pixelCap: settings.pixelCap });
  G.renderer.lighting.setOptions({ fog: settings.fog, reflections: settings.reflections, particleLights: settings.particleLights });
  G.stream?.setMode(streamMode());
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
  S.mp?.reloaded(); // a round's server checks your rounds against the reload
  // the AK reload's own sounds, on its clip timing
  for (const [t, s] of [[0.35, 'gun.clipout'], [1.45, 'gun.clipin'], [2.05, 'gun.boltpull']]) setTimeout(() => { if (G.vm.reloading) G.audio.play(s); }, t * 1000);
};

// Restart: solo, the same stage again; in a room, the owner restarts the round for everyone
function restartRun() {
  if (net.inRoom) { if (net.isHost) { enterGame(canvas); hostStart(S.scenarioIndex, S.run?.mode); } return; }
  G.play(S.scenarioIndex, S.run?.mode);
}
G.hostStart = (i, mode) => { enterGame(canvas); hostStart(i, mode); }; // app/coop-end.js's Play again
G.enterGame = () => enterGame(canvas); // ui/room.js's Start round (inside the click)

G.menu = new Menu({
  onPick: (i, mode) => G.play(i, mode),
  onResume: () => G.resume(),
  onRestart: () => restartRun(),
  onMaps: () => showMaps(),
});
G.maps = new MapPicker($('#maps'), { onPick: (name) => openMap(name) });
function showMaps() { G.maps.build(S.mapIndex, S.map?.name); G.menu.show('maps'); G.maps.focusCurrent(); }

installInput(canvas, {
  pause: G.pause, unpause: G.unpause, resume: G.resume, applySettings,
  weapon,
  lastWeapon: () => { const before = G.vm.weapon; G.vm.swapLast(); if (G.vm.weapon !== before) { G.hud.showWeapons(G.vm.weapon); G.audio.play(G.vm.weapon === 'gun' ? 'gun.deploy' : 'knife.deploy'); } },
  reload: () => G.vm.reload(),
  replayKey, // a replay's keys (app/replay.js)
  restart: () => restartRun(),
});

// Picking a map loads only what its stage list needs (the scenario file, and the map's items from index.json for the
// heal option); the world, collision, entities, lighting and sounds load when a stage is picked (loadStage), and then
// only the area around that stage is streamed in first (world/stream.js). The URL keeps ?map=<name>.
let loadingMap = null;
// fromRound: the host's round start brought this map (a guest can't leave a live round for another map)
async function openMap(name, fromRound = false) {
  if (!isMapName(name) || loadingMap) return;
  if (!fromRound && S.mp && !S.mp.ended && S.run && !S.run.done && !net.isHost && S.map?.name !== name) { G.lobby.note('Leave the room to play another map'); return; }
  if (S.map?.name === name) { G.menu.show('stages'); return; }
  loadingMap = name;
  try {
    G.maps.loading(name, 'stages');
    if (!fromRound) G.loading.close(false); // a stage of the last map still loading is dropped (a round's is this map's)
    abortRound(); // the host leaving a live round for another map ends it for everyone
    endRun();
    unloadWorld();
    const info = S.mapIndex.find((m) => m.name === name) || {};
    const file = await loadScenarios(name);
    S.scenarios = Array.isArray(file.scenarios) ? file.scenarios : [];
    S.map = { name, loaded: false, items: Array.isArray(info.items) ? info.items : [] };
    G.menu.build({ title: file.title || info.title, description: file.description || info.description });
    $('#status').textContent = `${name}: pick a stage`;
    const url = new URL(location.href);
    url.searchParams.set('map', name);
    history.replaceState(null, '', url);
    net.setMap(name); // a room owner's map shows in the public room list
    G.menu.show('stages');
  } catch (e) {
    S.map = null;
    $('#status').textContent = `${name}: ${e.message || e}`;
    log(`map ${name}: ${e.message || e}`);
  } finally {
    loadingMap = null;
    G.maps.loading(name, null);
    G.menu.update();
  }
}

// the last map's world off the GPU (its stream, chunks, entity visuals): nothing of it stays behind the menu
function unloadWorld() {
  G.stream?.dispose();
  G.stream = null;
  G.renderer.setWorld(null);
}

// The rest of the picked map, once (a second stage on the same map reuses it). Resolves when it is in place;
// app/readiness.js then waits for the stage's own area, models, effects and shaders before its clock starts.
// A map picked while another's load is still running waits for that one to stop, then loads its own (the old one
// leaves nothing behind: it checks the pick before each step that touches the renderer or the game state).
let stageLoad = null; // { name, promise }
async function loadStage() {
  if (!S.map || S.map.loaded) return;
  if (stageLoad?.name === S.map.name) return stageLoad.promise;
  if (stageLoad) { await stageLoad.promise.catch(() => {}); return loadStage(); }
  const name = S.map.name;
  const picked = () => S.map?.name === name && !S.map.loaded;
  const progress = (t) => {
    $('#status').textContent = `loading ${name}: ${t}`;
    G.loading.step(stepProgress(t));
    G.hud.update({ title: `Loading ${name}`, sub: t, hp: 100, armor: 0 });
  };
  if (!G.loading.isOpen) G.loading.begin(name, undefined); // a replay, a test: the screen still covers the load
  const promise = (async () => {
    progress('starting');
    // quality: the setting, or Auto (high with BC6H/BC7 on the GPU, low without); a tier the map wasn't baked at is high
    const tier = await pickTier(name);
    if (!picked()) return;
    // the map's own CS2 lighting (lasers-bake --lighting; the old fixed lighting without it) downloads alongside the
    // map's data, not after it: it is the biggest part of a map. Off in the settings: none of it is downloaded
    const lightmapsLoad = !settings.bakedLighting ? Promise.resolve(null) : loadLightmaps(`maps/${name}/`, G.renderer.renderer, log, { reflections: settings.reflections, tier })
      .catch((e) => { log(`lighting: ${e.message || e}`); return null; });
    const data = await loadMap(name, progress, { tier, chunks: !new URLSearchParams(location.search).has('nochunks') }); // ?nochunks: the whole world glb (comparisons)
    if (!picked()) return;
    // the movement and the particle / bullet collision trees, in workers while the lighting loads (world/bvh-build.js)
    const trees = Promise.all([buildBVH(data.collision), data.collisionFx ? buildBVH(data.collisionFx.tris) : null]);
    // the lighting (started above) and post-processing
    progress('lighting');
    const lightmaps = await lightmapsLoad;
    if (!picked()) return;
    G.renderer.lighting.setMap(data.entities, lightmaps);
    await G.renderer.post.setMap(`maps/${name}/`, data.entities, lightmaps);
    if (!picked()) return;
    const [bvh, fxBvh] = await trees;
    if (!picked()) return;
    if (fxBvh) data.collisionFx.bvh = fxBvh;
    G.stream?.dispose();
    G.stream = null;
    G.renderer.setWorld(data.world);
    // a chunked world streams in around you (world/stream.js); the loop asks for what the camera needs.
    // load goes through S.map.loadChunk at each call (tests slow it down there to stand in for a phone's network)
    if (data.chunks.length) {
      G.stream = new WorldStream(data.chunks, {
        load: (...a) => (S.map?.loadChunk || data.loadChunk)(...a), add: (scene) => G.renderer.addWorldChunk(scene), mode: streamMode(), log,
      });
    }
    G.radar.setMap(data.radar);
    S.world = new CollisionWorld(bvh);
    if (data.effects) data.effects.trace = particleTrace(S.world, data.collisionFx);
    // particle sounds (C_OP_RenderSound, fx/particles/render/sound.js) play through the game audio
    if (data.effects) data.effects.onSound = (req) => G.audio.onSound(req);
    // where your bullets hit the world and on what surface (world/impacts.js): its bullet impact sound
    G.impacts = null;
    loadImpacts(name, data.version, data.collisionFx).then((i) => { if (S.map?.name === name) G.impacts = i; }, () => {});
    S.player = new Player(S.world);
    G.audio.loadMap(name, data.version).catch((e) => log(`audio: ${e.message || e}`));
    S.map = { ...data, items: data.items, loaded: true };
    $('#status').textContent = `${name}: ${data.collision.length / 9} collision triangles, ${Object.keys(data.entities.lumps).length} entity lumps`;
  })();
  stageLoad = { name, promise };
  try { await promise; } finally { if (stageLoad?.promise === promise) stageLoad = null; }
}
G.loadStage = loadStage;

async function init() {
  bindSettings(applySettings);
  // graphics presets (ui/graphics-ui.js): above the map list and in Video; Medium (Low on a phone) until one is picked
  installGraphics({ apply: applySettings, mapLoaded: () => !!S.map?.loaded });
  applySettings();
  G.vm.load().catch((e) => log(`viewmodel: ${e.message || e}`));
  const idx = await loadMapIndex().catch(() => ({ maps: [] }));
  // map names become fetch paths (maps/<name>/...): only well-formed ones, from the index or ?map=
  S.mapIndex = (Array.isArray(idx?.maps) ? idx.maps : []).filter((m) => isMapName(m?.name));
  G.maps.build(S.mapIndex, null);
  G.menu.show('maps');
  G.menu.update();
  const asked = new URLSearchParams(location.search).get('map');
  if (asked && !S.mapIndex.some((m) => m.name === asked)) log('?map= ignored: not a baked map');
  else if (asked) await openMap(asked);
  else G.maps.focusCurrent();
  // first visit (no ?map, no invite link): the home page
  G.home.setMaps(S.mapIndex);
  if (!asked && !net.inRoom && !new URLSearchParams(location.search).has('room') && !hasReplayLink()) G.home.show();
  bootDone(); // the first view is built: the boot screen fades (ui/boot.js)
  await bootReplays(); // who is signed in, then a shared replay link (?replay=<id>)
}

// the quality tier to load a map at (lasers-bake --tiers): '' = high
async function pickTier(name) {
  const want = settings.quality === 3 ? '' : settings.quality === 2 ? 'medium' : settings.quality === 1 ? 'low'
    : (G.renderer.renderer.extensions.has('EXT_texture_compression_bptc') ? '' : 'low');
  if (!want) return '';
  // read it, not just HEAD: an SPA fallback (vite preview, static hosts) answers a missing file with index.html + 200
  const ok = await fetch(`maps/${name}/q/${want}/lighting/lighting.json`, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.tier === want, () => false);
  if (!ok) log(`quality ${want}: not baked for ${name} (lasers-bake --tiers), loading high`);
  return ok ? want : '';
}

// a round's start can bring the host's map: load it the way picking it does
G.selectMap = async (name) => {
  if (!S.mapIndex.some((m) => m.name === name)) throw new Error('not on this server');
  await openMap(name, true);
  if (S.map?.name !== name) throw new Error('did not load');
};
G.lobby = new Lobby($('#lobby'), {
  net, state: lobby, getMap: () => S.map?.name || '',
  mapTitle: (name) => S.mapIndex.find((m) => m.name === name)?.title || name,
  hasHeal: () => usableHeals(S.map?.items).length > 0,
  onRoomScreen: () => G.room.comeBack(),
});
installCoop();
// the room screen between rounds, and the pause screen during a run (with the room code in a room)
G.room = new RoomScreen($('#room'), { net, lobby: G.lobby, hasHeal: () => usableHeals(S.map?.items).length > 0 });
G.pauseScreen = new PauseScreen($('#pause'), {
  net,
  on: {
    resume: () => G.resume(),
    restart: () => restartRun(),
    stages: () => { G.menu.show(S.map ? 'stages' : 'maps'); G.menu.update(); },
    settings: () => { G.menu.selectTab($('#tab-settings')); G.menu.update(); },
    home: () => G.home.show(),
    endRound: () => abortRound(),
  },
});
installReplays(); // replays + the Steam account (app/replay-boot.js)

// the home page: every way in leads to the menu (its Home button comes back)
const toMenu = () => { G.home.hide(); G.menu.show(G.menu.view); };
G.home = new Home($('#home'), {
  net, mapTitle: (name) => S.mapIndex.find((m) => m.name === name)?.title || name,
  on: {
    play: () => { G.home.hide(); showMaps(); },
    find: () => { toMenu(); G.lobby.go('browse'); },
    make: () => G.lobby.createNow(false), // the room screen (ui/room.js) opens once the server has made it
    join: (code) => { toMenu(); G.lobby.joinCode(code); },
    map: (name) => { G.home.hide(); G.menu.show('maps'); openMap(name); },
    settings: () => { G.home.hide(); G.menu.selectTab($('#tab-settings')); },
    watch: (id) => G.watchReplay(id),
  },
});
$('#go-home').addEventListener('click', () => G.home.show());

// console handle for debugging and automated checks
window.__lasers = {
  get engine() { return S.engine; }, get player() { return S.player; }, get run() { return S.run; }, get world() { return S.world; },
  get paused() { return S.paused; }, get renderer() { return G.renderer; }, get map() { return S.map; }, get vm() { return G.vm; }, get body() { return G.body; }, get audio() { return G.audio; }, get overlayOpen() { return G.overlay.open; },
  get stream() { return G.stream; },
  // a stage loads its map first (loadStage); the run then waits for app/readiness.js (run.ready) before its clock
  async startScenario(i, mode) { beginStageLoading(i); await loadStage(); if (S.map?.loaded) startScenario(i, mode); return S.run; },
  settings, scenarios: () => S.scenarios,
  get replay() { return S.replay; }, watchReplay: (id) => G.watchReplay(id), watchLastRun: () => G.watchLastRun(),
  coop: { net, lobby, get round() { return S.mp; }, peers: G.peers },
  // run the simulation n seconds synchronously (tests; a hidden tab gets no animation frames)
  // solo only: a co-op / versus round runs on the server's clock
  advance(seconds) { if (S.mp) return 'solo only'; for (let i = 0; i < Math.round(seconds / CS.tick); i++) { if (!S.run || S.run.done) break; step(); } updateHud(); },
};

init().catch((e) => { $('#status').textContent = String(e); console.error(e); bootFailed(e); });
requestAnimationFrame(frame);
