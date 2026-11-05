// ZE Laser Practice: pick a map and a stage, spawn where the lasers are, and the map's own entity logic runs.
// This file only boots and wires the pieces:
//   app/     state, settings, session (one attempt), loop (frames + ticks), input, bosses, endless, records
//   ui/      menu (the pause screen + stage picker), hud (CS2 Panorama HUD), overlay (end cards)
//   world/   entities (the map's I/O logic); collision, movement, render, assets
//   audio.js, viewmodel.js (+ fp/): sound and the first-person weapon
import { loadMapIndex, loadMap, loadScenarios } from './world/assets.js';
import { CollisionWorld } from './world/collision.js';
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
G.body = new PlayerBody(G.renderer.scene, { log, onModel: litByParticles }); // third person (!tp): your own CT
G.hud = new Hud($('#hud'));
G.radar = new Radar($('#hud')); // the minimap (CS2's own radar) and the EntWatch-style item list under it
G.itemHud = new ItemHud($('#hud'));
G.overlay = new Overlay($('#overlay'));
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
  applyGamma(settings.gamma); // r_fullscreen_gamma (ui/gamma.js)
  G.renderer.setQuality({ renderScale: settings.renderScale, msaa: settings.msaa });
  G.renderer.lighting.setOptions({ fog: settings.fog, reflections: settings.reflections });
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

G.menu = new Menu({
  onPick: (i, mode) => G.play(i, mode),
  onResume: () => G.resume(),
  onRestart: () => G.play(S.scenarioIndex, S.run?.mode),
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
  restart: () => { if (net.inRoom) { if (net.isHost) hostStart(S.scenarioIndex, S.run?.mode); } else startScenario(S.scenarioIndex, S.run?.mode); },
});

// Load a map (its world, collision, sounds, stages) and open its stage list. The same map again just reopens the
// list. The URL keeps ?map=<name>, so a reload comes back to it.
let loadingMap = null;
// fromRound: the host's round start brought this map (a guest can't leave a live round for another map)
async function openMap(name, fromRound = false) {
  if (!isMapName(name) || loadingMap) return;
  if (!fromRound && S.mp && !S.mp.ended && S.run && !S.run.done && !net.isHost && S.map?.name !== name) { G.lobby.note('Leave the room to play another map'); return; }
  if (S.map?.name === name) { G.menu.show('stages'); return; }
  loadingMap = name;
  const progress = (t) => { $('#status').textContent = `loading ${name}: ${t}`; G.maps.loading(name, t); };
  try {
    progress('starting');
    abortRound(); // the host leaving a live round for another map ends it for everyone
    endRun();
    // quality: the setting, or Auto (high with BC6H/BC7 on the GPU, low without); a tier the map wasn't baked at is high
    const tier = await pickTier(name);
    S.map = await loadMap(name, progress, { tier, chunks: !new URLSearchParams(location.search).has('nochunks') }); // ?nochunks: the whole world glb (comparisons)
    // the map's own CS2 lighting and post-processing (lasers-bake --lighting; the old fixed lighting without it)
    progress('lighting');
    // off in the settings: none of it is downloaded, the simple lighting stays
    const lightmaps = !settings.bakedLighting ? null : await loadLightmaps(`maps/${name}/`, G.renderer.renderer, log, { reflections: settings.reflections, tier })
      .catch((e) => { log(`lighting: ${e.message || e}`); return null; });
    G.renderer.lighting.setMap(S.map.entities, lightmaps);
    await G.renderer.post.setMap(`maps/${name}/`, S.map.entities, lightmaps);
    G.stream?.dispose();
    G.stream = null;
    G.renderer.setWorld(S.map.world);
    // a chunked world streams in around you (world/stream.js); the loop asks for what the camera needs
    if (S.map.chunks.length) {
      G.stream = new WorldStream(S.map.chunks, {
        load: S.map.loadChunk, add: (scene) => G.renderer.addWorldChunk(scene), mode: streamMode(), log,
      });
    }
    G.radar.setMap(S.map.radar);
    S.world = new CollisionWorld(S.map.collision);
    if (S.map.effects) S.map.effects.trace = particleTrace(S.world, S.map.collisionFx);
    S.player = new Player(S.world);
    G.audio.loadMap(name, S.map.version).catch((e) => log(`audio: ${e.message || e}`));
    const file = await loadScenarios(name);
    S.scenarios = Array.isArray(file.scenarios) ? file.scenarios : [];
    const info = S.mapIndex.find((m) => m.name === name) || {};
    G.menu.build({ title: file.title || info.title, description: file.description || info.description });
    $('#status').textContent = `${name}: ${S.map.collision.length / 9} collision triangles, ${Object.keys(S.map.entities.lumps).length} entity lumps`;
    // a still view of the map behind the menu; nothing runs until a stage is picked
    const ct = S.map.entities.lumps.default_ents?.find((d) => d.kv.classname === 'info_player_counterterrorist');
    S.player.teleport(ct ? parseVec(ct.kv.origin) : [0, 0, 0], 0);
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

async function init() {
  bindSettings(applySettings);
  applySettings();
  G.vm.load().catch((e) => log(`viewmodel: ${e.message || e}`));
  G.body.load().catch((e) => log(`body: ${e.message || e} (third person shows no body)`));
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
});
installCoop();
installReplays(); // replays + the Steam account (app/replay-boot.js)

// the home page: every way in leads to the menu (its Home button comes back)
const toMenu = () => { G.home.hide(); G.menu.show(G.menu.view); };
G.home = new Home($('#home'), {
  net, mapTitle: (name) => S.mapIndex.find((m) => m.name === name)?.title || name,
  on: {
    play: () => { G.home.hide(); showMaps(); },
    find: () => { toMenu(); G.lobby.go('browse'); },
    make: () => { toMenu(); G.lobby.openCreate(false); },
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
  startScenario, settings, scenarios: () => S.scenarios,
  get replay() { return S.replay; }, watchReplay: (id) => G.watchReplay(id), watchLastRun: () => G.watchLastRun(),
  coop: { net, lobby, get round() { return S.mp; }, peers: G.peers },
  // run the simulation n seconds synchronously (tests; a hidden tab gets no animation frames)
  // solo only: a co-op / versus round runs on the server's clock
  advance(seconds) { if (S.mp) return 'solo only'; for (let i = 0; i < Math.round(seconds / CS.tick); i++) { if (!S.run || S.run.done) break; step(); } updateHud(); },
};

init().catch((e) => { $('#status').textContent = String(e); console.error(e); });
requestAnimationFrame(frame);
