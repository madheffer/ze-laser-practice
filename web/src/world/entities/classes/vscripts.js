// Source 1 VScript (Squirrel): a CS:GO map's entity with a `vscripts` key runs the .nut files it names, and the map
// calls into them with RunScriptCode "Fn(args);". The game never runs a map's code (no eval), so a script runs here
// only as a hand port of that one file, picked by its path (the map's own `vscripts` value, lower case, no
// "scripts/vscripts/" and no ".nut"). A port is the file's functions, its numbers copied from it; a call the port
// doesn't have, or a script with no port, is logged once as unhandled, like any other input.
//
//   port = { init(state, e) {...}, fns: { Fn(e, args, act) {...} } }
//
// What a port may do is what the .nut does: EntFire / EntFireByHandle (engine.fire, the script entity as caller) and
// its own variables (e.state.vs).
import { own } from '../../../lib/storage.js';
import queen from './vscript-ports/dark-fantasy-queen.js';

const PORTS = {
  'ze_surf_dark_fantasy/bosshp_queen': queen,
};

// "ze_surf_dark_fantasy/bosshp_queen.nut" -> the PORTS key (the key may list several files: the first with a port)
function portOf(e) {
  if (e.vport !== undefined) return e.vport;
  e.vport = null;
  for (const f of String(e.kv.vscripts || '').split(/\s+/)) {
    const key = f.toLowerCase().replace(/\\/g, '/').replace(/^scripts\/vscripts\//, '').replace(/\.nut$/, '');
    const p = own(PORTS, key);
    if (p) { e.vport = p; e.state.vs = {}; p.init?.(e.state.vs, e); break; }
  }
  return e.vport;
}

// "Fn(1); Other();" -> [['Fn', [1]], ['Other', []]]; anything that isn't a plain call of numbers / strings is null
function parseCalls(code) {
  const out = [];
  for (const st of String(code ?? '').split(';')) {
    const s = st.trim();
    if (!s) continue;
    const m = /^([A-Za-z_]\w*)\s*\(([^()]*)\)$/.exec(s);
    if (!m) return null;
    const args = m[2].trim() === '' ? [] : m[2].split(',').map((a) => {
      const t = a.trim();
      return /^".*"$/.test(t) ? t.slice(1, -1) : Number(t);
    });
    out.push([m[1], args]);
  }
  return out;
}

// RunScriptCode on a Source 1 entity: true when its port ran every call
export function runScriptCode(engine, e, code, activator) {
  const port = portOf(e);
  if (!port) return false;
  const calls = parseCalls(code);
  if (!calls) { engine.warnOnce(`vscript:${code}`, `unhandled RunScriptCode "${String(code).slice(0, 60)}" on ${e.name}`); return true; }
  for (const [fn, args] of calls) {
    const f = own(port.fns, fn);
    if (f) f(e, args, activator);
    else engine.warnOnce(`vscript:${fn}`, `unhandled ${fn}() in ${e.kv.vscripts}`);
  }
  return true;
}
