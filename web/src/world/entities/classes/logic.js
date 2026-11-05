// Pure logic entities: relays, cases, branches, compares, counters, timers, logic_auto, and
// logic_measure_movement (which ZE maps use to glue hurt triggers to moving things).
import { register } from '../registry.js';
import { Entity } from '../entity.js';
import { num, bool } from '../math.js';

register('logic_relay', {
  input(e, inp, p, act) {
    if (inp === 'trigger') {
      if (!e.enabled) return true;
      e.fireOutput('OnTrigger', act);
      if ((num(e.kv.spawnflags) & 1)) e.engine.kill(e);
      return true;
    }
    if (inp === 'cancelpending') { e.engine.cancelPending(e); return true; }
    if (inp === 'enablerefire') { e.enabled = true; return true; }
  },
});

// The cases to pick from are the OnCase01..32 outputs that have a connection *when the input arrives*
// (server.dll's case map builder, run by PickRandom / PickRandomShuffle / ResetShuffle, walks each output's
// connection list then): a case whose outputs come from AddOutput later counts once they're added, and one whose
// only-once connections have all fired drops out. westersand's Boss_Attack_AirCase has no outputs of its own until
// Boss_Attack_RandomPath adds them.
const MAX_CASES = 32;
const liveCases = (e) => {
  const has = new Set();
  for (const c of e.io) { const m = /^oncase(\d+)$/i.exec(c.output); if (m && +m[1] >= 1 && +m[1] <= MAX_CASES) has.add(+m[1]); }
  return [...has].sort((a, b) => a - b);
};
const pick = (e, n) => Math.floor(e.engine.random() * n);

register('logic_case', {
  spawn(e) {
    e.state.deck = []; e.state.left = 0; e.state.last = -1;
  },
  input(e, inp, p, act) {
    const fire = (n) => e.fireOutput(`OnCase${String(n).padStart(2, '0')}`, act);
    if (inp === 'pickrandom') {
      const cs = liveCases(e);
      if (cs.length) fire(cs[pick(e, cs.length)]);
      return true;
    }
    // server.dll: a deck of the live cases, drawn without replacement (the drawn slot takes the deck's last card).
    // A new deck of 2+ never starts with the case the previous deck ended on: that card goes last and is left out
    // of the first draw.
    if (inp === 'pickrandomshuffle') {
      const s = e.state;
      let range = s.left;
      if (!s.left) {
        s.deck = liveCases(e); s.left = range = s.deck.length;
        if (range > 1) {
          const i = s.deck.indexOf(s.last);
          if (i >= 0) { range--; [s.deck[i], s.deck[range]] = [s.deck[range], s.deck[i]]; }
        }
      }
      if (range <= 0) return true;
      const i = pick(e, range), n = s.deck[i];
      fire(n);
      s.deck[i] = s.deck[s.left - 1]; s.left--; s.last = n;
      return true;
    }
    if (inp === 'invalue') {
      for (let i = 1; i <= 32; i++) {
        const k = `case${String(i).padStart(2, '0')}`;
        if (e.kv[k] != null && String(e.kv[k]) === String(p)) { fire(i); return true; }
      }
      e.fireOutput('OnDefault', act, p);
      return true;
    }
    // server.dll rebuilds a full deck here (it doesn't just empty it, so no last-case rule on its first draw)
    if (inp === 'resetshuffle') { e.state.deck = liveCases(e); e.state.left = e.state.deck.length; return true; }
  },
});

register('logic_branch', {
  spawn(e) { e.state.v = num(e.kv.initialvalue) ? 1 : 0; },
  input(e, inp, p, act) {
    const test = () => e.fireOutput(e.state.v ? 'OnTrue' : 'OnFalse', act);
    switch (inp) {
      case 'setvalue': e.state.v = num(p) ? 1 : 0; return true;
      case 'setvaluetest': e.state.v = num(p) ? 1 : 0; test(); return true;
      case 'toggle': e.state.v ^= 1; return true;
      case 'toggletest': e.state.v ^= 1; test(); return true;
      case 'test': test(); return true;
    }
  },
});

register('logic_compare', {
  spawn(e) { e.state.v = num(e.kv.initialvalue); e.state.c = num(e.kv.comparevalue); },
  input(e, inp, p, act) {
    const cmp = () => {
      const { v, c } = e.state;
      if (v < c) e.fireOutput('OnLessThan', act, v);
      if (v === c) e.fireOutput('OnEqualTo', act, v);
      if (v !== c) e.fireOutput('OnNotEqualTo', act, v);
      if (v > c) e.fireOutput('OnGreaterThan', act, v);
    };
    switch (inp) {
      case 'setvalue': e.state.v = num(p); return true;
      case 'setvaluecompare': e.state.v = num(p); cmp(); return true;
      case 'setcomparevalue': e.state.c = num(p); return true;
      case 'compare': cmp(); return true;
    }
  },
});

register('math_counter', {
  spawn(e) {
    e.state.min = num(e.kv.min); e.state.max = num(e.kv.max); e.state.v = num(e.kv.startvalue);
  },
  input(e, inp, p, act) {
    const s = e.state;
    const set = (v, fire = true) => {
      if (!e.enabled) return;
      const hasRange = s.min !== 0 || s.max !== 0;
      if (hasRange) v = Math.max(s.min, Math.min(s.max, v));
      const prev = s.v;
      s.v = v;
      if (fire) e.fireOutput('OutValue', act, v);
      if (hasRange && v >= s.max && prev < s.max) e.fireOutput('OnHitMax', act);
      if (hasRange && v <= s.min && prev > s.min) e.fireOutput('OnHitMin', act);
    };
    switch (inp) {
      case 'add': set(s.v + num(p)); return true;
      case 'subtract': set(s.v - num(p)); return true;
      case 'multiply': set(s.v * num(p)); return true;
      case 'divide': if (num(p)) set(s.v / num(p)); return true;
      case 'setvalue': set(num(p)); return true;
      case 'setvaluenofire': set(num(p), false); return true;
      case 'getvalue': e.fireOutput('OnGetValue', act, s.v); return true;
      case 'sethitmax': s.max = num(p); return true;
      case 'sethitmin': s.min = num(p); return true;
      case 'setmaxvalue': s.max = num(p); return true;
      case 'setminvalue': s.min = num(p); return true;
    }
  },
});

const MAX_FIRES = 100; // per tick; the 0.01 s minimum refire fires at most 2 per 1/64 s tick
const logicTimer = register('logic_timer', {
  spawn(e) { e.state.next = e.enabled ? e.engine.time + logicTimer.interval(e) : Infinity; },
  interval(e) {
    if (bool(e.kv.userandomtime)) {
      const lo = num(e.kv.lowerrandombound), hi = num(e.kv.upperrandombound);
      return lo + e.engine.random() * (hi - lo);
    }
    return Math.max(0.01, num(e.kv.refiretime, 1));
  },
  input(e, inp, p, act) {
    const T = logicTimer;
    switch (inp) {
      case 'enable': if (!e.enabled) { e.enabled = true; e.state.next = e.engine.time + T.interval(e); } return true;
      case 'disable': e.enabled = false; e.state.next = Infinity; return true;
      case 'toggle': return T.input(e, e.enabled ? 'disable' : 'enable', p, act);
      case 'refiretime': e.kv.refiretime = p; if (e.enabled) e.state.next = e.engine.time + T.interval(e); return true;
      case 'resettimer': if (e.enabled) e.state.next = e.engine.time + T.interval(e); return true;
      case 'firetimer': e.fireOutput('OnTimer', act); return true;
      case 'lowerrandombound': e.kv.lowerrandombound = p; return true;
      case 'upperrandombound': e.kv.upperrandombound = p; return true;
    }
  },
  think(e) {
    if (!e.enabled) return;
    // a refire of 0 or less (random bounds are the map's data) would never catch up: at most MAX_FIRES a tick
    for (let n = 0; e.engine.time >= e.state.next; n++) {
      if (n >= MAX_FIRES) { e.state.next = e.engine.time + 0.01; e.engine.warnOnce(`timer:${e.key}`, `logic_timer ${e.name}: refire too fast`); break; }
      e.fireOutput('OnTimer', e);
      if (!e.alive || !e.enabled) break;
      e.state.next += logicTimer.interval(e);
    }
  },
});

register('logic_auto', {});

// Moves `target` so it sits relative to `targetreference` the way `measuretarget` sits relative to
// `measurereference`. ZE maps use it to glue hurt triggers to moving things (often all three the same).
const measureMovement = register('logic_measure_movement', {
  spawn(e) {
    e.state.scale = num(e.kv.targetscale, 1);
  },
  input(e, inp, p, act, caller) {
    const set = (k) => { e.kv[k] = p; return true; };
    switch (inp) {
      case 'setmeasuretarget': return set('measuretarget');
      case 'setmeasurereference': return set('measurereference');
      case 'settarget': return set('target');
      case 'settargetreference': return set('targetreference');
      case 'settargetscale': e.state.scale = num(p, 1); return true;
      case 'enable': e.enabled = true; return true;
      case 'disable': e.enabled = false; return true;
    }
    void act; void caller;
  },
  matrixOf(engine, name) {
    if (!name) return null;
    const x = engine.findOne(name);
    if (!x) return null;
    if (x === engine.playerEnt) return engine.playerMatrix?.() || null;
    return x.getWorld();
  },
  think(e) {
    if (!e.enabled) return;
    const E = e.engine;
    const M = measureMovement;
    const meas = M.matrixOf(E, e.kv.measuretarget), mref = M.matrixOf(E, e.kv.measurereference), tref = M.matrixOf(E, e.kv.targetreference);
    if (!meas || !mref || !tref) return;
    const rel = mref.clone().invert().multiply(meas);
    if (e.state.scale !== 1) {
      const el = rel.elements;
      el[12] *= e.state.scale; el[13] *= e.state.scale; el[14] *= e.state.scale;
    }
    const w = tref.clone().multiply(rel);
    for (const t of E.find(e.kv.target)) {
      if (t instanceof Entity && t !== e) {
        const prev = t.getWorld().elements;
        if (prev.some((v, i) => Math.abs(v - w.elements[i]) > 1e-4)) t.setWorldTransform(w);
      }
    }
  },
});
