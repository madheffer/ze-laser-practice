// Map sound + music + weapon sounds. CONTRACT (main.js calls exactly these; keep the signatures):
//
//   const audio = new GameAudio();
//   await audio.loadMap(mapName, version?)  // reads maps/<map>/soundevents.json (+ the sound files it names);
//                                           //   version = the map's manifest.version, put on every URL (?v=)
//   audio.onSound(ev)                       // engine 'sound' request (world/entities/sound.js): { type: 'start'|'stop'|
//                                           //   'volume'|'pitch', ent (Entity; ent.id is stable), name (soundevent name),
//                                           //   pos [x,y,z], local (bool: play 2D to you), slot? (one of the entity's
//                                           //   sounds; stop / pitch / volume without one reach all of them), volume?,
//                                           //   volumeRandom? [min, max], pitch? (x1), follow()? (where it is now), value?,
//                                           //   soundlevel? (a Source 1 sound's level: its falloff, audio/source1-falloff.js),
//                                           //   absolute? (volume: value is the voice's volume 0..1, not a 0..10 factor) }
//   audio.play(name, { pos?, volume? })     // one-shot by soundevent name (weapons: 'Weapon_Knife.Slash', ...)
//   audio.setListener(pos, yaw, pitch)      // every frame; Source units, degrees
//   audio.setVolumes({ sfx, music })        // 0..1 each (slider^2 gain); the master gain is only the pause fade
//   audio.pause() / audio.resume()          // menu open/closed
//   audio.stopAll()                         // scenario restart
//   audio.ready()                           // resolves when the map's table is in (app/readiness.js waits; requests
//                                           //   that come earlier are held and played then)
//   audio.bulletImpact(hash, pos)           // a bullet on a world surface (world/impacts.js; audio/surfaces.js)
//
// Extras: audio.footstep(pos) (a concrete step), audio.report() (what resolved, for audio-test.html).
//
// Sound tables come from lasers-bake: sounds/soundevents.json (stock CS2: knife, AK-47, player) and
// maps/<map>/soundevents.json. Each event: { type, files, volume, pitch, pitchRandom?, curve?, delay?, local?,
// loop?, loopStart?, loopEnd?, children?, instanceLimit?, blockDuration?, blockDistance?, blockMatchEntity?,
// blockMatching? } (the last five: audio/limits.js). `curve` is CS2's distance_volume_mapping_curve: [[units, gain], ...].
// Spatial sounds are panned by hand (gain + stereo pan from the listener's yaw), so everything stays in
// Source units with Z up and nothing depends on WebAudio's PannerNode coordinate conventions.

import { clamp01 } from '../lib/math.js';
import { mapName } from '../lib/paths.js';
import { spatialMix } from './spatial.js';
import { sourceCurve } from './source1-falloff.js';
import { VoiceLimits } from './limits.js';
import { createMixGlue } from './mixglue.js';
import { groupLevels, eventGroup, eventVolume } from './mix.js';
import { MixLayers, DEATH_FADE } from './layers.js';
import { RoomDsp } from './dsp.js';
import { followCurve, fadeOut, randomAround } from './shape.js';
import { SurfaceSounds } from './surfaces.js';
import { ALIASES, readTable, fileUrl } from './tables.js';
import { DEFAULT_GUN, DEFAULT_PISTOL, gunSounds } from '../lib/weapons.js';


const MAX_VOICES = 64;
const FADE = 0.35; // pause / resume fade, seconds
const MAX_CHILD_EVENTS = 16; // child events started per event (each up to 3 levels): a map's table is data

// Volume sliders are perceptual: gain = slider^2 (50% = -12 dB), not linear amplitude (50% = -6 dB, which
// still blasts on loud music masters).
const curve = (v) => clamp01(v) ** 2;

export class GameAudio {
  constructor() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = AC ? new AC() : null;
    this.tables = { stock: { base: 'sounds/', version: null, events: new Map() }, map: { base: '', version: null, events: new Map() } };
    this.mapName = '';
    this.buffers = new Map();   // url -> Promise<AudioBuffer|null>
    this.status = new Map();    // url -> 'pending' | 'ok' | 'failed'
    this.logged = new Set();
    this.voices = new Set();
    this.byEnt = new Map();     // ent.id -> Set<voice>
    this.limits = new VoiceLimits();
    this.surfaces = new SurfaceSounds(); // the map's surface sounds (bullet impacts, prop breaks)
    this.listener = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
    this.paused = true; // the menu is up at boot; resume() on entering a stage
    this.volumes = { sfx: 1, music: 1 };
    if (!this.ctx) { this._warn('audio: WebAudio unavailable'); return; }
    this.master = this.ctx.createGain();
    this.sfx = this.ctx.createGain();
    this.music = this.ctx.createGain();
    this.master.gain.value = 0; // paused at boot: silent until a stage is entered (resume fades in)
    // everything goes through CS2's final-mix compressor (mixglue.js), then the pause fade
    this.glue = createMixGlue(this.ctx);
    this.sfx.connect(this.glue.input);
    this.music.connect(this.glue.input);
    this.glue.output.connect(this.master);
    this.master.connect(this.ctx.destination);
    // CS2's mix layers (temporary volume changes, layers.js) and room reverb (RoomDSP, dsp.js: core_null until a
    // soundscape-style event switches it); the reverb returns through the sfx volume
    this.layers = new MixLayers();
    this.layerVersion = 0;
    this.dsp = new RoomDsp(this.ctx);
    this.dsp.output.connect(this.sfx);
    this.chains = new Map(); // ent.id (or null) -> Set of retrigger chains (csgo_mega enable_retrigger)
    this.stockReady = this._loadTable('stock', 'sounds/soundevents.json').then(() => this._preloadStock());
    this.setVolumes(this.volumes);

    // Autoplay policy: the context starts suspended until a gesture.
    const unlock = () => {
      if (this.ctx.state === 'running') { off(); return; }
      if (!this.paused) this.ctx.resume().then(() => { if (this.ctx.state === 'running') off(); }, () => {});
    };
    const evs = ['pointerdown', 'keydown', 'touchstart', 'mousedown'];
    const off = () => evs.forEach((e) => removeEventListener(e, unlock, true));
    if (typeof addEventListener === 'function') evs.forEach((e) => addEventListener(e, unlock, true));
  }

  // ---- contract -------------------------------------------------------------------------------------

  async loadMap(name, version = null) {
    this.mapName = mapName(name);
    const base = `maps/${this.mapName}/`;
    this.tables.map = { base, version, events: new Map() };
    if (!this.ctx) { this.mapReady = Promise.resolve(); return; }
    const table = this.tables.map;
    this.mapReady = Promise.all([this._loadTable('map', base + 'soundevents.json'), this.stockReady, this.surfaces.load(base, version)]).then(() => {
      // requests that came in before the table: played now, as far into them as the wait took
      const held = this.held || [];
      this.held = null;
      if (this.tables.map !== table) return;
      const now = performance.now();
      for (const { ev, at } of held) this.onSound({ ...ev, offset: (ev.offset || 0) + (now - at) / 1000 });
    });
    this.held = [];
    await this.mapReady;
  }

  // resolves once the map's sound table (and the stock one) is in: app/readiness.js waits for it before a stage starts
  ready() { return this.mapReady || Promise.resolve(); }

  onSound(ev) {
    if (!this.ctx || !ev) return;
    // the map's table is still loading: hold the request (in order) rather than lose it as an unknown name
    if (this.held && this.held.length < 512) { this.held.push({ ev, at: performance.now() }); return; }
    const id = ev.ent?.id;
    switch (ev.type) {
      case 'start': {
        // a prop's break names its model: the sound is its surface's (audio/surfaces.js), none for most
        const name = ev.name || (ev.surfaceBreak ? this.surfaces.breakOf(ev.surfaceBreak) : '');
        if (!name) return;
        const vr = Array.isArray(ev.volumeRandom) ? ev.volumeRandom : null;
        const volume = (Number.isFinite(ev.volume) ? ev.volume : 1) * (vr ? vr[0] + Math.random() * (vr[1] - vr[0]) : 1);
        this._start(name, {
          pos: ev.pos, ent: ev.ent, local: !!ev.local, entId: id, offset: ev.offset || 0, slot: ev.slot ?? null,
          volume, pitch: Number.isFinite(ev.pitch) && ev.pitch > 0 ? ev.pitch : 1, follow: typeof ev.follow === 'function' ? ev.follow : null,
          repeat: !!ev.repeat, guid: Number.isFinite(ev.guid) ? ev.guid : 0,
          soundlevel: Number.isFinite(ev.soundlevel) ? ev.soundlevel : undefined,
          // the emitter's volume, replacing the event's own (client.dll starts Player.AmbientUnderWater, volume 0 in its
          // event, with 1: app/water-sounds.js)
          paramVolume: Number.isFinite(ev.paramVolume) ? ev.paramVolume : undefined,
        });
        return;
      }
      case 'stop': {
        // csgo_mega: a stopped voice plays on while the time since the stop is under its fade curve's length; a looped
        // one ends at once (looped_event_terminator), and a one-shot with no fade curve plays to its end. ze__hell_p's
        // spikes stop Rod.crystal (0.95 s) as each spike arrives, 0.051 s in (CBaseDoor::DoorHitTop -> StopMovingSound):
        // the whole sound is what the map was made with, and what plays in CS2
        for (const v of this._voicesOf(id, ev.slot)) if (!playsOutStop(v)) this._stopVoice(v);
        this._stopChains(id, ev.slot);
        return;
      }
      // snd_event_param: a parameter on the sound with that handle (point_soundevent's SoundEventGuid). "volume" is the
      // event's public volume (it replaces the event's own), "pitch" its pitch
      case 'param': {
        const val = Number(ev.value);
        if (!ev.guid || !Number.isFinite(val)) return;
        const key = String(ev.name || '').toLowerCase();
        for (const v of this.voices) {
          if (v.guid !== ev.guid) continue;
          if (key === 'volume') { v.paramVolume = Math.abs(val); this._update(v); }
          else if (key === 'pitch' && val > 0) { v.userPitch = val / (v.def.pitch || 1); for (const s of v.sources) s.playbackRate.setValueAtTime(v.rate * v.userPitch, this.ctx.currentTime); }
          else this._warn(`audio: sound parameter "${ev.name}" isn't modelled`);
        }
        return;
      }
      case 'volume': {
        let val = Number(ev.value);
        if (!Number.isFinite(val)) return;
        // a Source 1 ambient_generic's new volume replaces what it started with (classes/ambient-source1.js)
        if (ev.absolute) { for (const v of this._voicesOf(id, ev.slot)) { v.requestVolume = clamp01(val); v.userVolume = 1; this._update(v); } return; }
        if (ev.ent?.cls === 'ambient_generic' || val > 1) val /= 10; // ambient_generic's 0..10 (its "1" is 0.1)
        for (const v of this._voicesOf(id, ev.slot)) { v.userVolume = clamp01(val); this._update(v); }
        return;
      }
      case 'pitch': {
        let val = Number(ev.value);
        if (!Number.isFinite(val) || val <= 0) return;
        if (val > 4) val /= 100; // percent (100 = normal)
        for (const v of this._voicesOf(id, ev.slot)) {
          v.userPitch = val;
          for (const s of v.sources) s.playbackRate.setValueAtTime(v.rate * val, this.ctx.currentTime);
        }
        return;
      }
    }
  }

  play(name, opts = {}) {
    if (!this.ctx) return;
    this._start(name, { pos: opts.pos, volume: opts.volume, local: !opts.pos });
  }

  footstep(pos) { this.play('footstep', { pos }); }

  // a bullet hitting the world: the surface's (by its hash, world/impacts.js) bullet impact sound at the hit
  bulletImpact(hash, pos) {
    const name = this.surfaces.bulletImpact(hash);
    if (name) this.play(name, { pos });
  }

  setListener(pos, yaw, pitch) {
    if (pos) { this.listener.pos[0] = pos[0]; this.listener.pos[1] = pos[1]; this.listener.pos[2] = pos[2]; }
    this.listener.yaw = yaw || 0;
    this.listener.pitch = pitch || 0;
    // mix-layer triggers (a layer follows its trigger group's sounds), then re-level every voice if a layer moved
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.layers.tick(now, (group) => {
      let m = 0;
      for (const v of this.voices) if (!v.stopped && v.group && v.group.toLowerCase() === group) m = Math.max(m, v.lastGain || 0);
      return m;
    });
    const relevel = this.layers.version !== this.layerVersion;
    this.layerVersion = this.layers.version;
    for (const v of this.voices) if (v.spatial || relevel) this._update(v);
  }

  // CS2's death cam mix (layers.js DEATH_FADE): 'death' when you die and watch on, 'clear' once you're back / restart
  deathFade(phase) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (phase === 'death') this.layers.set('DeathFadeLayer', DEATH_FADE.phase1[0], DEATH_FADE.phase1[1], now);
    else if (phase === 'fade') this.layers.set('DeathFadeLayer', DEATH_FADE.phase2[0], DEATH_FADE.phase2[1], now);
    else this.layers.set('DeathFadeLayer', 0, 0, now);
  }

  setVolumes({ sfx, music } = {}) {
    if (sfx != null) this.volumes.sfx = clamp01(Number(sfx));
    if (music != null) this.volumes.music = clamp01(Number(music));
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sfx.gain.setTargetAtTime(curve(this.volumes.sfx), t, 0.02);
    this.music.gain.setTargetAtTime(curve(this.volumes.music), t, 0.02);
  }

  // Menu open: everything (music included) fades out over FADE s, then the context suspends, so nothing
  // advances while paused. Resume fades back in from where it stopped.
  pause() {
    if (!this.ctx) { this.paused = true; return; }
    const was = this.paused;
    this.paused = true;
    if (was) return;
    const t = this.ctx.currentTime, g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + FADE);
    clearTimeout(this._fadeT);
    this._fadeT = setTimeout(() => { if (this.paused && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }, FADE * 1000 + 30);
  }

  resume() {
    this.paused = false;
    if (!this.ctx) return;
    clearTimeout(this._fadeT);
    const fadeIn = () => {
      const t = this.ctx.currentTime, g = this.master.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(1, t + FADE);
    };
    if (this.ctx.state !== 'running') this.ctx.resume().then(fadeIn, () => {});
    else fadeIn();
  }

  stopAll() {
    for (const v of [...this.voices]) this._stopVoice(v, true);
    for (const set of this.chains.values()) for (const c of set) { c.stopped = true; clearTimeout(c.timer); }
    this.chains.clear();
    this.byEnt.clear();
    this.limits.clear();
    this.layers.clear();
    this.dsp.setPreset('core_null'); // a new run starts in the mix graph's default room
    if (this.held) this.held = []; // a restart drops what the old run asked for while the table loaded
  }

  // For audio-test.html: which events/files resolved.
  report() {
    const files = {};
    for (const [url, s] of this.status) files[url] = s;
    return {
      map: this.mapName,
      state: this.ctx?.state || 'none',
      stockEvents: [...this.tables.stock.events.values()].map((e) => e.name),
      mapEvents: [...this.tables.map.events.values()].map((e) => e.name),
      aliases: { ...ALIASES },
      voices: this.voices.size,
      files,
    };
  }

  // ---- internals ------------------------------------------------------------------------------------

  _warn(msg) {
    if (this.logged.has(msg)) return;
    this.logged.add(msg);
    console.warn(msg);
  }

  // a soundevents.json into this.tables[which] (audio/tables.js readTable)
  async _loadTable(which, url) {
    const table = this.tables[which];
    try {
      const events = await readTable(url, table, which === 'stock');
      // a later loadMap may have replaced the table meanwhile
      if (this.tables[which] === table) table.events = events;
    } catch (e) {
      this._warn(`audio: no ${url} (${e.message || e})`);
    }
  }

  _preloadStock() {
    this.preload(Object.values(ALIASES).map((a) => (typeof a === 'string' ? a : a.name)));
    this.preload([...gunSounds(DEFAULT_GUN), ...gunSounds(DEFAULT_PISTOL)]);
  }

  // stock events to have fetched and decoded before they play (the aliases at boot, a gun when it is bought)
  preload(names) {
    this.stockReady?.then(() => {
      for (const n of names) {
        const def = this.tables.stock.events.get(String(n).toLowerCase());
        if (def) for (const f of def.files || []) this._buffer(this._fileUrl(this.tables.stock, f));
      }
    });
  }

  // name (alias, stock or map event) -> { def, base, pitch, volume }
  _lookup(name) {
    if (!name) return null;
    let pitch = 1, volume = 1;
    const a = Object.hasOwn(ALIASES, name) ? ALIASES[name] : null;
    if (a) {
      if (typeof a === 'string') name = a;
      else { name = a.name; pitch = a.pitch ?? 1; volume = a.volume ?? 1; }
    }
    const key = String(name).toLowerCase();
    for (const t of [this.tables.stock, this.tables.map]) {
      const def = t.events.get(key);
      if (def) return { def, table: t, pitch, volume };
    }
    return null;
  }

  _fileUrl(table, file) { return fileUrl(table, file); }

  _buffer(url) {
    if (url == null) return Promise.resolve(null);
    let p = this.buffers.get(url);
    if (p) return p;
    this.status.set(url, 'pending');
    p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => { this.status.set(url, 'ok'); return buf; })
      .catch((e) => { this.status.set(url, 'failed'); this._warn(`audio: ${url}: ${e.message || e}`); return null; });
    this.buffers.set(url, p);
    return p;
  }

  // an entity's voices (one slot's only, when given)
  _voicesOf(id, slot) {
    const set = id != null && this.byEnt.get(id);
    if (!set) return [];
    return [...set].filter((v) => slot == null || v.slot === slot);
  }

  _start(name, o, depth = 0) {
    const hit = this._lookup(name);
    // CS2 too plays nothing for a name no table defines (soundsystem.dll "Unable to find soundevent")
    if (!hit) { if (name) this._warn(`audio: unknown sound event "${name}"`); return; }
    const { def, table } = hit;
    // CS2's voice management: a blocked start plays nothing, its children included; over the limit, the oldest stops
    if (!this.limits.allow(def, o, this.ctx.currentTime)) return;
    for (const old of this.limits.overLimit(def, o.entId, this.voices)) this._stopVoice(old);
    const isMusic = /music/i.test(def.type || '');
    // csgo_music stop_music: every other "Music." event stops (soundevent_limiter, max 0, name substring)
    if (def.stopMusic) for (const v of [...this.voices]) if (v.def !== def && /music\./i.test(v.name || '')) this._stopVoice(v);
    // a soundscape-style event switches the listener's room reverb (RoomDSP, dsp.js)
    if (def.dspPreset) this.dsp.setPreset(def.dspPreset);
    const files = Array.isArray(def.files) ? def.files : [];
    if (files.length) {
      const file = files[(Math.random() * files.length) | 0];
      const pr = def.pitchRandom;
      const rate = Math.max(0.05, ((def.pitch ?? 1) * hit.pitch + (pr ? pr[0] + Math.random() * (pr[1] - pr[0]) : 0)) * (o.pitch ?? 1));
      const local = !o.pos || o.local || def.local;
      // randomize_position: a fixed point that far from where it plays (the listener, for a sound played to you)
      const randomPos = def.randomPos ? randomAround(local ? this.listener.pos : o.pos, def.randomPos) : null;
      const v = {
        def, name: def.name, sources: [], gain: null, pan: null, env: null, send: null, ent: o.ent, entId: o.entId,
        pos: randomPos || (o.pos ? [...o.pos] : null), fixedPos: !!randomPos,
        slot: o.slot ?? null, follow: o.follow || null, repeat: !!o.repeat, guid: o.guid || 0,
        offset: o.offset || 0, // seconds already played (a stage that starts mid-ending joins its music mid-track)
        spatial: !isMusic && (!!randomPos || (!!o.pos && !o.local && !def.local)), music: isMusic, rate,
        // the event's volume (+ its random variance; a snd_event_param "volume" replaces it) x the request's; the mix
        // group's level (layers included) is applied in _update
        eventVolume: eventVolume(def), paramVolume: Number.isFinite(o.paramVolume) ? Math.abs(o.paramVolume) : null, requestVolume: hit.volume * (o.volume ?? 1), group: eventGroup(def),
        userVolume: 1, userPitch: 1, stopped: false,
        // a Source 1 sound's falloff: the request's level (an ambient_generic's radius), else its event's
        curve: o.soundlevel != null ? sourceCurve(o.soundlevel) : def.soundlevel != null && !def.curve ? sourceCurve(def.soundlevel) : def.curve,
      };
      this._track(v);
      this._buffer(this._fileUrl(table, file)).then((buf) => {
        if (!buf || v.stopped) { if (!buf) this._untrack(v); return; }
        this._begin(v, buf);
      });
    }
    // enable_retrigger: the event plays again every [min, max] s until its entity's sound is stopped
    if (def.retrigger) this._retrigger(name, o, depth);
    // child events (e.g. Weapon_AK47.Single -> SingleDistant) play alongside, owned by the same entity
    if (depth < 3 && Array.isArray(def.children)) for (const c of def.children.slice(0, MAX_CHILD_EVENTS)) this._start(c, { ...o, chain: null }, depth + 1);
  }

  _retrigger(name, o, depth = 0) {
    const def = this._lookup(name)?.def;
    if (!def?.retrigger) return;
    let chain = o.chain;
    if (!chain) {
      chain = { stopped: false, timer: 0, slot: o.slot ?? null };
      const key = o.entId ?? null;
      if (!this.chains.has(key)) this.chains.set(key, new Set());
      this.chains.get(key).add(chain);
    }
    const [lo, hi] = def.retrigger;
    const wait = Math.max(0.05, lo + Math.random() * Math.max(0, hi - lo));
    const fire = () => {
      if (chain.stopped) return;
      if (this.paused) { chain.timer = setTimeout(fire, 250); return; } // the game's clock isn't running
      this._start(name, { ...o, chain, offset: 0 }, 3); // depth 3: the event again, not its children (they have their own)
    };
    chain.timer = setTimeout(fire, wait * 1000);
    void depth;
  }

  _stopChains(id, slot) {
    const set = this.chains.get(id ?? null);
    if (!set) return;
    for (const c of [...set]) if (slot == null || c.slot === slot) { c.stopped = true; clearTimeout(c.timer); set.delete(c); }
    if (!set.size) this.chains.delete(id ?? null);
  }

  _track(v) {
    this.voices.add(v);
    if (v.entId != null) {
      let set = this.byEnt.get(v.entId);
      if (!set) this.byEnt.set(v.entId, (set = new Set()));
      set.add(v);
    }
    if (this.voices.size > MAX_VOICES) {
      // drop the oldest non-music, non-looping voice
      for (const old of this.voices) if (!old.music && !old.def.loop && old !== v) { this._stopVoice(old); break; }
    }
  }

  _untrack(v) {
    this.voices.delete(v);
    const set = v.entId != null && this.byEnt.get(v.entId);
    if (set) { set.delete(v); if (!set.size) this.byEnt.delete(v.entId); }
  }

  _begin(v, buf) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = v.rate * v.userPitch;
    if (v.def.loop) {
      src.loop = true;
      src.loopStart = v.def.loopStart || 0;
      if (v.def.loopEnd > src.loopStart) src.loopEnd = Math.min(v.def.loopEnd, buf.duration);
    } else if (v.repeat) src.loop = true; // played again each time it ends, until stopped (a door's loopmovesound)
    v.gain = ctx.createGain();
    let node = src;
    if (v.spatial && ctx.createStereoPanner) {
      v.pan = ctx.createStereoPanner();
      src.connect(v.pan);
      node = v.pan;
    }
    // the envelope: time_volume_mapping_curve from the start, the stop fade curve after a stop (shape.js)
    v.env = ctx.createGain();
    node.connect(v.env).connect(v.gain);
    v.gain.connect(v.music ? this.music : this.sfx);
    // the reverb send, by the mix group's dsp level (music: 0 in Default_Mix)
    if (!v.music) { v.send = ctx.createGain(); v.send.gain.value = 0; v.gain.connect(v.send).connect(this.dsp.input); }
    v.sources.push(src);
    if (v.def.timeCurve) followCurve(v.env.gain, v.def.timeCurve, ctx.currentTime - Math.max(0, v.offset));
    this._update(v, true);
    src.onended = () => { if (!src.loop || v.stopped) this._finish(v); };
    // joining late: skip what has already played (wrap inside the loop for looping sounds)
    let off = Math.max(0, v.offset * v.rate - (v.def.delay || 0));
    if (off > 0) {
      if (src.loop) {
        const ls = src.loopStart || 0, le = src.loopEnd || buf.duration;
        if (off > le) off = ls + ((off - ls) % Math.max(0.01, le - ls));
      } else if (off >= buf.duration) { this._finish(v); return; }
    }
    src.start(ctx.currentTime + (off > 0 ? 0 : v.def.delay || 0), off);
  }

  _update(v, immediate = false) {
    if (!v.gain) return;
    const t = this.ctx.currentTime;
    // the mix group's level and dsp send with the mix layers' factors (mix.js, layers.js)
    const lv = groupLevels(v.group, (grp) => this.layers.factor(grp, t));
    let g = (v.paramVolume ?? v.eventVolume) * v.requestVolume * lv.vol * v.userVolume, p = 0;
    if (v.spatial) {
      const pos = (!v.fixedPos && v.ent && v.ent.alive !== false && (v.follow ? safeCall(v.follow) : typeof v.ent.worldOrigin === 'function' && safeOrigin(v.ent))) || v.pos;
      ({ gain: g, pan: p } = spatialMix(pos, this.listener, v.curve, g, v.def.distanceMultiplier ?? 1));
    }
    // nothing moved: no new automation event (setListener runs every frame; at uncapped frame rates a new
    // setTargetAtTime per frame per voice piles up hundreds of events a second on each param)
    if (!immediate && Math.abs(g - (v.lastGain ?? -1)) < 1e-4 && Math.abs(p - (v.lastPan ?? 9)) < 1e-3 && Math.abs(lv.dsp - (v.lastDsp ?? -1)) < 1e-4) return;
    v.lastGain = g; v.lastPan = p; v.lastDsp = lv.dsp;
    if (immediate) {
      v.gain.gain.setValueAtTime(g, t);
      if (v.pan) v.pan.pan.setValueAtTime(p, t);
      if (v.send) v.send.gain.setValueAtTime(lv.dsp, t);
    } else {
      v.gain.gain.setTargetAtTime(g, t, 0.03);
      if (v.pan) v.pan.pan.setTargetAtTime(p, t, 0.03);
      if (v.send) v.send.gain.setTargetAtTime(lv.dsp, t, 0.03);
    }
  }

  // now: skip the event's stop fade (a restart / stopAll)
  _stopVoice(v, now = false) {
    if (v.stopped) return;
    v.stopped = true;
    const t = this.ctx.currentTime;
    // fadetime_volume_mapping_curve: it keeps playing along the curve until its end (shape.js)
    const tail = !now && v.env ? fadeOut(v.env.gain, v.def.fadeCurve, t) : 0;
    if (!tail && v.gain) {
      // a short fade so StopSound doesn't click
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + 0.05);
    }
    const end = tail || 0.06;
    for (const s of v.sources) { try { s.stop(t + end); } catch { /* not started */ } }
    if (!v.sources.length) this._untrack(v);
    else setTimeout(() => this._finish(v), end * 1000 + 50);
  }

  _finish(v) {
    if (!this.voices.has(v)) return;
    v.stopped = true;
    try { v.gain?.disconnect(); v.pan?.disconnect(); v.env?.disconnect(); v.send?.disconnect(); } catch { /* already gone */ }
    this._untrack(v);
  }
}

// a csgo_mega one-shot without a stop-fade curve isn't cut by a map's StopSound (see onSound 'stop')
const playsOutStop = (v) => v.def?.type === 'csgo_mega' && !v.def.loop && !v.repeat && !v.def.fadeCurve;

function safeOrigin(ent) {
  try { const o = ent.worldOrigin(); return o && o.length >= 3 ? o : null; } catch { return null; }
}
function safeCall(fn) {
  try { const o = fn(); return o && o.length >= 3 ? o : null; } catch { return null; }
}
