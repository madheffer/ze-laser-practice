// The map's baked CS2 lighting (lasers-bake --lighting -> <map>/lighting/): lighting.json + each lightmap's top mip
// as its GPU blocks (BC6H / BC7 / DXT1 / BC4), uploaded compressed, exactly as the game has them.
//
// loadLightmaps(base, renderer) -> { uvScale, version, gameVersion, textures: { irradiance, directional_irradiance,
// direct_light_shadows } } or null (no bake, or a GPU without the formats: the world keeps its fallback lighting).
//
// lighting.json is untrusted like every map file: only the three known names, known formats, sane sizes, and a
// byte count that matches the format's block size exactly.
import * as THREE from 'three';
import { fetchJson, fetchBuffer, FRESH } from '../lib/fetch.js';
import { versioned } from '../lib/paths.js';

const NAMES = ['irradiance', 'directional_irradiance', 'direct_light_shadows'];
const MAX_SIDE = 8192;
// format -> [three.js format, bytes per 4x4 block, the WebGL extension it needs]
const FORMATS = {
  bc6h: [THREE.RGB_BPTC_UNSIGNED_Format, 16, 'EXT_texture_compression_bptc'],
  bc7: [THREE.RGBA_BPTC_Format, 16, 'EXT_texture_compression_bptc'],
  dxt1: [THREE.RGB_S3TC_DXT1_Format, 8, 'WEBGL_compressed_texture_s3tc'],
  bc4: [THREE.RED_RGTC1_Format, 8, 'EXT_texture_compression_rgtc'],
};

function check(name, t) {
  if (!t || typeof t !== 'object') return null;
  const f = Object.hasOwn(FORMATS, t.format) ? FORMATS[t.format] : null;
  const w = t.width, h = t.height;
  if (!f || !Number.isInteger(w) || !Number.isInteger(h) || w < 4 || h < 4 || w > MAX_SIDE || h > MAX_SIDE || w % 4 || h % 4) return null;
  const bytes = (w / 4) * (h / 4) * f[1];
  if (t.bytes !== bytes || t.file !== `${name}.bin`) return null;
  return { file: t.file, format: f[0], ext: f[2], width: w, height: h, bytes };
}

// opts.reflections false: the reflection cubemaps aren't downloaded, unless the map has CS2 water (water/water.json):
// water always reflects them (world/lighting.js), a grazing water surface with none went black
export async function loadLightmaps(mapBase, renderer, log = () => {}, opts = {}) {
  // a quality tier lives in q/<tier>/lighting/ (PNG lightmaps any GPU can take), else the high bake's raw blocks
  const base = opts.tier === 'medium' || opts.tier === 'low' ? `${mapBase}q/${opts.tier}/` : mapBase;
  let json;
  try { json = await fetchJson(`${base}lighting/lighting.json`, FRESH); } catch { return null; } // not baked
  if (!json || typeof json !== 'object' || !json.textures) return null;
  const scale = Array.isArray(json.uvScale) && json.uvScale.length === 2 && json.uvScale.every((v) => typeof v === 'number' && v > 0 && v < 16) ? json.uvScale : [1, 1];
  const version = typeof json.version === 'string' && /^\d{1,20}$/.test(json.version) ? json.version : '';
  const specs = {};
  const images = {}; // PNG / WebP lightmaps (a quality tier)
  for (const name of NAMES) {
    const t = json.textures[name];
    if ((t?.format === 'rgbm' || t?.format === 'png') && (t.file === `${name}.png` || t.file === `${name}.webp`)) { images[name] = t; continue; } // PNG, or lossless WebP (newer bakes)
    const s = check(name, t);
    if (!s) continue;
    if (!renderer.extensions.has(s.ext)) { log(`lighting: this GPU can't take ${json.textures[name].format} (${s.ext}): fallback lighting`); return null; }
    specs[name] = s;
  }
  if (!specs.irradiance && !images.irradiance) return null;
  const textures = {};
  let irradianceRange = 0; // > 0: the irradiance is RGBM (rgb x a x range)
  await Promise.all(Object.entries(images).map(async ([name, t]) => {
    const tex = await pngTexture(versioned(`${base}lighting/${t.file}`, version));
    if (!tex) return;
    textures[name] = tex;
    if (name === 'irradiance' && t.format === 'rgbm') irradianceRange = typeof t.range === 'number' && t.range > 0 && t.range < 1e4 ? t.range : 16;
  }));
  if (!textures.irradiance && !specs.irradiance) return null;
  await Promise.all(Object.entries(specs).map(async ([name, s]) => {
    const buf = await fetchBuffer(versioned(`${base}lighting/${s.file}`, version));
    if (buf.byteLength !== s.bytes) throw new Error(`lighting: ${name} is ${buf.byteLength} bytes, expected ${s.bytes}`);
    const tex = new THREE.CompressedTexture([{ data: new Uint8Array(buf), width: s.width, height: s.height }], s.width, s.height, s.format);
    tex.colorSpace = THREE.NoColorSpace; // data, not colour: irradiance (linear HDR), directions, shadow masks
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter; // one mip, as baked
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    textures[name] = tex;
  }));
  // the .vpost index (lower-case path -> the hash its files are saved under): world/tonemap.js
  const post = Object.create(null);
  for (const [k, v] of Object.entries(json.post && typeof json.post === 'object' ? json.post : {})) {
    if (typeof k === 'string' && k.length < 300 && typeof v === 'string' && /^[0-9a-f]{8}$/.test(v)) post[k] = v;
  }
  // light probes (bake/ProbeBake.cs): per volume, a box-filtered grid of ambient cubes as RGBA16F
  const probes = [];
  const list = Array.isArray(json.probes) ? json.probes.slice(0, 256) : [];
  await Promise.all(list.map(async (p) => {
    const d = p?.dims;
    if (!Number.isInteger(p?.index) || p.index < 0 || !Array.isArray(d) || d.length !== 3 || !d.every((v) => Number.isInteger(v) && v >= 1 && v <= 512)) return;
    const bytes = d[0] * d[1] * d[2] * 6 * 4 * 2;
    if (p.file !== `${p.index}.bin` || p.bytes !== bytes) return;
    const buf = await fetchBuffer(versioned(`${base}lighting/probes/${p.file}`, version)).catch(() => null);
    if (!buf || buf.byteLength !== bytes) return;
    probes.push({ index: p.index, handshake: typeof p.handshake === 'string' ? p.handshake : '', dims: d, data: new Uint16Array(buf) });
  }));
  // skies (bake/SkyBake.cs): per sky material, its cube texture's GPU blocks (every mip) + the material's params
  const skies = Object.create(null);
  const skyEntries = Object.entries(json.skies && typeof json.skies === 'object' ? json.skies : {}).slice(0, 16);
  await Promise.all(skyEntries.map(async ([key, v]) => {
    if (typeof key !== 'string' || key.length > 300 || typeof v?.file !== 'string' || !/^sky\/[0-9a-f]{8}\.json$/.test(v.file)) return;
    const d = await fetchJson(versioned(`${base}lighting/${v.file}`, version)).catch(() => null);
    if (d?.format === 'rgbm-faces' && Array.isArray(d.faces) && d.faces.length === 6) {
      const hash = v.file.slice(4, 12);
      if (!d.faces.every((f, i) => f === `sky/${hash}_${i}.png` || f === `sky/${hash}_${i}.webp`)) return;
      const faces = await Promise.all(d.faces.map((f) => pngImage(versioned(`${base}lighting/${f}`, version))));
      if (faces.some((f) => !f)) return;
      const num = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, x]) => typeof x === 'number' && Number.isFinite(x)));
      skies[key] = { rgbmFaces: faces, range: typeof d.range === 'number' && d.range > 0 ? d.range : 16, ints: num(d.ints), floats: num(d.floats) };
      return;
    }
    const raw = d && rawTexture(d, `sky/${v.file.slice(4, 12)}.bin`, renderer);
    if (!raw || !d.cube) return;
    const buf = await fetchBuffer(versioned(`${base}lighting/${raw.file}`, version)).catch(() => null);
    if (!buf || buf.byteLength < raw.total) return;
    const num = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, x]) => typeof x === 'number' && Number.isFinite(x)));
    skies[key] = { ...raw, data: new Uint8Array(buf), ints: num(d.ints), floats: num(d.floats) };
  }));
  // the reflection cubemaps (env_cubemap_array): a cube array, depth x 6 faces per mip
  let cubemaps = null;
  const wantCubes = opts.reflections !== false || await fetch(`${mapBase}water/water.json`, { method: 'HEAD' }).then((r) => r.ok, () => false);
  const cm = wantCubes && json.cubemaps && (rawTexture(json.cubemaps, 'cubemaps.bin', renderer) || rgbmCubes(json.cubemaps));
  if (cm && json.cubemaps.cube) {
    const buf = await fetchBuffer(versioned(`${base}lighting/cubemaps.bin`, version)).catch(() => null);
    const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : 0);
    if (buf && buf.byteLength >= cm.total) cubemaps = { ...cm, data: new Uint8Array(buf), sh: shList(json.cubemaps.sh), skipped: int(json.cubemaps.skippedMips, 0, 15), levels: int(json.cubemaps.mipLevels, 1, 16) || cm.mips.length };
  }
  return {
    uvScale: scale, version, post, probes, skies, cubemaps, irradianceRange, base,
    lightmapVersion: Number.isInteger(json.lightmapVersion) ? json.lightmapVersion : 0,
    gameVersion: Number.isInteger(json.lightmapGameVersion) ? json.lightmapGameVersion : 0,
    textures,
  };
}

// a raw texture description (SkyBake.cs ExportRaw): format, size, mips with offsets; checked against the format's
// block size and the GPU's extensions. Returns { file, format (three), srgbOk, width, height, depth, mips, total }.
const RAW = {
  bc6h: [THREE.RGB_BPTC_UNSIGNED_Format, 16, 'EXT_texture_compression_bptc'],
  bc7: [THREE.RGBA_BPTC_Format, 16, 'EXT_texture_compression_bptc'],
  dxt1: [THREE.RGB_S3TC_DXT1_Format, 8, 'WEBGL_compressed_texture_s3tc'],
  dxt5: [THREE.RGBA_S3TC_DXT5_Format, 16, 'WEBGL_compressed_texture_s3tc'],
};
function rawTexture(d, file, renderer) {
  if (!d || typeof d !== 'object' || d.file !== file.split('/').pop() || !Object.hasOwn(RAW, d.format) || !Array.isArray(d.mips) || !d.mips.length) return null;
  const [format, block, ext] = RAW[d.format];
  if (!renderer.extensions.has(ext)) return null;
  const faces = (d.cube ? 6 : 1) * (Number.isInteger(d.depth) && d.depth >= 1 && d.depth <= 1024 ? d.depth : 1);
  const mips = [];
  let total = 0;
  for (const m of d.mips.slice(0, 16)) {
    const w = m?.width, h = m?.height;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096) return null;
    const bytes = Math.ceil(w / 4) * Math.ceil(h / 4) * block * faces;
    if (m.bytes !== bytes || m.offset !== total) return null;
    mips.push({ offset: total, bytes, width: w, height: h });
    total += bytes;
  }
  return { file, format, kind: d.format, srgbOk: d.format === 'dxt1' && renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb'), width: mips[0].width, height: mips[0].height, faces, mips, total };
}
// the low tier's cubemaps (lasers-bake --tiers): one level of RGBA8 RGBM faces, any GPU takes them
function rgbmCubes(d) {
  if (!d || d.format !== 'rgbm8' || d.file !== 'cubemaps.bin' || !d.cube || !Array.isArray(d.mips) || d.mips.length !== 1) return null;
  const faces = 6 * (Number.isInteger(d.depth) && d.depth >= 1 && d.depth <= 1024 ? d.depth : 1);
  const m = d.mips[0], w = m?.width, h = m?.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 256 || h > 256 || m.offset !== 0 || m.bytes !== w * h * 4 * faces) return null;
  const range = typeof d.range === 'number' && d.range > 0 && d.range <= 1024 ? d.range : 16;
  return { file: 'cubemaps.bin', format: null, kind: 'rgbm8', rgbm: range, width: w, height: h, faces, mips: [{ offset: 0, bytes: m.bytes, width: w, height: h }], total: m.bytes };
}
// CUBEMAP_RADIANCE_SH: 27 floats per cubemap (9 per colour channel)
function shList(sh) {
  if (!Array.isArray(sh)) return [];
  return sh.slice(0, 1024).map((v) => (Array.isArray(v) && v.length === 27 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v : null));
}

// a PNG, exactly as stored: no premultiply, no colour conversion, no flip (lightmap UVs index it as baked)
async function pngImage(url) {
  try {
    const blob = await (await fetch(url)).blob();
    return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
  } catch { return null; }
}
async function pngTexture(url) {
  const img = await pngImage(url);
  if (!img) return null;
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.premultiplyAlpha = false;
  tex.needsUpdate = true;
  return tex;
}
