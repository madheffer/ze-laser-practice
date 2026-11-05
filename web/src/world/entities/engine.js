// The map's own logic, run in the browser: entities from entities.json, their I/O connections, and the
// classes laser stages are built from (classes/*.js). A scenario only says which input starts a wave;
// everything after that is the map talking to itself, the same as on a server.
//
// Unknown classes still exist (they can be parents, be killed, have outputs fired by user inputs); they
// just ignore inputs they don't implement, and the first time each one happens it is logged once.
import * as THREE from 'three';
import { C } from './registry.js';
import { Entity, stripName } from './entity.js';
import { ONE, parseVec, angleQuat, mulberry32, poseMatrix } from './math.js';
import { addOutput, playerInput, splitKeyValues } from './keyvalues.js';
import { emptyBounds, growBounds } from '../../lib/math.js';
import * as triggers from './classes/triggers.js';
import './classes/logic.js';
import './classes/spawners.js';
import './classes/movers.js';
import './classes/brushes.js';
import './classes/props.js';
import './classes/fx.js';
import './classes/physics.js';
import './classes/server.js';
import './classes/beams.js';
import { fogState } from './classes/fog.js';
import { postState } from './classes/post.js';
import { breakSound, hitSound } from './sound.js';

// Limits on what a map's data can make the engine do (a map is untrusted). Far above any real map:
// ze_mist_p peaks at ~2000 live entities in a firestorm wave and ~20 simulated humans.
const MAX_ENTITIES = 50000;
const MAX_HUMANS = 256;

// entities.json's lumps: { name: [{kv, io}] }; anything else in there is dropped, not trusted to have a shape.
function validLumps(lumps) {
  const out = {};
  if (!lumps || typeof lumps !== 'object') return out;
  for (const [k, list] of Object.entries(lumps)) {
    if (Array.isArray(list)) out[k] = list.filter((d) => d && typeof d === 'object' && d.kv && typeof d.kv === 'object');
  }
  return out;
}

function addTo(index, key, e) {
  let set = index.get(key);
  if (!set) index.set(key, (set = new Set()));
  set.add(e);
}

export class EntityEngine {
  constructor(entitiesJson, assets, { seed = 1 } = {}) {
    this.assets = assets; // { hulls: {model: [...]}, bounds: {model:{min,max}}, animations?: animations.json (classes/props.js) }
    this.lumps = validLumps(entitiesJson?.lumps);
    this.live = 0; // entities alive (bounded by MAX_ENTITIES)
    this.time = 0;
    this.stamp = 0;
    this.queue = [];
    this.order = 0;
    this.ents = [];
    this.byKey = new Map();
    this.byClass = new Map();
    this.nextId = 1;
    this.fixup = 0;
    this.rng = mulberry32(seed);
    this.warned = new Set();
    this.moveStamps = new WeakMap();
    this.touching = new Set();
    this.listeners = { spawn: [], kill: [], hit: [], log: [], sound: [], cvar: [], say: [] }; // say: point_servercommand "say ..." (classes/server.js)
    // The player as an I/O target / activator. worldOrigin() so "at the activator / at !player" spawns work, and
    // getWorld() + children so SetParent(!activator) makes an entity follow you (westersand's Xzone marker). The
    // session sets playerMatrix (a THREE.Matrix4, or anything with column-major `elements`); without one, e.g.
    // headless with no --player, the player is at the map origin.
    const engine = this;
    this.playerEnt = {
      name: '!player', key: '!player', cls: 'player', team: 3, alive: true, parent: null, children: new Set(),
      getWorld() {
        const m = engine.playerMatrix?.();
        return m?.isMatrix4 ? m : new THREE.Matrix4().fromArray(m?.elements || new THREE.Matrix4().elements);
      },
      worldOrigin() { const e = this.getWorld().elements; return [e[12], e[13], e[14]]; },
    };
    // the simulated team, as the activator of its bullets: a human (team 3) who isn't you, so a map output aimed at
    // !activator on a boss hit (ze_dreamin's Reflection: point_hurt !activator) lands on them, not on you
    this.teamEnt = { name: '!team', key: '!team', cls: 'player', team: 3, alive: true, parent: null, children: new Set(), getWorld: () => new THREE.Matrix4(), worldOrigin: () => [0, 0, 0] };
    this.templateLumps = new Set();
    this.humans = 1;
    this.traceBox = null; // (start, end, halfExtents) -> trace against the static world; session.js sets it (physics.js)

    // Lumps a point_template points at are templates: they only exist when something spawns them.
    const lumpKeys = new Map(Object.keys(this.lumps).map((k) => [k.toLowerCase(), k]));
    for (const [, ents] of Object.entries(this.lumps)) {
      for (const d of ents) {
        if (String(d.kv.classname || '').toLowerCase() === 'point_template' && d.kv.entitylumpname) {
          const k = lumpKeys.get(String(d.kv.entitylumpname).toLowerCase());
          if (k) this.templateLumps.add(k);
        }
      }
    }
    this.lumpKeys = lumpKeys;
  }

  random() { return this.rng(); }
  on(ev, fn) { this.listeners[ev].push(fn); }
  emit(ev, ...a) { for (const fn of this.listeners[ev]) fn(...a); }
  warnOnce(k, msg) { if (!this.warned.has(k)) { this.warned.add(k); this.emit('log', msg); } }

  // Spawn every non-template entity at map start.
  spawnWorld() {
    const created = [];
    for (const [lump, ents] of Object.entries(this.lumps)) {
      if (this.templateLumps.has(lump)) continue;
      for (const d of ents) {
        const e = this.create(d);
        e.pos.set(...parseVec(d.kv.origin));
        angleQuat(parseVec(d.kv.angles), e.quat);
        created.push(e);
      }
    }
    this.link(created);
    for (const e of created) this.spawnHook(e);
  }

  create(d) {
    const e = new Entity(this, d, this.nextId++);
    this.ents.push(e);
    this.live++;
    if (e.key) addTo(this.byKey, e.key, e);
    addTo(this.byClass, e.cls, e);
    return e;
  }

  link(list) {
    // parent after everything in the batch exists; keep world transforms
    for (const e of list) {
      const pn = e.kv.parentname;
      if (!pn) continue;
      const p = list.find((x) => x.key === stripName(pn)) || this.findOne(pn);
      if (p && p !== e && !e.wouldCycle(p)) {
        const w = new THREE.Matrix4().compose(e.pos, e.quat, ONE);
        e.parent = p;
        p.children.add(e);
        const local = w.premultiply(p.getWorld().clone().invert());
        local.decompose(e.pos, e.quat, new THREE.Vector3());
      }
    }
    this.stamp++;
  }

  spawnHook(e) {
    C[e.cls]?.spawn?.(e);
    this.emit('spawn', e);
    // CS2 entities fire OnSpawn as they spawn (ze_dreamin's template relays start every moving attack with it)
    if (e.io.some((c) => c.output.toLowerCase() === 'onspawn')) e.fireOutput('OnSpawn', null);
  }

  // Spawn a point_template's lump with the template's local layout placed by matrix `at`.
  spawnTemplate(tpl, at, activator, maker) {
    const lk = this.lumpKeys.get(String(tpl.kv.entitylumpname || '').toLowerCase());
    if (!lk) { this.warnOnce('tpl:' + tpl.key, `template ${tpl.name} has no lump`); return []; }
    // a map that spawns templates in a loop (an I/O loop, a fast timer) can't take the page down with it
    if (this.live + this.lumps[lk].length > MAX_ENTITIES) { this.warnOnce('maxents', `over ${MAX_ENTITIES} entities: spawns dropped`); return []; }
    const fix = tpl.kv.templatefixup === '0' || tpl.kv.templatefixup === 'false' ? null : `&${String(++this.fixup).padStart(4, '0')}`;
    const fx = (s) => (fix && typeof s === 'string' ? s.replace(/&0000/g, fix) : s);
    const created = [];
    for (const d of this.lumps[lk]) {
      // no prototype on kv: a "__proto__" key is a plain key here, as it is in the JSON
      const data = { kv: Object.create(null), io: (Array.isArray(d.io) ? d.io : []).map((c) => ({ ...c, target: fx(c?.target) })) };
      for (const [k, v] of Object.entries(d.kv)) data.kv[k] = fx(v);
      const e = this.create(data);
      e.fromTemplate = true;
      const local = poseMatrix(parseVec(d.kv.origin), angleQuat(parseVec(d.kv.angles)));
      local.premultiply(at);
      local.decompose(e.pos, e.quat, new THREE.Vector3());
      created.push(e);
    }
    this.link(created);
    for (const e of created) this.spawnHook(e);
    for (const e of created) {
      // spawned entities that are themselves timers/relays etc. get their spawn behaviour above
      if (e.cls === 'logic_auto') e.fireOutput('OnMapSpawn', activator);
    }
    // point_template's own output fires for its ForceSpawn; a maker spawning through it fires the maker's
    if (maker) maker.fireOutput('OnEntitySpawned', activator);
    else tpl.fireOutput('OnEntitySpawned', activator);
    return created;
  }

  kill(e) {
    if (!e.alive) return;
    e.alive = false;
    for (const c of [...e.children]) {
      // Source: children of a killed parent are killed too
      this.kill(c);
    }
    this.live--;
    C[e.cls]?.killed?.(e); // a class's own removal (a train's stop sound)
    if (e.parent) e.parent.children.delete(e);
    this.byKey.get(e.key)?.delete(e);
    this.byClass.get(e.cls)?.delete(e);
    // no cancelPending here: in Source a removed entity's queued outputs still fire (a trigger_once is removed on
    // touch and its delayed outputs run after); only the CancelPending input drops them
    this.untouch(e);
    this.emit('kill', e);
  }

  // ---- health

  healthChanged(e, activator) {
    const s = e.state;
    e.fireOutput('OnHealthChanged', activator, Math.max(0, s.health) / Math.max(1, s.max));
  }

  // A hit for `amount` (one bullet). Breakables die at 0; physboxes only break when told to, because ZE
  // bosses count their segments with OnHealthChanged and get topped back up by the map.
  // trace: a bullet / knife hit (CS2's TraceAttack, which plays the breakable's hit sound before any filter or
  // health rule: sound.js hitSound); the map's RemoveHealth is not one. alt: the hit's RandomInt(0, 1), rolled by the caller.
  damage(e, amount, activator, { unfiltered = false, trace = false, alt = false } = {}) {
    if (!e.alive || !C[e.cls] || e.state.health == null) return;
    if (trace) hitSound(e, alt);
    const s = e.state;
    if (s.max <= 1 && s.health <= 0 && e.cls === 'func_breakable') return; // health 0 = unbreakable
    // a damage filter that keeps humans out (ze_deadcore's cube cores until the cube wakes up: SetDamageFilter human)
    if (!unfiltered && !triggers.filterPasses(this, e.kv.damagefilter)) return;
    s.health -= amount;
    e.fireOutput('OnDamaged', activator);
    this.healthChanged(e, activator);
    if (s.health <= 0) {
      // breakables break at 0; so does a physbox that spawned with health (Source CPhysBox is a CBreakable:
      // ze_dreamin's Puny Light only ends through st2_hitbox.OnBreak). ze_mist_p's dragon never gets there: the map
      // tops it up once it drops under 1% of its spawn health
      if (e.cls === 'func_breakable' || (s.max > 1 && /^func_physbox/.test(e.cls))) this.breakEntity(e, activator);
      else s.health = 0;
    }
  }

  breakEntity(e, activator) {
    if (!e.alive) return;
    breakSound(e); // CBreakable::Die: the material's break sound (sound.js)
    e.fireOutput('OnBreak', activator);
    this.kill(e);
  }

  moved(e) {
    this.stamp++;
    this.moveStamps.set(e, this.stamp);
  }
  // A number that changes whenever e or any ancestor moved.
  moveStamp(e) {
    let s = 0;
    for (let x = e; x; x = x.parent) s = Math.max(s, this.moveStamps.get(x) || 0);
    return s;
  }

  // ---- name lookup

  find(pattern, caller, activator) {
    if (!pattern) return [];
    const p = String(pattern);
    const low = p.toLowerCase();
    if (low === '!self') return caller ? [caller] : [];
    if (low === '!caller') return caller ? [caller] : [];
    if (low === '!activator') return activator ? [activator] : [];
    if (low === '!player' || low === '!pvsplayer') return [this.playerEnt];
    const key = stripName(p);
    // the player renamed by the map (AddOutput targetname on !activator: ze_deadcore's meteors tag their target)
    if (key === this.playerEnt.key) return [this.playerEnt];
    if (key.endsWith('*')) {
      const pre = key.slice(0, -1);
      const out = [];
      for (const [k, set] of this.byKey) if (k.startsWith(pre)) for (const e of set) out.push(e);
      if (!out.length) for (const [k, set] of this.byClass) if (k.startsWith(pre)) for (const e of set) out.push(e);
      return out;
    }
    const s = this.byKey.get(key);
    if (s && s.size) return [...s];
    const c = this.byClass.get(key);
    return c ? [...c] : [];
  }
  findOne(pattern, caller, activator) { return this.find(pattern, caller, activator)[0] || null; }

  // ---- I/O

  fireOutput(e, output, activator, param) {
    const low = output.toLowerCase();
    // Boss HP in ZE maps grows per human who touches an "add HP" trigger. You are one player standing in
    // for `humans` of them, so those adds repeat once per simulated human.
    const fromTouch = activator === this.playerEnt && (low === 'onstarttouch' || low === 'ontrigger' || low === 'onstarttouchall');
    for (let i = 0; i < e.io.length; i++) {
      const c = e.io[i];
      if (c.output.toLowerCase() !== low) continue;
      const p = c.param !== '' && c.param != null ? c.param : (param != null ? String(param) : '');
      const inl = c.input.toLowerCase();
      const reps = fromTouch && (inl === 'addhealth' || inl === 'add') ? Math.min(MAX_HUMANS, Math.max(1, this.humans | 0)) : 1;
      for (let r = 1; r < reps; r++) this.queue.push({ t: this.time + (c.delay || 0), o: this.order++, target: c.target, input: c.input, param: p, activator, caller: e });
      this.queue.push({ t: this.time + (c.delay || 0), o: this.order++, target: c.target, input: c.input, param: p, activator, caller: e });
      if (c.times > 0 && --c.times === 0) { e.io.splice(i, 1); i--; }
    }
  }

  // Fire an input at a target pattern (or entity), after delay seconds.
  fire(target, input, param = '', delay = 0, activator = null, caller = null) {
    this.queue.push({ t: this.time + delay, o: this.order++, target, input, param, activator, caller });
  }

  cancelPending(e) {
    this.queue = this.queue.filter((q) => q.caller !== e);
  }

  // Run fn after `delay` seconds of engine time, in order with the map's own queued inputs (app/items.js: a pickup
  // just after the item spawns). Follows fast-forward and pauses, unlike setTimeout.
  after(delay, fn) {
    this.queue.push({ t: this.time + delay, o: this.order++, fn });
  }

  dispatch(q) {
    if (q.fn) { q.fn(); return; }
    const targets = q.target instanceof Entity ? [q.target] : this.find(q.target, q.caller, q.activator);
    if (!targets.length) return;
    for (const t of targets) {
      if (!t.alive) continue;
      if (t === this.playerEnt) { this.playerInput(q); continue; }
      this.input(t, q.input, q.param, q.activator, q.caller);
    }
  }

  input(e, input, param, activator, caller) {
    const inp = input.toLowerCase();
    // class first, so classes can override the generic ones (Enable on a timer, etc.)
    const h = C[e.cls];
    if (h?.input && h.input(e, inp, param, activator, caller)) return;
    switch (inp) {
      case 'kill': this.kill(e); return;
      case 'killhierarchy': this.kill(e); return;
      // a prop's Break (westersand's hall pillars); breakables have their own (classes/brushes.js)
      case 'break': this.breakEntity(e, activator); return;
      case 'lock': case 'unlock': e.state.locked = inp === 'lock'; return; // buttons: no player use here
      case 'fireuser1': case 'fireuser2': case 'fireuser3': case 'fireuser4':
        e.fireOutput('OnUser' + inp.slice(-1), activator); return;
      case 'enable': e.enabled = true; return;
      case 'disable': e.enabled = false; return;
      case 'toggle': e.enabled = !e.enabled; return;
      case 'setparent': e.setParent(this.findOne(param, caller, activator)); return;
      case 'clearparent': e.setParent(null); return;
      case 'setparentattachment': case 'setparentattachmentmaintainoffset': return;
      case 'addoutput': case 'keyvalue': this.addOutput(e, param); return;
      case 'keyvalues': for (const kv of splitKeyValues(param)) this.addOutput(e, kv); return;
      case 'setlocalorigin': e.pos.set(...parseVec(param)); this.moved(e); return;
      case 'setlocalangles': angleQuat(parseVec(param), e.quat); this.moved(e); return;
      case 'setabsorigin': {
        const w = e.getWorld().clone();
        w.setPosition(...parseVec(param));
        e.setWorldTransform(w); return;
      }
      case 'setabsangles': {
        e.setWorldTransform(poseMatrix(e.worldOrigin(), angleQuat(parseVec(param)))); return;
      }
      case 'alpha': case 'color': case 'skin': case 'setglowenabled': case 'setglowdisabled':
      case 'setanimation': case 'setanimationnotlooping': case 'setanimationlooping': case 'setdefaultanimation':
      case 'setplaybackrate': case 'playsound': case 'stopsound': case 'startsound': case 'volume': case 'turnon': case 'turnoff':
      case 'setscale': case 'setbodygroup': case 'disablecollision': case 'enablecollision': case 'start': case 'stop':
      case 'showhudhint': case 'command': case 'setmessage': case 'display': case 'fade':
        return;
      case 'disablemotion': case 'enablemotion': case 'wake': case 'sleep': return;
    }
    this.warnOnce(`${e.cls}.${inp}`, `unhandled ${e.cls}.${input}`);
  }

  // Watch (or swallow) inputs: fn(e, input) runs before every input; returning true swallows it. The last hook
  // installed runs first. Scenarios use it for win / lose and endless mode's cancels.
  hookInput(fn) {
    const next = this.input.bind(this);
    this.input = (e, input, ...rest) => (fn(e, input) ? undefined : next(e, input, ...rest));
  }

  addOutput(e, param) { addOutput(this, e, param); }
  playerInput(q) { playerInput(this, q); }

  // the fog the player sees now (classes/fog.js): read by the renderer each frame
  fogState() { return fogState(this); }
  // the post_processing_volume the player sees now and its fade (classes/post.js): read by world/tonemap.js
  postState() { return postState(this); }

  // A new targetname (AddOutput targetname): move e in the name index.
  rename(e, name) {
    this.byKey.get(e.key)?.delete(e);
    e.name = name; e.key = stripName(name);
    addTo(this.byKey, e.key, e);
  }

  // ---- triggers (classes/triggers.js)

  untouch(e) { triggers.untouch(this, e); }
  passesFilter(e) { return triggers.passesFilter(this, e); }
  // Called every tick with the player's hull. Fires touch outputs; returns hurt/heal/push/teleport events.
  updateTriggers(player) { return triggers.updateTriggers(this, player); }

  // Solid brush entities, for the collision world.
  solids() {
    const out = [];
    for (const e of this.ents) {
      if (!e.alive) continue;
      const h = C[e.cls];
      if (!h?.solid || !h.solid(e)) continue;
      const hulls = e.hulls();
      if (!hulls) continue;
      const solid = hulls.filter((x) => x.solid !== false);
      if (!solid.length) continue;
      const { min, max } = emptyBounds();
      for (const x of solid) growBounds(min, max, x.min, x.max);
      out.push({ hulls: solid, min, max, ref: e });
    }
    return out;
  }

  tick(dt) {
    this.time += dt;
    // entities parented to the player follow it: their cached world matrices / hulls go stale as you move
    if (this.playerEnt.children.size) this.moved(this.playerEnt);
    // events due this tick, in order; events fired with 0 delay during dispatch also run this tick
    let guard = 0;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i];
        if (q.t <= this.time + 1e-9 && (best < 0 || q.t < this.queue[best].t || (q.t === this.queue[best].t && q.o < this.queue[best].o))) best = i;
      }
      if (best < 0) break;
      const q = this.queue.splice(best, 1)[0];
      // a map input the engine trips over is logged once and skipped, never the end of the run
      try { this.dispatch(q); } catch (err) { this.warnOnce(`err:${String(q.input).toLowerCase()}`, `input ${q.input} on ${q.target?.name || q.target} failed: ${err?.message || err}`); }
      if (++guard > 20000) { this.warnOnce('loop', 'I/O loop: over 20000 events in one tick'); this.queue = []; break; }
    }
    for (const e of this.ents) {
      if (!e.alive) continue;
      const th = C[e.cls]?.think;
      if (th) { try { th(e, dt); } catch (err) { this.warnOnce(`think:${e.cls}`, `${e.cls} think failed: ${err?.message || err}`); } }
    }
    // drop dead entities now and then
    if (this.ents.length > 4000 && this.ents.some((e) => !e.alive)) this.ents = this.ents.filter((e) => e.alive);
  }
}
