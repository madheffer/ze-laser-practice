// The map's items, the engine half (pure: world/run-engine.js uses it in the browser and on the co-op server alike).
//
// What items a map has comes from GFL's EntWatch config (tools/entwatch.mjs -> maps/<map>/entwatch.json): name, short
// name, colour, the weapon and its button by hammer id, the cooldown mode / seconds / uses a GFL server enforces.
// mapItems() finds those entities in the map; a human item counts as a HEAL when EntWatch names it so (Heal, Aura,
// Materia...) or its effect is a heal in the map's own data (a negative-damage trigger_hurt humans pass, two template
// hops from the item: mist's Cleansing Aura). Zombie items (EntWatch "Zombie ..." / "ZM ...", knives) never count.
//
// Holding an item is what a server does for the human who picked it up, nothing more (the map's entities do the rest):
//   give: spawn the item's template, parent its weapon to the holder, fire the weapon's OnPlayerPickup (mist:
//         AddContext item_heal:1)
//   use:  press its button as the holder (CS2 +use, the E key), refused while EntWatch's cooldown / uses say no
// ze_mist_p's Cleansing Aura: 2 HP/s for 10 s up to 180, cooldown 60; the map itself disables it during the escape and
// re-enables it when the throne lands.

const HEAL_NAME = /heal|cure|regen|medic|recover|restor|potion/i;
const ZOMBIE_NAME = /^(zombie|zm)\b|\bzm\b|zombie/i;
const key = (n) => String(n ?? '').replace(/^\[PR#\]/i, '').toLowerCase();
// a template entity's name as spawned: "&0000" becomes the spawn's own fixup, so look it up by prefix
const findName = (n) => (/&0000$/.test(n) ? n.replace(/&0000$/, '&*') : n);

// entities.json lumps + entwatch.json -> [{ id, name, shortname, color, weapon, button, spawn, mode, cooldown, maxuses, heal }]
export function mapItems(entities, entwatch) {
  const lumps = entities?.lumps || {};
  const all = Object.entries(lumps).flatMap(([lump, es]) => (Array.isArray(es) ? es : []).map((e) => ({ lump, kv: e.kv || {} })));
  const byHid = new Map(all.filter((e) => e.kv.hammeruniqueid != null).map((e) => [String(e.kv.hammeruniqueid), e]));
  const tplOfLump = new Map(all.filter((e) => e.kv.classname === 'point_template' && e.kv.entitylumpname).map((e) => [e.kv.entitylumpname, e]));
  const lumpOfTpl = new Map(all.filter((e) => e.kv.classname === 'point_template').map((e) => [key(e.kv.targetname), e.kv.entitylumpname]));
  const filters = new Map(all.filter((e) => /^filter_/.test(e.kv.classname)).map((e) => [key(e.kv.targetname), e.kv]));
  const humansPass = (fname) => {
    const f = filters.get(key(fname));
    if (!f) return true;
    if (f.classname === 'filter_activator_team') return (Number(f.filterteam) === 3) !== (f.negated === '1' || f.negated === 'true');
    return true;
  };
  // a negative-damage hurt humans pass, in the item's lump or a lump its makers / templates spawn (two hops)
  const healsInData = (lump) => {
    const seen = new Set();
    const walk = (l, depth) => {
      if (!l || seen.has(l) || depth > 2) return false;
      seen.add(l);
      for (const e of lumps[l] || []) {
        const k = e.kv || {};
        if (k.classname === 'trigger_hurt' && Number(k.damage) < 0 && humansPass(k.filtername)) return true;
        if (k.classname === 'env_entity_maker' && walk(lumpOfTpl.get(key(k.entitytemplate)), depth + 1)) return true;
      }
      return false;
    };
    return walk(lump, 0);
  };
  const out = [];
  for (const it of Array.isArray(entwatch?.items) ? entwatch.items : []) {
    const w = byHid.get(String(it.weapon));
    if (!w || !/^weapon_/.test(w.kv.classname || '')) continue;
    const button = (it.handlers || []).map((h) => byHid.get(String(h.hammerid))).find((e) => e?.kv.classname === 'func_button');
    const timing = (it.handlers || []).find((h) => h.mode > 0) || {};
    const zombie = ZOMBIE_NAME.test(it.name) || ZOMBIE_NAME.test(it.shortname || '') || w.kv.classname === 'weapon_knife';
    out.push({
      id: String(it.weapon), name: it.name, shortname: it.shortname || it.name, color: it.color || 'white',
      weapon: findName(w.kv.targetname || ''), button: button ? findName(button.kv.targetname || '') : null,
      spawn: tplOfLump.get(w.lump)?.kv.targetname || null,
      mode: timing.mode || 0, cooldown: timing.cooldown || 0, maxuses: timing.maxuses || 0,
      usable: !!button, // a heal with no button (gris: its heal runs in the map's cs_script) can't be held here
      zombie, heal: !zombie && (HEAL_NAME.test(it.name) || HEAL_NAME.test(key(w.kv.targetname)) || HEAL_NAME.test(key(tplOfLump.get(w.lump)?.kv.targetname)) || healsInData(w.lump)),
    });
  }
  return out;
}

// Hand `items` (mapItems() entries) to the player: spawn, parent to you, OnPlayerPickup. Returns the held state list.
export function giveItems(engine, items) {
  const held = (items || []).filter((it) => it && it.weapon && it.spawn).map((it) => ({ ...it, uses: 0, readyAt: 0 }));
  if (!held.length) return [];
  for (const it of held) engine.fire(it.spawn, 'ForceSpawn', '', 0, engine.playerEnt, null);
  // the spawn dispatches on the next tick: hand the weapon over just after it
  engine.after(0.05, () => {
    for (const it of held) {
      for (const w of engine.find(it.weapon)) {
        w.setParent(engine.playerEnt);
        w.pos.set(0, 0, 32); // in your hand, roughly; its children (the button, the aura maker) come along
        engine.moved(w);
        w.fireOutput('OnPlayerPickup', engine.playerEnt);
      }
    }
    engine.emit('log', `holding: ${held.map((it) => it.name).join(', ')} (E to use)`);
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

// One use as EntWatch counts it: false if it's used up / cooling down (the press is blocked), else the use is spent.
// Also how a co-op round tracks a teammate's item for the item HUD (app/coop.js).
export function spendUse(it, now) {
  const s = itemState(it, now);
  if (s === 'E' || /^\d+$/.test(s)) return false;
  it.uses++;
  if (it.mode === 2 || it.mode === 4) it.readyAt = now + it.cooldown;
  return true;
}

// press each held item's button (the E key; a server's +use), as EntWatch allows it
export function useItems(engine, items) {
  for (const it of items || []) {
    if (!it.button) continue;
    if (spendUse(it, engine.time)) engine.fire(it.button, 'Press', '', 0, engine.playerEnt, null);
  }
}
