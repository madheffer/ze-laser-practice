// GFL's map lump edits (StripperCS2, github.com/Source2ZE/StripperCS2; configs from github.com/gflze/CS2-ZE-Configs
// stripper/<map>/<lump>.jsonc), applied to a baked map's entities exactly as the plugin does on GFL's servers, so a
// stage plays as it does there. tools/stripper.mjs fetches a map's files into maps/<map>/stripper.json; the client
// (world/assets.js), the co-op server (server/map-store.js) and the tools all load entities through applyStripper,
// so every copy of a map holds the same entities (the anti-cheat's copy must match the player's).
//
// Semantics (StripperCS2 src/actions/actions.cpp, src/providers/json*):
//   - a file applies to one lump: stripper/<map>/<lump>.jsonc is <lump> of the map's main world; a subfolder names
//     another world (skyboxes), which our bake doesn't have, so those are skipped. Names compare lower-case.
//   - top-level "filter" / "add" / "modify", each an array or a single object; duplicate keys are merged in order.
//     All filters run first, then all adds, then all modifies.
//   - a value "/re/" is a case-insensitive, unanchored regex; anything else compares exactly.
//   - match: every keyvalue must exist and match; every "io" entry must match at least one output (a field it leaves
//     out matches anything; delay / timestofire compare exactly).
//   - modify: replace (keyvalues; an "io" object rewrites only the outputs the match's io matched, which move to the
//     end), then delete (a keyvalue whose value matches; outputs matching an io entry), then insert (as add).
//   - inserted outputs default to delay 0, timestofire -1.
// The file is data: keys and values become strings, regexes are length-capped, nothing is ever evaluated.
//
// Named edits: GFL comments each fix at the top level ("// Kill epick blockers when round starts"). A comment starts an
// edit and the actions after it, up to the next comment, belong to it; stripper.json keeps them per file as
// edits: [{ id, note, actions }] so a player can turn one off (settings `stripperOff`, solo only: a co-op round plays
// every edit, as GFL's server does). The same note in several files is one edit (sakura's translations). An edit
// turned off drops its actions; the rest still run all filters, then adds, then modifies, as the plugin orders them.

const MAX_RE = 256;
const IO_KEYS = { outputname: 'output', targetname: 'target', inputname: 'input', overrideparam: 'param' };

// ---- JSONC with duplicate top-level keys (the tool's parser; plain JSON.parse would keep only the last "modify")

// A top-level comment (depth 1, between the config's keys) becomes a NOTE pair (,"\u0000note":"its text",) that the
// parser below reads as the start of a named edit; its own key loop skips the stray commas. Deeper comments just go.
const NOTE = '\u0000note';
function stripComments(text) {
  let out = '', i = 0, inStr = false, depth = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === '/' && (n === '/' || n === '*')) {
      const start = i + 2;
      if (n === '/') { while (i < text.length && text[i] !== '\n') i++; } else { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; }
      const body = text.slice(start, i).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (n === '*') i += 2;
      if (depth === 1 && body) out += `,${JSON.stringify(NOTE)}:${JSON.stringify(body)},`;
    } else {
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      out += c; i++;
    }
  }
  return out.replace(/,(\s*[\]}])/g, '$1');
}

// a note -> its edit's id: its first four words, lower-case, joined by '-' (sakura's two "Translate map to English
// using DeepL..." notes are one edit), 40 characters at most (isEditId)
export const editId = (note) => String(note || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4).join('-').slice(0, 40).replace(/-+$/, '') || 'gfl';
export const isEditId = (v) => typeof v === 'string' && v.length <= 40 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);

// the end (exclusive) of the JSON value starting at s[i]
function valueEnd(s, i) {
  let depth = 0, inStr = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; if (depth === 0) { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } return i + 1; } continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
    else if (depth === 0 && (c === ',' || c === '}')) return i;
  }
  return i;
}

// ---- our own configs (stripper/<map>/ in this repo, GFL's format plus two extension keys, tools/stripper.mjs):
//   "x-lasers": { name, summary, detail, count: { default, min, max, label } }  after an edit's comment: the
//                settings' words for it, and a number the player picks (1-16)
//   "repeat": "count"  on an io entry an edit inserts: that output goes in `count` times (the player's number)
// StripperCS2 would ignore the key and insert the output once.
const META_KEY = 'x-lasers';
const COUNT_CAP = [1, 16];
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const int = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
function cleanEditMeta(v) {
  if (!v || typeof v !== 'object') return undefined;
  const out = { name: str(v.name, 60), summary: str(v.summary, 120), detail: str(v.detail, 1200) };
  const c = v.count;
  if (c && typeof c === 'object') {
    const min = int(c.min, ...COUNT_CAP, COUNT_CAP[0]), max = int(c.max, min, COUNT_CAP[1], COUNT_CAP[1]);
    out.count = { min, max, default: int(c.default, min, max, min), label: str(c.label, 40) || 'Count' };
  }
  return out;
}

// -> { filter: [...], add: [...], modify: [...], edits: [{ id, note, actions: { filter, add, modify } }] }: every
// top-level occurrence kept, in order; edits: the same actions split by the comment above them (Named edits, top)
export function parseStripperJsonc(text) {
  const s = stripComments(String(text)).trim();
  if (s[0] !== '{') throw new Error('stripper config is not an object');
  const out = { filter: [], add: [], modify: [], edits: [] };
  let edit = null;
  const startEdit = (note) => {
    const id = editId(note);
    edit = out.edits.find((e) => e.id === id);
    if (!edit) out.edits.push((edit = { id, note, actions: { filter: [], add: [], modify: [] } }));
  };
  let i = 1;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (s[i] === '}' || i >= s.length) break;
    const kEnd = valueEnd(s, i);
    const key = JSON.parse(s.slice(i, kEnd));
    i = kEnd;
    while (s[i] !== ':') i++;
    i++;
    while (/\s/.test(s[i])) i++;
    const vEnd = valueEnd(s, i);
    const value = JSON.parse(s.slice(i, vEnd));
    i = vEnd;
    if (key === NOTE) { startEdit(String(value)); continue; }
    if (key === META_KEY) { if (!edit) startEdit(''); edit.meta = cleanEditMeta(value); continue; }
    if (key !== 'filter' && key !== 'add' && key !== 'modify') continue;
    if (!edit) startEdit('');
    for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === 'object') { out[key].push(v); edit.actions[key].push(v); }
  }
  out.edits = out.edits.filter((e) => e.actions.filter.length + e.actions.add.length + e.actions.modify.length);
  return out;
}

// ---- matching / editing

function matcher(v) {
  const s = String(v);
  if (s.length >= 3 && s[0] === '/' && s[s.length - 1] === '/') {
    try { return { re: new RegExp(s.slice(1, -1).slice(0, MAX_RE), 'i') }; } catch { return { never: true }; }
  }
  return { str: s };
}
const matches = (m, value) => (m.never ? false : m.re ? m.re.test(String(value)) : String(value) === m.str);

// a config io object -> { field: matcher } for matching, plus the raw values for building
function ioSpec(o) {
  const spec = { m: {}, raw: {} };
  for (const [k, v] of Object.entries(o || {})) {
    const f = IO_KEYS[k.toLowerCase()];
    if (f) { spec.m[f] = matcher(v); spec.raw[f] = String(v); }
    else if (k.toLowerCase() === 'delay' && Number.isFinite(Number(v))) spec.raw.delay = Number(v);
    else if (k.toLowerCase() === 'timestofire' && Number.isFinite(Number(v))) spec.raw.times = Math.trunc(Number(v));
  }
  return spec;
}
function ioMatches(c, spec) {
  for (const [f, m] of Object.entries(spec.m)) if (!matches(m, c[f] ?? '')) return false;
  if (spec.raw.delay !== undefined && Number(c.delay || 0) !== spec.raw.delay) return false;
  if (spec.raw.times !== undefined && Number(c.times ?? -1) !== spec.raw.times) return false;
  return true;
}
// an action object -> { kv: [[key, matcher, raw]], io: [spec] }
function entries(obj, ioIsArray = true) {
  const kv = [], io = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === 'io') for (const o of ioIsArray ? (Array.isArray(v) ? v : [v]) : [v]) io.push(ioSpec(o));
    else kv.push([k.toLowerCase(), matcher(v), String(v)]);
  }
  return { kv, io };
}
// does an entity match; collects the indices of the outputs the io entries matched
function entityMatches(ent, m, matched) {
  for (const spec of m.io) {
    const list = ent.io || [];
    if (!list.length) return false;
    let found = false;
    list.forEach((c, i) => { if (ioMatches(c, spec)) { found = true; matched?.add(i); } });
    if (!found) return false;
  }
  for (const [k, mt] of m.kv) {
    if (!Object.prototype.hasOwnProperty.call(ent.kv || {}, k)) return false;
    if (!matches(mt, ent.kv[k])) return false;
  }
  return true;
}
const newOutput = (raw) => ({ output: raw.output ?? '', target: raw.target ?? '', input: raw.input ?? '', param: raw.param ?? '', delay: raw.delay ?? 0, times: raw.times ?? -1 });
function insert(ent, ins) {
  for (const [k, , raw] of ins.kv) ent.kv[k] = raw;
  for (const spec of ins.io) (ent.io ||= []).push(newOutput(spec.raw));
}

function applyToLump(list, actions) {
  for (const f of actions.filter || []) {
    const m = entries(f);
    for (let j = list.length - 1; j >= 0; j--) if (entityMatches(list[j], m)) list.splice(j, 1);
  }
  for (const a of actions.add || []) {
    const ent = { kv: {}, io: [] };
    insert(ent, entries(a));
    list.push(ent);
  }
  for (const mod of actions.modify || []) {
    const m = entries(mod.match);
    const rep = entries(mod.replace, false), del = entries(mod.delete), ins = entries(mod.insert);
    for (const ent of list) {
      const hit = new Set();
      if (!entityMatches(ent, m, hit)) continue;
      ent.kv ||= {}; ent.io ||= [];
      for (const [k, , raw] of rep.kv) ent.kv[k] = raw;
      for (const spec of rep.io) {
        const keep = [], moved = [];
        ent.io.forEach((c, i) => {
          if (!hit.has(i)) { keep.push(c); return; }
          moved.push({ ...c, ...Object.fromEntries(Object.entries(spec.raw)) });
        });
        ent.io = keep.concat(moved);
      }
      for (const [k, mt] of del.kv) if (Object.prototype.hasOwnProperty.call(ent.kv, k) && matches(mt, ent.kv[k])) delete ent.kv[k];
      for (const spec of del.io) ent.io = ent.io.filter((c) => !ioMatches(c, spec));
      insert(ent, ins);
    }
  }
}

// a file's edits: its named ones, or the whole file as one ('gfl') in a stripper.json from before edits were named
function fileEdits(f) {
  if (Array.isArray(f?.edits)) return f.edits.filter((e) => e && isEditId(e.id) && e.actions && typeof e.actions === 'object' && !Array.isArray(e.actions));
  return f?.actions ? [{ id: 'gfl', note: '', actions: f.actions }] : [];
}

// The map's named edits, once each, in file order: [{ id, note, source, meta? }] (note: the config's comment; source:
// 'gfl' or 'ours', from tools/stripper.mjs; meta: an own config's words and count, cleanEditMeta)
export function stripperEdits(stripper, map) {
  const seen = new Map();
  for (const f of Array.isArray(stripper?.files) ? stripper.files : []) {
    if (map && String(f?.world || '').toLowerCase() !== String(map).toLowerCase()) continue;
    for (const e of fileEdits(f)) {
      if (seen.has(e.id)) continue;
      const meta = cleanEditMeta(e.meta);
      seen.set(e.id, { id: e.id, note: String(e.note || '').slice(0, 200), source: f.source === 'ours' ? 'ours' : 'gfl', ...(meta ? { meta } : {}) });
    }
  }
  return [...seen.values()];
}

// Edit ids turned off, as one clean sorted list (settings, a replay's rules, the server's cache key): 32 at most
export function cleanEditsOff(v) {
  return Array.isArray(v) ? [...new Set(v.filter(isEditId))].sort().slice(0, 32) : [];
}

// Counts picked for edits that take one ({ id: n }), clean: ids checked, whole numbers in the hard cap, 32 at most.
// Each edit's own range clamps it again when applied
export function cleanCounts(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const id of Object.keys(v).filter(isEditId).sort().slice(0, 32)) out[id] = int(v[id], ...COUNT_CAP, COUNT_CAP[0]);
  return out;
}

// What a run plays: { off: [ids], counts: { id: n } } from either form (a plain array is the off list)
export function cleanChoice(v) {
  if (Array.isArray(v)) return { off: cleanEditsOff(v), counts: {} };
  return { off: cleanEditsOff(v?.off), counts: cleanCounts(v?.counts) };
}
// A choice against the map's own edits (stripperEdits): unknown ids dropped, counts clamped to their edit's range and
// left out at its default, so the same play has one form. -> { off, counts, key } (key: '' = every edit, defaults;
// the variant caches on the client and the server use it, and a replay records off / counts)
export function resolveChoice(edits, choice) {
  const c = cleanChoice(choice);
  const byId = new Map((edits || []).map((e) => [e.id, e]));
  const off = c.off.filter((id) => byId.has(id));
  const counts = {};
  for (const [id, n] of Object.entries(c.counts)) {
    const r = byId.get(id)?.meta?.count;
    if (!r || off.includes(id)) continue;
    const v = int(n, r.min, r.max, r.default);
    if (v !== r.default) counts[id] = v;
  }
  const key = [off.join(','), Object.entries(counts).map(([id, n]) => `${id}=${n}`).join(',')].join(';');
  return { off, counts, key: key === ';' ? '' : key };
}

// an edit's actions with its "repeat": "count" outputs put in n times (a copy; the edit's own data is never changed)
function withCount(actions, n) {
  const expand = (io) => (Array.isArray(io) ? io : [io]).flatMap((o) => {
    if (!o || typeof o !== 'object' || o.repeat !== 'count') return [o];
    const { repeat, ...rest } = o;
    return Array.from({ length: n }, () => ({ ...rest }));
  });
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === 'io' ? expand(x).map(walk) : walk(x);
    return out;
  };
  return walk(actions);
}

// Apply a map's stripper.json ({ files: [{ world, lump, edits: [{ id, note, actions: {filter, add, modify} }] }] },
// tools/stripper.mjs) to its entities.json ({ lumps: { name: [{kv, io}] } }), in place; returns the entities.
// choice: the edits to leave out and the counts picked (cleanChoice; a plain array = the off list); the others
// apply as GFL's server applies the whole file, an edit with a count at its default unless one was picked.
export function applyStripper(entities, stripper, map, choice = []) {
  const { off, counts } = cleanChoice(choice);
  const skip = new Set(off);
  const files = Array.isArray(stripper?.files) ? stripper.files : [];
  const lumps = entities?.lumps;
  if (!files.length || !lumps || typeof lumps !== 'object') return entities;
  const byName = new Map(Object.keys(lumps).map((k) => [k.toLowerCase(), k]));
  for (const f of files) {
    if (String(f?.world || '').toLowerCase() !== String(map || '').toLowerCase()) continue; // another world: not baked
    const key = byName.get(String(f?.lump || '').toLowerCase());
    if (!key || !Array.isArray(lumps[key])) continue;
    const actions = { filter: [], add: [], modify: [] };
    for (const e of fileEdits(f)) {
      if (skip.has(e.id)) continue;
      const c = cleanEditMeta(e.meta)?.count;
      const acts = c ? withCount(e.actions, int(counts[e.id], c.min, c.max, c.default)) : e.actions;
      for (const k of Object.keys(actions)) if (Array.isArray(acts[k])) actions[k].push(...acts[k]);
    }
    applyToLump(lumps[key], actions);
  }
  return entities;
}
