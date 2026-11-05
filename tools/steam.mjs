// Where Steam keeps CS2 and its workshop maps on this PC, found the way Steam itself lists them: every library in
// <Steam>/steamapps/libraryfolders.vdf. bake/Program.cs FindCs2 does the same for lasers-bake.
//
//   cs2Dir()        -> <library>/steamapps/common/Counter-Strike Global Offensive/game/csgo, or null
//   workshopDir()   -> <library>/steamapps/workshop/content/730 (CS2's workshop maps), or null
//
// Overrides: LASERS_CS2 (the game/csgo folder), LASERS_WORKSHOP (the content/730 folder), STEAM_DIR (Steam's own folder).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CS2_REL = path.join('steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo');
const WS_REL = path.join('steamapps', 'workshop', 'content', '730');

function steamRoots() {
  const out = [];
  if (process.env.STEAM_DIR) out.push(process.env.STEAM_DIR);
  if (process.platform === 'win32') {
    // HKCU\Software\Valve\Steam SteamPath: where the Steam client is installed
    try {
      const r = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(r);
      if (m) out.push(m[1].trim());
    } catch { /* no Steam in the registry */ }
    out.push('C:\\Program Files (x86)\\Steam');
  } else {
    const h = os.homedir();
    out.push(path.join(h, '.steam', 'steam'), path.join(h, '.local', 'share', 'Steam'), path.join(h, 'Library', 'Application Support', 'Steam'));
  }
  return [...new Set(out.map((p) => path.resolve(p)))].filter((p) => fs.existsSync(p));
}

// every Steam library folder: the roots and the "path" entries of their libraryfolders.vdf
export function steamLibraries() {
  const libs = [];
  for (const root of steamRoots()) {
    libs.push(root);
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    for (const m of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  }
  return uniquePaths(libs);
}

// one entry per folder (Windows paths compare without case: the registry says d:\steam, the vdf D:\Steam)
function uniquePaths(list) {
  const seen = new Map();
  for (const p of list.map((x) => path.resolve(x))) {
    const k = process.platform === 'win32' ? p.toLowerCase() : p;
    if (!seen.has(k) && fs.existsSync(p)) seen.set(k, p);
  }
  return [...seen.values()];
}

export function cs2Dir() {
  const env = process.env.LASERS_CS2;
  if (env) return fs.existsSync(path.join(env, 'pak01_dir.vpk')) ? path.resolve(env) : null;
  for (const lib of steamLibraries()) {
    const p = path.join(lib, CS2_REL);
    if (fs.existsSync(path.join(p, 'pak01_dir.vpk'))) return p;
  }
  return null;
}

// CS2's workshop downloads live in the library CS2 is installed in
export function workshopDir() {
  if (process.env.LASERS_WORKSHOP) return path.resolve(process.env.LASERS_WORKSHOP);
  const cs2 = cs2Dir();
  if (cs2) {
    const lib = path.resolve(cs2, '..', '..', '..', '..', '..', '..');
    const ws = path.join(lib, WS_REL);
    if (fs.existsSync(ws)) return ws;
  }
  for (const lib of steamLibraries()) { const ws = path.join(lib, WS_REL); if (fs.existsSync(ws)) return ws; }
  return null;
}

// `node tools/steam.mjs`: print what it finds
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ libraries: steamLibraries(), cs2: cs2Dir(), workshop: workshopDir() }, null, 2));
}
