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

export async function loadLightmaps(base, renderer, log = () => {}) {
  let json;
  try { json = await fetchJson(`${base}lighting/lighting.json`, FRESH); } catch { return null; } // not baked
  if (!json || typeof json !== 'object' || !json.textures) return null;
  const scale = Array.isArray(json.uvScale) && json.uvScale.length === 2 && json.uvScale.every((v) => typeof v === 'number' && v > 0 && v < 16) ? json.uvScale : [1, 1];
  const version = typeof json.version === 'string' && /^\d{1,20}$/.test(json.version) ? json.version : '';
  const specs = {};
  for (const name of NAMES) {
    const s = check(name, json.textures[name]);
    if (!s) continue;
    if (!renderer.extensions.has(s.ext)) { log(`lighting: this GPU can't take ${json.textures[name].format} (${s.ext}): fallback lighting`); return null; }
    specs[name] = s;
  }
  if (!specs.irradiance) return null;
  const textures = {};
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
  return {
    uvScale: scale, version, post, probes,
    lightmapVersion: Number.isInteger(json.lightmapVersion) ? json.lightmapVersion : 0,
    gameVersion: Number.isInteger(json.lightmapGameVersion) ? json.lightmapGameVersion : 0,
    textures,
  };
}
