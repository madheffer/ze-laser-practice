// Server cvars a map sets. point_servercommand "Command" with "<cvar> <value>" emits a 'cvar' event; mapCvars()
// reads the ones a map sets at start (logic_auto OnMapSpawn / OnMultiNewMap / OnNewGame -> Command), which our stages
// never fire because they start mid-map. "say <text>" emits 'say' (the chat: app/chat.js prints it as CS2Fixes does);
// other commands (mp_restartgame, ...) do nothing here.
//
// What uses them: sv_falldamage_scale (app/session.js: GFL runs no fall damage, a map turns it on for an area this
// way; ze_deadcore sets 0 at start). The rest are kept on the run for later (movement cvars: ROADMAP).
import { register } from '../registry.js';

const CVAR = /^\s*((?:sv|mp)_[a-z0-9_]+)\s+(\S+)\s*$/i;
// "say ***Laser***" -> "***Laser***" (Source's say drops one pair of quotes around the whole text)
const SAY = /^\s*say\s+(.*?)\s*$/is;
export const parseSay = (cmd) => {
  const m = SAY.exec(String(cmd ?? ''));
  if (!m) return null;
  const t = m[1];
  return t.length > 1 && t[0] === '"' && t.endsWith('"') ? t.slice(1, -1) : t;
};

export const parseCvar = (cmd) => {
  const m = CVAR.exec(String(cmd ?? ''));
  return m ? { name: m[1].toLowerCase(), value: m[2] } : null;
};

register('point_servercommand', {
  input(e, inp, p) {
    if (inp !== 'command') return false;
    const c = parseCvar(p);
    if (c) e.engine.emit('cvar', c.name, c.value);
    const say = c ? null : parseSay(p);
    if (say) e.engine.emit('say', say);
    return true;
  },
});

// cvars the map sets as it loads: { name: value }, in output order (later wins)
export function mapCvars(engine) {
  const out = Object.create(null);
  const all = Object.values(engine.lumps).flat();
  const commanders = new Set(all.filter((d) => d.kv.classname === 'point_servercommand').map((d) => String(d.kv.targetname || '').replace(/^\[PR#\]/i, '').toLowerCase()));
  for (const d of all) {
    if (d.kv.classname !== 'logic_auto') continue;
    for (const c of d.io || []) {
      if (!/^on(mapspawn|multinewmap|newgame)$/i.test(c.output) || !/^command$/i.test(c.input)) continue;
      const t = String(c.target || '').replace(/^\[PR#\]/i, '').toLowerCase();
      if (!commanders.has(t) && t !== 'point_servercommand') continue;
      const v = parseCvar(c.param);
      if (v) out[v.name] = v.value;
    }
  }
  return out;
}
