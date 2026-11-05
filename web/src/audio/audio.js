// Map sound + music + weapon sounds. CONTRACT (main.js calls exactly these; keep the signatures):
//
//   const audio = new GameAudio();
//   await audio.loadMap(mapName, version?)  // reads maps/<map>/soundevents.json (+ the sound files it names);
//                                           //   version = the map's manifest.version, put on every URL (?v=)
//   audio.onSound(ev)                       // engine 'sound' request (world/entities/sound.js): { type: 'start'|'stop'|
//                                           //   'volume'|'pitch', ent (Entity; ent.id is stable), name (soundevent name),
//                                           //   pos [x,y,z], local (bool: play 2D to you), slot? (one of the entity's
//                                           //   sounds; stop / pitch / volume without one reach all of them), volume?,
//                                           //   volumeRandom? [min, max], pitch? (x1), follow()? (where it is now), value? }
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
import { VoiceLimits } from './limits.js';
import { SurfaceSounds } from './surfaces.js';
import { ALIASES, readTable, fileUrl } from './tables.js';


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
    this.sfx.connect(this.master);
    this.music.connect(this.master);
    this.master.connect(this.ctx.destination);
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
          repeat: !!ev.repeat,
        });
        return;
      }
      case 'stop': {
        for (const v of this._voicesOf(id, ev.slot)) this._stopVoice(v);
        return;
      }
      case 'volume': {
        let val = Number(ev.value);
        if (!Number.isFinite(val)) return;
        if (val > 1) val /= 10; // ambient_generic's 0..10
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
    for (const v of this.voices) if (v.spatial) this._update(v);
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
    for (const v of [...this.voices]) this._stopVoice(v);
    this.byEnt.clear();
    this.limits.clear();
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
    for (const a of Object.values(ALIASES)) {
      const def = this.tables.stock.events.get((typeof a === 'string' ? a : a.name).toLowerCase());
      if (def) for (const f of def.files || []) this._buffer(this._fileUrl(this.tables.stock, f));
    }
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
    const files = Array.isArray(def.files) ? def.files : [];
    if (files.length) {
      const file = files[(Math.random() * files.length) | 0];
      const pr = def.pitchRandom;
      const rate = Math.max(0.05, ((def.pitch ?? 1) * hit.pitch + (pr ? pr[0] + Math.random() * (pr[1] - pr[0]) : 0)) * (o.pitch ?? 1));
      const v = {
        def, name: def.name, sources: [], gain: null, pan: null, ent: o.ent, entId: o.entId, pos: o.pos ? [...o.pos] : null,
        slot: o.slot ?? null, follow: o.follow || null, repeat: !!o.repeat,
        offset: o.offset || 0, // seconds already played (a stage that starts mid-ending joins its music mid-track)
        spatial: !!o.pos && !o.local && !def.local && !isMusic, music: isMusic, rate,
        baseVolume: (def.volume ?? 1) * hit.volume * (o.volume ?? 1), userVolume: 1, userPitch: 1, stopped: false,
      };
      this._track(v);
      this._buffer(this._fileUrl(table, file)).then((buf) => {
        if (!buf || v.stopped) { if (!buf) this._untrack(v); return; }
        this._begin(v, buf);
      });
    }
    // child events (e.g. Weapon_AK47.Single -> SingleDistant) play alongside, owned by the same entity
    if (depth < 3 && Array.isArray(def.children)) for (const c of def.children.slice(0, MAX_CHILD_EVENTS)) this._start(c, o, depth + 1);
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
    node.connect(v.gain);
    v.gain.connect(v.music ? this.music : this.sfx);
    v.sources.push(src);
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
    let g = v.baseVolume * v.userVolume, p = 0;
    if (v.spatial) {
      const pos = (v.ent && v.ent.alive !== false && (v.follow ? safeCall(v.follow) : typeof v.ent.worldOrigin === 'function' && safeOrigin(v.ent))) || v.pos;
      ({ gain: g, pan: p } = spatialMix(pos, this.listener, v.def.curve, g));
    }
    const t = this.ctx.currentTime;
    if (immediate) {
      v.gain.gain.setValueAtTime(g, t);
      if (v.pan) v.pan.pan.setValueAtTime(p, t);
    } else {
      v.gain.gain.setTargetAtTime(g, t, 0.03);
      if (v.pan) v.pan.pan.setTargetAtTime(p, t, 0.03);
    }
  }

  _stopVoice(v) {
    if (v.stopped) return;
    v.stopped = true;
    const t = this.ctx.currentTime;
    if (v.gain) {
      // a short fade so StopSound doesn't click
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + 0.05);
    }
    for (const s of v.sources) { try { s.stop(t + 0.06); } catch { /* not started */ } }
    if (!v.sources.length) this._untrack(v);
    else setTimeout(() => this._finish(v), 100);
  }

  _finish(v) {
    if (!this.voices.has(v)) return;
    v.stopped = true;
    try { v.gain?.disconnect(); v.pan?.disconnect(); } catch { /* already gone */ }
    this._untrack(v);
  }
}

function safeOrigin(ent) {
  try { const o = ent.worldOrigin(); return o && o.length >= 3 ? o : null; } catch { return null; }
}
function safeCall(fn) {
  try { const o = fn(); return o && o.length >= 3 ? o : null; } catch { return null; }
}
