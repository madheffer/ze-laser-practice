// node rubikon/tests/probe-wasm.mjs <physics.bin> <model key> <x> <y> <z> [steps]: src/Game/Probe.cs in the WebAssembly
// build (rubikon/wasm, after `dotnet publish -c Release`), to compare with rubikon/tests/Probe (native) bit for bit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const framework = path.join(here, '..', 'wasm', 'bin', 'Release', 'net10.0', 'publish', 'wwwroot', '_framework');
const { dotnet } = await import(pathToFileURL(path.join(framework, 'dotnet.js')).href);
const runtime = await dotnet.create();
const exports = await runtime.getAssemblyExports('Rubikon.Wasm.dll');
const args = process.argv.slice(2);
const I = exports.Source2.Compiler.Wasm.Interop;
let out;
if (args[0] === '--thruster') {
  // --thruster <physics.bin> <model> x y z flags force ox oy oz pitch yaw roll ticks (as rubikon/tests/Probe)
  const n = args.slice(3).map(Number);
  out = I.ProbeThruster(new Uint8Array(fs.readFileSync(args[1])), args[2], n.slice(0, 3), n[3], n[4], n.slice(5, 8), n.slice(8, 11), n[11], n[12] || 0, n.length > 14 ? n[13] : -1, n[14] || 0);
} else if (args[0] === '--keyframe') {
  const n = (a) => a.map(Number);
  out = I.ProbeKeyframe(new Uint8Array(fs.readFileSync(args[1])), args[2], n(args.slice(3, 6)), n(args.slice(6, 9)), args[9], n(args.slice(10, 13)), +args[13]);
} else if (args[0] === '--settype') {
  const n = args.slice(3).map(Number);
  out = I.ProbeSetType(new Uint8Array(fs.readFileSync(args[1])), args[2], n.slice(0, 3), n[3], n[4], n[5]);
} else {
  const [bin, key, x, y, z, steps] = args;
  out = I.Probe(new Uint8Array(fs.readFileSync(bin)), key, +x, +y, +z, +(steps || 192));
}
process.stdout.write(out);
process.exit(0);
