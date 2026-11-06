// The map's items, the engine half (pure: world/run-engine.js uses it in the browser and on the co-op server alike).
//
// What items a map has comes from GFL's EntWatch config (tools/entwatch.mjs -> maps/<map>/entwatch.json): name, short
// name, colour, the weapon and its button by hammer id, the cooldown mode / seconds / uses a GFL server enforces.
// mapItems() finds those entities in the map; a human item counts as
//   a HEAL when EntWatch names it so (Heal, Aura, Materia...) or its effect is a heal in the map's own data (a
//     negative-damage trigger_hurt humans pass, two template hops from the item: mist's Cleansing Aura);
//   an ULTIMA (the team's nuke: a countdown, then a blast that fills the screen) when the map's data has one: a
//     start-disabled trigger_hurt of 100000+ that only zombies pass, two template hops from the item, armed (Enable)
//     5 s or more after something fires it. `ultima` is that delay, the fuse: offliner's Shockwave 15 s, westersand's
//     Holy Magick 20 s, tyranny2's Sacred Staff 10 s.
// Zombie items (EntWatch "Zombie ..." / "ZM ...", knives) never count.
//
// Holding an item is what a server does for the human who picked it up, nothing more (the map's entities do the rest):
//   give: spawn the item's template, parent its weapon to the holder, fire the weapon's OnPlayerPickup (mist:
//         AddContext item_heal:1)
//   use:  press its button as the holder (CS2 +use, the E key), refused while EntWatch's cooldown / uses say no; an
//         item whose E goes through the map's script triggers the relay that script fires instead (useInput)
// A holder is you or a teammate (engine.addMate) standing at the team's spawn: a room's ultima holder in your copy of
// the map, or the team's own ultima that goes off by itself. Nobody holds more than one item (lib/room-rules.js).
// ze_mist_p's Cleansing Aura: 2 HP/s for 10 s up to 180, cooldown 60; the map itself disables it during the escape and
// re-enables it when the throne lands.

const HEAL_NAME = /heal|cure|regen|medic|recover|restor|potion/i;
const ZOMBIE_NAME = /^(zombie|zm)\b|\bzm\b|zombie/i;
const ULTIMA_DAMAGE = 100000, ULTIMA_FUSE = 5;
const key = (n) => String(n ?? '').replace(/^\[PR#\]/i, '').toLowerCase();
// a template entity's name as spawned: "&0000" becomes the spawn's own fixup, so look it up by prefix
const findName = (n) => (/&0000$/.test(n) ? n.replace(/&0000$/, '&*') : n);
const truthy = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';

// entities.json lumps + entwatch.json -> [{ id, name, shortname, color, weapon, button, spawn, mode, cooldown, maxuses, heal, ultima }]
export function mapItems(entities, entwatch) {
  const lumps = entities?.lumps || {};
  const all = Object.entries(lumps).flatMap(([lump, es]) => (Array.isArray(es) ? es : []).map((e) => ({ lump, kv: e.kv || {}, io: Array.isArray(e.io) ? e.io : [] })));
  const byHid = new Map(all.filter((e) => e.kv.hammeruniqueid != null).map((e) => [String(e.kv.hammeruniqueid), e]));
  const tplOfLump = new Map(all.filter((e) => e.kv.classname === 'point_template' && e.kv.entitylumpname).map((e) => [e.kv.entitylumpname, e]));
  const lumpOfTpl = new Map(all.filter((e) => e.kv.classname === 'point_template').map((e) => [key(e.kv.targetname), e.kv.entitylumpname]));
  const filters = new Map(all.filter((e) => /^filter_/.test(e.kv.classname)).map((e) => [key(e.kv.targetname), e.kv]));
  const humansPass = (fname) => {
    const f = filters.get(key(fname));
    if (!f) return true;
    if (f.classname === 'filter_activator_team') return (Number(f.filterteam) === 3) !== truthy(f.negated);
    return true;
  };
  // the entities in the item's lump and the lumps its makers spawn (two hops)
  const reach = (lump) => {
    const seen = new Set(), out = [];
    const walk = (l, depth) => {
      if (!l || seen.has(l) || depth > 2) return;
      seen.add(l);
      for (const e of lumps[l] || []) {
        const k = e.kv || {};
        out.push(k);
        if (k.classname === 'env_entity_maker') walk(lumpOfTpl.get(key(k.entitytemplate)), depth + 1);
      }
    };
    walk(lump, 0);
    return out;
  };
  const healsInData = (lump) => reach(lump).some((k) => k.classname === 'trigger_hurt' && Number(k.damage) < 0 && humansPass(k.filtername));
  // the longest delay of an Enable aimed at each name, anywhere in the map (the item's filter / relay arms its hurt)
  let enables = null;
  const enableDelay = (name) => {
    if (!enables) {
      enables = new Map();
      for (const e of all) for (const c of e.io) {
        if (String(c.input || '').toLowerCase() !== 'enable') continue;
        const t = key(c.target), d = Number(c.delay) || 0;
        enables.set(t, Math.max(enables.get(t) ?? 0, d));
      }
    }
    return enables.get(key(name)) ?? null;
  };
  const ultimaFuse = (lump) => {
    let fuse = null;
    for (const k of reach(lump)) {
      if (k.classname !== 'trigger_hurt' || !(Number(k.damage) >= ULTIMA_DAMAGE) || !truthy(k.startdisabled) || !k.filtername || humansPass(k.filtername)) continue;
      const d = enableDelay(k.targetname);
      if (d != null && d >= ULTIMA_FUSE) fuse = Math.max(fuse ?? 0, d);
    }
    return fuse;
  };
  const out = [];
  for (const it of Array.isArray(entwatch?.items) ? entwatch.items : []) {
    const w = byHid.get(String(it.weapon));
    if (!w || !/^weapon_/.test(w.kv.classname || '')) continue;
    // what the holder's E fires, as EntWatch's handler names it: the item's func_button (Press), or the logic_relay a
    // map's script fires when the holder presses +use (Trigger: ze_ffvii_cosmo_canyon_v5_p's cs_script ItemTick does
    // EntFire(Item_Relay_<item>, "Trigger") on WasInputJustPressed(USE))
    const handlers = (it.handlers || []).map((h) => byHid.get(String(h.hammerid))).filter(Boolean);
    const button = handlers.find((e) => e.kv.classname === 'func_button') || handlers.find((e) => e.kv.classname === 'logic_relay');
    const timing = (it.handlers || []).find((h) => h.mode > 0) || {};
    const zombie = ZOMBIE_NAME.test(it.name) || ZOMBIE_NAME.test(it.shortname || '') || w.kv.classname === 'weapon_knife';
    const ultima = zombie ? null : ultimaFuse(w.lump);
    out.push({
      id: String(it.weapon), name: it.name, shortname: it.shortname || it.name, color: it.color || 'white',
      weapon: findName(w.kv.targetname || ''), button: button ? findName(button.kv.targetname || '') : null,
      useInput: button?.kv.classname === 'logic_relay' ? 'Trigger' : 'Press',
      spawn: tplOfLump.get(w.lump)?.kv.targetname || null,
      mode: timing.mode || 0, cooldown: timing.cooldown || 0, maxuses: timing.maxuses || 0,
      usable: !!button, // a heal with no button (gris: its heal runs in the map's cs_script) can't be held here
      zombie, ultima,
      heal: !zombie && ultima == null && (HEAL_NAME.test(it.name) || HEAL_NAME.test(key(w.kv.targetname)) || HEAL_NAME.test(key(tplOfLump.get(w.lump)?.kv.targetname)) || healsInData(w.lump)),
    });
  }
  return out;
}

// Hand `items` (mapItems() entries) to `holder` (you, or a teammate: engine.addMate): spawn, parent, OnPlayerPickup.
// Returns the held state list.
export function giveItems(engine, items, holder = engine.playerEnt) {
  const held = (items || []).filter((it) => it && it.weapon && it.spawn).map((it) => ({ ...it, uses: 0, readyAt: 0, holder }));
  if (!held.length) return [];
  for (const it of held) engine.fire(it.spawn, 'ForceSpawn', '', 0, holder, null);
  // the spawn dispatches on the next tick: hand the weapon over just after it
  engine.after(0.05, () => {
    for (const it of held) {
      // the newest spawn of it: a teammate's copy and yours share the weapon's name
      const ws = engine.find(it.weapon).filter((w) => !w.parent || w.parent === holder);
      const w = ws[ws.length - 1];
      if (!w) continue;
      w.setParent(holder);
      w.pos.set(0, 0, 32); // in their hand, roughly; its children (the button, the aura maker) come along
      engine.moved(w);
      it.weaponEnt = w;
      w.fireOutput('OnPlayerPickup', holder);
    }
    if (holder === engine.playerEnt) engine.emit('log', `holding: ${held.map((it) => it.name).join(', ')} (E to use)`);
  });
  return held;
}

// EntWatch's state for one held item: 'R' ready, seconds left on the cooldown, 'E' used up (modes: 2 cooldown,
// 3 limited uses, 4 uses + cooldown; 0 / 1: no limit)
export function itemState(it, now) {
  const usesLimited = (it.mode === 3 || it.mode === 4) && it.maxuses > 0;
  if (usesLimited && it.uses >= it.maxuses) return 'E';
  if (now < it.readyAt) return String(Math.ceil(it.readyAt - now));
  return usesLimited ? `${it.maxuses - it.uses}/${it.maxuses}` : 'R';
}

// The heals a human can carry here: a heal item with a button (gris's heal runs in its cs_script: not holdable).
// Every heal is a group aura (one holder, the others gather round) until a scenario says otherwise.
export const usableHeals = (items) => (items || []).filter((it) => it.heal && it.usable);
// the map's ultimas with a button (world/items.js mapItems `ultima`)
export const usableUltimas = (items) => (items || []).filter((it) => it.ultima != null && it.usable);

// The one item each kind gives (nobody holds more than one): the map's first heal, its first ultima.
export const mapLoadout = (items) => ({ heal: usableHeals(items)[0] || null, ultima: usableUltimas(items)[0] || null });

// A solo run's items by its rules (your settings, or a replay's): what you hold (one item at most) and the team's
// ultima, held by a teammate at the spawn when it goes off by itself. ultimaItem: 'none' | 'hold' (yours, E) |
// 'auto' (the team's, ultimaAt s after the stage starts); healItem: you hold the heal, unless you hold the ultima.
export function soloLoadout(rules, items) {
  const { heal, ultima } = mapLoadout(items);
  const mode = ultima ? rules?.ultimaItem : 'none';
  const mine = mode === 'hold' ? [ultima] : rules?.healItem && heal ? [heal] : [];
  const mates = mode === 'auto' ? [{ id: 'team', item: ultima, autoAt: Math.max(0, Number(rules.ultimaAt) || 0) }] : [];
  return { items: mine, mates };
}

// One use as EntWatch counts it: false if it's used up / cooling down (the press is blocked), else the use is spent.
// Also how a co-op round tracks a teammate's item for the item HUD (app/coop.js).
export function spendUse(it, now) {
  const s = itemState(it, now);
  if (s === 'E' || /^\d+$/.test(s)) return false;
  it.uses++;
  if (it.mode === 2 || it.mode === 4) it.readyAt = now + it.cooldown;
  return true;
}

// press each held item's button (the E key; a server's +use) as its holder, as EntWatch allows it
export function useItems(engine, items) {
  for (const it of items || []) {
    if (!it.button) continue;
    if (spendUse(it, engine.time)) engine.fire(pressTarget(engine, it), it.useInput || 'Press', '', 0, it.holder || engine.playerEnt, null);
  }
}
// the holder's own copy of the button (a teammate's and yours share its name)
function pressTarget(engine, it) {
  const w = it.weaponEnt;
  if (w?.alive) for (const c of w.children) if (c.alive && engine.find(it.button).includes(c)) return c;
  return it.button;
}

// Teammates' items in this copy of the map: [{ id, item, autoAt? }] -> [{ id, mate, items }]. Each gets a teammate
// (engine.addMate) holding it; autoAt: it goes off by itself that many seconds after the stage starts (armMates).
export function giveMates(engine, mates) {
  return (mates || []).filter((m) => m?.item).map((m) => {
    const mate = engine.addMate(m.id);
    return { id: m.id, mate, autoAt: Number.isFinite(m.autoAt) ? m.autoAt : null, items: giveItems(engine, [m.item], mate) };
  });
}
// the stage just started: the teammates' items that go off by themselves are pressed on time
export function armMates(engine, mates) {
  for (const m of mates || []) if (m.autoAt != null) engine.after(m.autoAt, () => useItems(engine, m.items));
}
// teammate `id` pressed their item (a round's broadcast, at the tick the server picked)
export function mateUse(engine, mates, id) {
  const m = (mates || []).find((x) => x.id === id);
  if (m) useItems(engine, m.items);
}
