#!/usr/bin/env node
// One command from a workshop map to a playable map folder: builds lasers-bake, runs every bake step in order
// and rebuilds the map index. BAKING.md lists what each step writes.
//
//   node tools/bake-map.mjs <workshop id | .vpk | baked map name> [more ...] [options]
//   node tools/bake-map.mjs --all                       re-bake every map in web/public/maps (from its manifest's source)
//   node tools/bake-map.mjs --scenarios                 bake every map that has stages (web/public/scenarios/*.json "workshop")
//
//   --steps map,entwatch,stripper,lighting,tiers,chunks,index   only these steps (default: all seven, in this order)
//   --skip-build                       use the lasers-bake already built
//   --cs2 <game/csgo>                  CS2's game folder (default: found from Steam's libraries, tools/steam.mjs)
//   --workshop <content/730>           where workshop ids are looked up (default: the workshop folder beside CS2)
//
// Steps:
//   map       the full bake: entities, collision, hulls, glbs + textures (cut-out alpha), particles, sounds, shots, radar
//   entwatch  GFL's EntWatch config -> entwatch.json (tools/entwatch.mjs): the map's items, the heal option, the item HUD
//   stripper  GFL's StripperCS2 configs -> stripper.json (tools/stripper.mjs): the entity edits GFL's servers make to the map
//   lighting  the map's CS2 lighting: lightmaps, probes, tonemap / LUT, skies, reflection cubemaps (high tier)
//   tiers     medium + low quality copies (q/medium, q/low: smaller WebP textures, WebP lightmaps any GPU can take)
//   chunks    the world split into streamed chunks, fewer draw calls (tools/chunk-world.mjs; needs tools' npm packages)
//   index     web/public/maps/index.json (the map picker)
//   water     (only when asked: the map step does it) the water shaders' textures -> water/ (lasers-bake --water), for a
//             map baked before water was ported
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMapName } from '../web/src/lib/paths.js';
import { cs2Dir, workshopDir } from './steam.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapsDir = path.join(repo, 'web', 'public', 'maps');
const STEPS = ['map', 'entwatch', 'stripper', 'lighting', 'tiers', 'chunks', 'index'];
// steps you can ask for that the default run doesn't need on its own (the map step already does them)
const EXTRA_STEPS = ['water'];

const opts = { steps: STEPS, build: true, cs2: null, workshop: null, all: false, scenarios: false };
const targets = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--steps') opts.steps = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--skip-build') opts.build = false;
  else if (a === '--cs2') opts.cs2 = argv[++i];
  else if (a === '--workshop') opts.workshop = argv[++i];
  else if (a === '--all') opts.all = true;
  else if (a === '--scenarios') opts.scenarios = true;
  else if (a === '-h' || a === '--help') usage(0);
  else if (a.startsWith('--')) { console.error(`unknown option ${a}`); usage(2); }
  else targets.push(a);
}
const bad = opts.steps.filter((s) => !STEPS.includes(s) && !EXTRA_STEPS.includes(s));
if (bad.length) { console.error(`unknown step(s): ${bad.join(', ')} (have ${[...STEPS, ...EXTRA_STEPS].join(', ')})`); process.exit(2); }
if (opts.all) for (const m of bakedMaps()) targets.push(m.name);
if (opts.scenarios) targets.push(...scenarioWorkshopIds());
opts.cs2 ??= cs2Dir();
opts.workshop ??= workshopDir();
if (!targets.length && !(opts.steps.length === 1 && opts.steps[0] === 'index')) usage(2);

function usage(code) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(code);
}

// the workshop ids of the maps that have stages: each scenario file's "workshop"
function scenarioWorkshopIds() {
  const dir = path.join(repo, 'web', 'public', 'scenarios');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const id = String(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).workshop || '');
    return /^\d+$/.test(id) ? id : null;
  }).filter(Boolean);
}

// the baked maps: { name, source } from each folder's manifest.json
function bakedMaps() {
  if (!fs.existsSync(mapsDir)) return [];
  return fs.readdirSync(mapsDir).filter(isMapName).map((name) => {
    const mf = path.join(mapsDir, name, 'manifest.json');
    if (!fs.existsSync(mf)) return null;
    try { return { name, source: JSON.parse(fs.readFileSync(mf, 'utf8')).source || '' }; } catch { return null; }
  }).filter(Boolean);
}

// a target -> its VPK: a path, a workshop item id (its _dir.vpk, else its one .vpk), or a baked map's manifest source
function resolveVpk(t) {
  if (/\.vpk$/i.test(t)) return fs.existsSync(t) ? path.resolve(t) : fail(`no such VPK: ${t}`);
  if (/^\d{6,12}$/.test(t)) {
    const dir = path.join(opts.workshop, t);
    if (!fs.existsSync(dir)) fail(`workshop item ${t} isn't downloaded (${dir})`);
    const vpks = fs.readdirSync(dir).filter((f) => /\.vpk$/i.test(f));
    const pick = vpks.find((f) => /_dir\.vpk$/i.test(f)) || (vpks.length === 1 ? vpks[0] : null);
    return pick ? path.join(dir, pick) : fail(`workshop item ${t}: no single map VPK in ${dir}`);
  }
  if (isMapName(t)) {
    const m = bakedMaps().find((x) => x.name === t);
    if (!m?.source) fail(`${t}: not baked yet (or its manifest has no source); pass its workshop id or VPK`);
    return fs.existsSync(m.source) ? m.source : fail(`${t}: its source ${m.source} is gone`);
  }
  return fail(`not a VPK, workshop id or map name: ${JSON.stringify(t)}`);
}

function fail(msg) { console.error(msg); process.exit(1); }

function run(cmd, args) {
  console.log(`\n> ${[cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repo });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${path.basename(cmd)} exited ${r.status}`);
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

function exePath() {
  const rel = path.join(repo, 'bake', 'bin', 'Release');
  const fw = fs.existsSync(rel) ? fs.readdirSync(rel).filter((d) => /^net\d/.test(d)).sort().reverse() : [];
  for (const d of fw) {
    for (const f of ['lasers-bake.exe', 'lasers-bake']) {
      const p = path.join(rel, d, f);
      if (fs.existsSync(p)) return p;
    }
  }
  return fail('lasers-bake isn\'t built (drop --skip-build)');
}

const needsBake = opts.steps.some((s) => s === 'map' || s === 'lighting' || s === 'tiers' || s === 'water');
if (needsBake && opts.build) run('dotnet', ['build', path.join(repo, 'bake'), '-c', 'Release', '--nologo', '-v', 'q']);
const exe = needsBake ? exePath() : null;
const cs2 = opts.cs2 ? ['--cs2', path.resolve(opts.cs2)] : [];

for (const t of targets) {
  const vpk = resolveVpk(t);
  console.log(`\n=== ${t}  (${vpk})`);
  if (opts.steps.includes('map')) run(exe, [vpk, mapsDir, ...cs2]);
  // the folder this VPK baked to: the manifest whose source is this VPK (the map name comes from inside the VPK)
  const norm = (p) => path.resolve(p).toLowerCase();
  const baked = bakedMaps().find((m) => m.source && norm(m.source) === norm(vpk));
  const later = opts.steps.filter((s) => s === 'entwatch' || s === 'stripper' || s === 'lighting' || s === 'tiers' || s === 'chunks' || s === 'water');
  if (!later.length) continue;
  if (!baked) fail(`${t}: no map folder in ${mapsDir} came from ${vpk}; run the map step first`);
  const dir = path.join(mapsDir, baked.name);
  // a map GFL has no EntWatch config for just has no items (entwatch.mjs says so and goes on)
  if (opts.steps.includes('entwatch')) run(process.execPath, [path.join(repo, 'tools', 'entwatch.mjs'), baked.name]);
  // likewise a map GFL doesn't strip: no stripper.json, the map's entities as they are
  if (opts.steps.includes('stripper')) run(process.execPath, [path.join(repo, 'tools', 'stripper.mjs'), baked.name]);
  if (opts.steps.includes('lighting')) run(exe, ['--lighting', vpk, dir]);
  if (opts.steps.includes('water') && !opts.steps.includes('map')) run(exe, ['--water', vpk, dir, ...cs2]);
  if (opts.steps.includes('tiers')) run(exe, ['--tiers', vpk, dir]);
  if (opts.steps.includes('chunks')) {
    // tools' own packages (glTF-Transform, meshoptimizer), once; a fixed command, so the shell is safe here
    if (!fs.existsSync(path.join(repo, 'tools', 'node_modules', '@gltf-transform', 'core'))) {
      console.log('\n> npm install (tools)');
      const r = spawnSync('npm install --no-audit --no-fund', { stdio: 'inherit', cwd: path.join(repo, 'tools'), shell: true });
      if (r.status !== 0) fail('npm install (tools) failed');
    }
    run(process.execPath, [path.join(repo, 'tools', 'chunk-world.mjs'), dir]);
  }
}

if (opts.steps.includes('index')) run(process.execPath, [path.join(repo, 'tools', 'index-maps.mjs')]);
console.log('\ndone');
