#!/usr/bin/env node
// Print a baked map's entities whose name/class matches a regex, with their outputs and who fires into them.
// The tool for writing scenarios: find the relay that starts a laser wave, and what ends it.
//
//   node tools/io-graph.mjs web/public/maps/ze_mist_p laser
//   node tools/io-graph.mjs web/public/maps/ze_mist_p "^\[PR#\]boss" --kv origin,angles
import fs from 'node:fs';
import path from 'node:path';
import { stripPrefix, nameMatches } from '../web/src/lib/names.js';

const [dir, pattern, ...rest] = process.argv.slice(2);
if (!dir || !pattern) {
  console.error('usage: io-graph.mjs <baked map dir> <regex> [--kv key1,key2]');
  process.exit(2);
}
const kvKeys = (rest[rest.indexOf('--kv') + 1] || '').split(',').filter(Boolean);
const re = new RegExp(pattern, 'i');
const { lumps } = JSON.parse(fs.readFileSync(path.join(dir, 'entities.json'), 'utf8'));

const all = [];
for (const [lump, ents] of Object.entries(lumps)) for (const e of ents) all.push({ lump, ...e });

const nameOf = (e) => e.kv.targetname || '';
const strip = stripPrefix;
const matchName = nameMatches;

const incoming = new Map();
for (const e of all) for (const c of e.io) {
  for (const t of all) if (nameOf(t) && matchName(c.target, nameOf(t))) {
    const k = nameOf(t);
    if (!incoming.has(k)) incoming.set(k, []);
    incoming.get(k).push(`${strip(nameOf(e)) || e.kv.classname}.${c.output} -> ${c.input}${c.param ? `(${c.param})` : ''}${c.delay ? ` @${c.delay}s` : ''}`);
  }
}

const hits = all.filter((e) => re.test(nameOf(e)) || re.test(e.kv.classname));
const seen = new Set();
for (const e of hits) {
  const n = nameOf(e);
  const key = n + e.kv.classname + e.kv.origin;
  if (seen.has(key)) continue;
  seen.add(key);
  const extra = kvKeys.map((k) => `${k}=${e.kv[k]}`).join(' ');
  console.log(`\n${e.kv.classname} ${strip(n) || '(unnamed)'}  [${e.lump}] ${extra}`);
  for (const i of [...new Set(incoming.get(n) || [])].slice(0, 12)) console.log(`   <- ${i}`);
  for (const c of e.io) console.log(`   ${c.output} -> ${strip(c.target)}.${c.input}${c.param ? `(${c.param})` : ''}${c.delay ? ` @${c.delay}s` : ''}${c.times > 0 ? ` x${c.times}` : ''}`);
}
console.error(`\n${seen.size} entities`);
