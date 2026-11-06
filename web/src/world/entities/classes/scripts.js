// point_script: a map's CS2 JavaScript (cs_script). Scripts are code, and the game never runs a map's code (no eval),
// so a script runs here only as a hand port of a known one. The port is the script's fixed logic; the numbers that
// differ per map (its table of bosses) come from the stage's `scripts` field, copied from the map's own script:
//
//   "scripts": { "[PR#]script_bosshud": { "port": "bosshud",
//     "bosses": { "InitBossAlien2": { "name": "Alien", "start": 1, "max": 20000, "perHuman": 85, "relay": "laser_boss_dead" } },
//     "adds": ["Alien2AddHealth"],
//     "damage": { "Alien2Damage": 1, "Alien2DamageLaser": 55 } } }
//
// A RunScriptInput the port doesn't know is logged once as unhandled, like any other input.
import { register } from '../registry.js';
import { nameKey } from '../../../lib/names.js';
import { own } from '../../../lib/storage.js';
import { cosmo } from './scripts-cosmo.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---- bosshud.js (GFL's BossHud port, scripts/vscripts/bosshud.vjs: ze_alien_shooter). One boss at a time:
// init sets hp = max = start; each add raises both by the boss's hp_per_human, capped at its max_hp; StartBoss starts
// the fight and its CheckHealth loop (re-fired every 0.01 s through the I/O queue); damage only lands during the
// fight; at hp <= 0 the loop fires the boss's death relay, disables bhud_timer and resets. Its hudhint text is the
// game's own boss HUD here (state.v / state.max, app/bosses.js "hits" counter); the sprite bar's alpha is kept.
const bosshud = {
  reset(s) {
    Object.assign(s, { v: 0, max: 0, cap: 0, perHuman: 0, relay: '', sprite: '', segments: 0, fight: false });
  },
  run(e, cfg, name, act) {
    const s = e.state;
    const boss = own(cfg.bosses, name);
    if (boss) {
      s.v = s.max = num(boss.start, 1); s.cap = num(boss.max); s.perHuman = num(boss.perHuman);
      s.relay = String(boss.relay || ''); s.sprite = String(boss.sprite || ''); s.segments = num(boss.segments);
      return true;
    }
    if (Array.isArray(cfg.adds) && cfg.adds.includes(name)) {
      s.max += s.perHuman; s.v += s.perHuman;
      if (s.max > s.cap) { s.max = s.cap; s.v = s.cap; }
      return true;
    }
    const dmg = own(cfg.damage, name);
    if (dmg != null) { if (s.fight) s.v -= num(dmg); return true; }
    switch (name) {
      case 'StartBoss':
        s.fight = true;
        e.engine.fire('bhud_timer', 'Enable', '', 0, act, e);
        return bosshud.check(e, act);
      case 'CheckHealth': return bosshud.check(e, act);
      case 'ResetScript': bosshud.reset(s); e.engine.fire('hide_hud', 'CountPlayersInZone', '', 0, act, e); return true;
    }
    return false;
  },
  check(e, act) {
    const s = e.state;
    if (!s.fight) return true;
    if (s.v <= 0) {
      s.fight = false;
      e.engine.fire(s.relay, 'Trigger', '', 0, act, e);
      e.engine.fire('bhud_timer', 'Disable', '', 0, act, e);
      bosshud.reset(s);
      e.engine.fire('hide_hud', 'CountPlayersInZone', '', 0, act, e);
      return true;
    }
    if (s.sprite) e.engine.fire(s.sprite, 'SetAlphaScale', String(Math.ceil((s.v / Math.max(1, s.max)) * s.segments)), 0, act, e);
    e.engine.fire(e.name, 'RunScriptInput', 'CheckHealth', 0.01, act, e);
    return true;
  },
};
// ---- minigames (ze_rush_b's scripts/rushb.vjs: StartMiniGame1-3 + MiniGameCheckPlayers). A start input picks its
// minigame (cfg.minigames[input]: humans_pos `pos`, checkRadius `radius`, minigameTime `time`, minigame_f `fail`,
// minigame_s `success`) and runs the check loop: re-fired every 0.01 s through the I/O queue, it counts down by the
// game time passed; no live human (team 3) within the radius fires `fail` and ends the loop (the script returns
// without re-firing), the clock reaching 0 fires `success` and stops. The script's zombie side
// (zombies_pos, minigame_zm_*) needs zombies, which a trainer has none of; its hudhint countdown is HUD text only.
const minigames = {
  reset(s) { Object.assign(s, { game: null, left: 0, ticking: false, last: null }); },
  run(e, cfg, name, act) {
    const s = e.state;
    const g = own(cfg.minigames, name);
    if (g) {
      s.game = g; s.left = num(g.time); s.ticking = true;
      e.engine.fire(e.name, 'RunScriptInput', 'MiniGameCheckPlayers', 0, act, e);
      return true;
    }
    if (name !== 'MiniGameCheckPlayers') return false;
    if (!s.ticking || !s.game) return true;
    const now = e.engine.time;
    if (s.last === null) s.last = now;
    s.left -= now - s.last;
    s.last = now;
    const g2 = s.game, c = Array.isArray(g2.pos) ? g2.pos.map((v) => num(v)) : [0, 0, 0], r = num(g2.radius);
    const p = e.engine.playerEnt;
    const o = p.worldOrigin();
    const inside = p.alive !== false && p.team === 3 && (o[0] - c[0]) ** 2 + (o[1] - c[1]) ** 2 + (o[2] - c[2]) ** 2 <= r * r;
    if (!inside) { if (g2.fail) e.engine.fire(String(g2.fail), 'Trigger', '', 0, act, e); return true; }
    if (s.left <= 0) {
      e.engine.fire(String(g2.success), 'Trigger', '', 0, act, e);
      s.last = null; s.ticking = false;
      return true;
    }
    e.engine.fire(e.name, 'RunScriptInput', 'MiniGameCheckPlayers', 0.01, act, e);
    return true;
  },
};
const PORTS = { bosshud, minigames, cosmo };

// the stage's `scripts` (keyed by the point_script's targetname) onto the engine, before the world spawns. The adds
// are what fireOutput repeats once per simulated human, like an AddHealth (engine.js)
export function configureScripts(engine, scripts) {
  if (!scripts || typeof scripts !== 'object') return;
  engine.scripts = new Map();
  engine.scriptAdds = new Set();
  for (const [name, cfg] of Object.entries(scripts)) {
    if (!cfg || typeof cfg !== 'object' || !own(PORTS, cfg.port)) continue;
    engine.scripts.set(nameKey(name), cfg);
    for (const a of Array.isArray(cfg.adds) ? cfg.adds : []) engine.scriptAdds.add(String(a).toLowerCase());
  }
}

register('point_script', {
  spawn(e) {
    const cfg = e.engine.scripts?.get(e.key);
    e.port = cfg ? own(PORTS, cfg.port) : null;
    e.portCfg = cfg;
    e.port?.reset(e.state);
  },
  input(e, inp, p, act, caller) {
    if (inp !== 'runscriptinput' || !e.port) return false;
    return e.port.run(e, e.portCfg, String(p ?? ''), act, caller);
  },
});
