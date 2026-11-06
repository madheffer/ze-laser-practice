// node tools/build-rubikon.mjs: builds CS2's physics for the game (rubikon/wasm, `dotnet publish -c Release`: .NET 10
// SDK with the wasm-tools workload) and copies its runtime into web/public/rubikon/_framework, where the browser loads
// it (web/src/world/assets.js) and the co-op server reads it (web/server/map-store.js). Generated, gitignored.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'rubikon', 'wasm');
const from = path.join(project, 'bin', 'Release', 'net10.0', 'publish', 'wwwroot', '_framework');
const to = path.join(root, 'web', 'public', 'rubikon', '_framework');

if (!process.argv.includes('--copy-only')) {
  execFileSync('dotnet', ['publish', '-c', 'Release'], { cwd: project, stdio: 'inherit' });
}
if (!fs.existsSync(path.join(from, 'dotnet.js'))) {
  console.error(`no build at ${from}`);
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
let n = 0, bytes = 0;
for (const f of fs.readdirSync(from)) {
  // the plain files only: the static servers here don't negotiate the .br / .gz copies
  if (/\.(br|gz)$/.test(f)) continue;
  const src = path.join(from, f);
  if (!fs.statSync(src).isFile()) continue;
  fs.copyFileSync(src, path.join(to, f));
  n++; bytes += fs.statSync(src).size;
}
console.log(`${n} files, ${(bytes / 1048576).toFixed(1)} MB -> ${path.relative(root, to)}`);
